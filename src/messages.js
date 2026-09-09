/**
 * Translation between the OpenAI / Anthropic wire formats and the content
 * blocks the Claude CLI accepts on stdin.
 *
 * Two conversation modes:
 *
 *  - stateless (default): the client sends the whole history every request, so
 *    the transcript is flattened into a single labelled prompt and run in a
 *    throwaway conversation. Any OpenAI-compatible client works unmodified.
 *  - stateful: the client passes a conversation id and only the newest turn is
 *    forwarded; Claude itself holds the history. Cheaper, faster, and the mode
 *    to use for wearables and chat bots.
 */

export class BadRequest extends Error {
  /** @param {string} message @param {string} [param] */
  constructor(message, param) {
    super(message);
    this.name = 'BadRequest';
    this.status = 400;
    this.code = 'invalid_request_error';
    this.param = param;
  }
}

const DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i;
const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * @param {string} url
 * @returns {import('./types.js').ImageBlock}
 */
export function imageBlockFromUrl(url) {
  const m = DATA_URL.exec(String(url).trim());
  if (!m) {
    throw new BadRequest(
      'Only base64 data: URLs are accepted for images (data:image/jpeg;base64,...). ' +
        'The gateway does not fetch remote URLs on your behalf.',
      'image_url',
    );
  }
  const mediaType = m[1].toLowerCase();
  if (!SUPPORTED_IMAGE_TYPES.has(mediaType)) {
    throw new BadRequest(`Unsupported image type ${mediaType}`, 'image_url');
  }
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: m[2].replace(/\s+/g, '') } };
}

/**
 * Normalise one message's `content` (string or parts array) into blocks.
 *
 * @param {any} content
 * @returns {import('./types.js').ContentBlock[]}
 */
export function toBlocks(content) {
  if (content == null) return [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) throw new BadRequest('message content must be a string or an array of parts', 'content');

  /** @type {import('./types.js').ContentBlock[]} */
  const blocks = [];
  for (const part of content) {
    if (typeof part === 'string') {
      if (part) blocks.push({ type: 'text', text: part });
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    switch (part.type) {
      case 'text':
      case 'input_text':
        if (part.text) blocks.push({ type: 'text', text: String(part.text) });
        break;
      case 'image_url':
        blocks.push(imageBlockFromUrl(part.image_url?.url ?? part.image_url));
        break;
      case 'input_image':
        blocks.push(imageBlockFromUrl(part.image_url ?? part.image?.url ?? ''));
        break;
      case 'image': {
        const src = part.source || {};
        if (src.type === 'base64') {
          const mediaType = String(src.media_type || '').toLowerCase();
          if (!SUPPORTED_IMAGE_TYPES.has(mediaType)) throw new BadRequest(`Unsupported image type ${mediaType}`, 'image');
          blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: String(src.data || '') } });
        } else if (src.type === 'url') {
          blocks.push(imageBlockFromUrl(src.url));
        } else {
          throw new BadRequest('image source must be base64 or a data: URL', 'image');
        }
        break;
      }
      // Tool results and other block types have no meaning here: this gateway
      // exposes Claude as a chat model, not as a tool-calling backend.
      default:
        break;
    }
  }
  return blocks;
}

/** @param {import('./types.js').ContentBlock[]} blocks */
export function blocksToText(blocks) {
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => /** @type {import('./types.js').TextBlock} */ (b).text)
    .join('\n');
}

/**
 * Split incoming messages into a system prompt and the conversation body.
 *
 * @param {any[]} messages
 * @param {any} [topLevelSystem] Anthropic puts `system` outside `messages`.
 */
export function splitMessages(messages, topLevelSystem) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new BadRequest('messages must be a non-empty array', 'messages');
  }
  /** @type {string[]} */
  const system = [];
  if (topLevelSystem) {
    const t = blocksToText(toBlocks(topLevelSystem));
    if (t) system.push(t);
  }
  /** @type {{role:string, blocks:import('./types.js').ContentBlock[]}[]} */
  const body = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') throw new BadRequest('each message must be an object', 'messages');
    const role = String(m.role || '');
    if (role === 'system' || role === 'developer') {
      const t = blocksToText(toBlocks(m.content));
      if (t) system.push(t);
      continue;
    }
    if (role !== 'user' && role !== 'assistant') {
      throw new BadRequest(`unsupported message role ${JSON.stringify(role)}`, 'messages');
    }
    const blocks = toBlocks(m.content);
    if (blocks.length) body.push({ role, blocks });
  }
  if (!body.length) throw new BadRequest('no user or assistant messages found', 'messages');
  return { system: system.join('\n\n'), body };
}

/**
 * Stateless mode: render the whole transcript as one prompt.
 *
 * Images are kept as real image blocks (they cannot be flattened into text) and
 * appended after the transcript, which is where the model expects the "current"
 * attachment to be.
 *
 * @param {{role:string, blocks:import('./types.js').ContentBlock[]}[]} body
 * @returns {import('./types.js').ContentBlock[]}
 */
export function flattenTranscript(body) {
  if (body.length === 1 && body[0].role === 'user') return body[0].blocks;

  /** @type {import('./types.js').ImageBlock[]} */
  const images = [];
  const lines = [];
  for (const m of body) {
    for (const b of m.blocks) if (b.type === 'image') images.push(b);
    const text = blocksToText(m.blocks);
    if (!text) continue;
    lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${text}`);
  }
  const last = body[body.length - 1];
  const transcript =
    last.role === 'user'
      ? `${lines.join('\n\n')}\n\nAssistant:`
      : `${lines.join('\n\n')}\n\n(Continue the conversation as Assistant.)`;

  return [{ type: 'text', text: transcript }, ...images];
}

/**
 * Stateful mode: forward only what the model has not seen — everything after
 * the last assistant turn.
 *
 * @param {{role:string, blocks:import('./types.js').ContentBlock[]}[]} body
 * @returns {import('./types.js').ContentBlock[]}
 */
export function tailTurn(body) {
  if (body[body.length - 1].role !== 'user') {
    // The client ended on an assistant message, so there is no new user input:
    // nudge the model to keep going rather than replaying an old turn.
    return [{ type: 'text', text: 'Continue.' }];
  }
  let start = body.length - 1;
  while (start > 0 && body[start - 1].role === 'user') start--;
  return body.slice(start).flatMap((m) => m.blocks);
}

/**
 * @param {import('./types.js').ContentBlock[]} blocks
 * @param {{maxChars:number, maxImages:number, allowImages:boolean}} limits
 */
export function enforceLimits(blocks, { maxChars, maxImages, allowImages }) {
  let chars = 0;
  let images = 0;
  for (const b of blocks) {
    if (b.type === 'text') chars += b.text.length;
    else images++;
  }
  if (maxChars > 0 && chars > maxChars) {
    throw new BadRequest(`prompt is ${chars} characters, limit is ${maxChars}`, 'messages');
  }
  if (!allowImages && images > 0) {
    throw new BadRequest('this agent does not accept images', 'messages');
  }
  if (images > maxImages) {
    throw new BadRequest(`too many images: ${images}, limit is ${maxImages}`, 'messages');
  }
  return blocks;
}
