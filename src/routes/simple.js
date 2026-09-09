/**
 * The endpoint for your own devices: one prompt in, one answer out.
 *
 * Built for constrained clients (smart glasses, an ESP32, a support bot) that
 * should not have to assemble an OpenAI message array or parse OpenAI's chunk
 * format. Streaming here is sentence-oriented, so a client can start speaking
 * the first sentence while the rest is still being written.
 */
import { readJson, sendJson } from '../util/http.js';
import { SSEStream } from '../util/sse.js';
import { sanitizeConversationId } from '../util/ids.js';
import { imageBlockFromUrl, enforceLimits, BadRequest } from '../messages.js';

/**
 * Streaming assistant text arrives token by token; speech synthesis wants whole
 * sentences. This buffers until a sentence boundary (or a long-enough clause)
 * so a wearable can start talking early without stuttering mid-word.
 */
export class SentenceSplitter {
  /** @param {{minChars?:number, maxChars?:number}} [opts] */
  constructor({ minChars = 24, maxChars = 240 } = {}) {
    this.buffer = '';
    this.minChars = minChars;
    this.maxChars = maxChars;
  }

  /**
   * @param {string} text
   * @returns {string[]} complete sentences ready to speak
   */
  push(text) {
    this.buffer += text;
    /** @type {string[]} */
    const out = [];
    for (;;) {
      const idx = this._boundary();
      if (idx === -1) break;
      const sentence = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx);
      if (sentence) out.push(sentence);
    }
    return out;
  }

  /** @returns {number} index just past a sentence end, or -1 */
  _boundary() {
    // A terminator only counts once there is enough text to be worth speaking,
    // which keeps "Dr." and "3.5" from being cut in half.
    const re = /[.!?…]["')\]]?\s|[\n]{2,}/g;
    let m;
    while ((m = re.exec(this.buffer)) !== null) {
      const end = m.index + m[0].length;
      if (end >= this.minChars) return end;
    }
    if (this.buffer.length >= this.maxChars) {
      const space = this.buffer.lastIndexOf(' ', this.maxChars);
      return space > this.minChars ? space + 1 : this.maxChars;
    }
    return -1;
  }

  /** @returns {string} whatever is left */
  flush() {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest;
  }
}

/**
 * @param {import('../engine.js').Engine} engine
 * @returns {import('../server.js').Handler}
 */
export function ask(engine) {
  return async (req, res, ctx) => {
    const body = await readJson(req, engine.cfg.maxBodyBytes);
    const prompt = typeof body.prompt === 'string' ? body.prompt : typeof body.text === 'string' ? body.text : '';
    if (!prompt && !body.image) throw new BadRequest('prompt is required', 'prompt');

    const agent = engine.resolveAgent(body.agent || body.model, ctx.key);
    const conversationId = sanitizeConversationId(
      body.conversation || body.conversation_id || body.session || req.headers['x-conversation-id'] || '',
    );

    /** @type {import('../types.js').ContentBlock[]} */
    const blocks = [];
    if (prompt) blocks.push({ type: 'text', text: prompt });
    for (const image of imagesFrom(body)) blocks.push(image);
    enforceLimits(blocks, {
      maxChars: engine.cfg.maxInputChars,
      maxImages: engine.cfg.maxImagesPerRequest,
      allowImages: agent.allowImages,
    });

    const wantsStream = body.stream === true || ctx.url.searchParams.get('stream') === '1';

    if (!wantsStream) {
      const result = await engine.run({
        agent,
        blocks,
        keyName: ctx.key.name,
        conversationId: conversationId || undefined,
        signal: ctx.signal,
      });
      sendJson(res, 200, {
        text: result.text,
        agent: agent.name,
        model: result.model,
        conversation: conversationId || null,
        ms: result.durationMs,
        usage: {
          input_tokens: result.usage.input + result.usage.cacheCreation,
          output_tokens: result.usage.output,
          cache_read_tokens: result.usage.cacheRead,
        },
      });
      return;
    }

    const sse = new SSEStream(res);
    const splitter = new SentenceSplitter();
    try {
      const result = await engine.run({
        agent,
        blocks,
        keyName: ctx.key.name,
        conversationId: conversationId || undefined,
        signal: ctx.signal,
        onDelta: (text) => {
          sse.send({ type: 'delta', text });
          for (const sentence of splitter.push(text)) sse.send({ type: 'sentence', text: sentence });
        },
      });
      const tail = splitter.flush();
      if (tail) sse.send({ type: 'sentence', text: tail });
      else if (!result.text.length) sse.send({ type: 'sentence', text: '' });
      sse.send({
        type: 'done',
        text: result.text,
        agent: agent.name,
        model: result.model,
        conversation: conversationId || null,
        ms: result.durationMs,
      });
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (Number(e?.status) !== 499) {
        sse.send({ type: 'error', message: String(e?.message || 'failed'), code: String(e?.code || 'internal_error') });
      }
    } finally {
      sse.close();
    }
  };
}

/**
 * @param {any} body
 * @returns {import('../types.js').ImageBlock[]}
 */
function imagesFrom(body) {
  const raw = body.images ?? body.image;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((item) => {
    if (typeof item !== 'string') throw new BadRequest('image must be a data: URL or a base64 string', 'image');
    if (item.startsWith('data:')) return imageBlockFromUrl(item);
    // Bare base64 from a camera: assume JPEG unless told otherwise.
    const mediaType = String(body.image_media_type || 'image/jpeg').toLowerCase();
    return imageBlockFromUrl(`data:${mediaType};base64,${item.replace(/\s+/g, '')}`);
  });
}
