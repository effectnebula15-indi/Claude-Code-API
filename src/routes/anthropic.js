/**
 * Anthropic-compatible surface: POST /v1/messages.
 *
 * Lets the official `anthropic` SDKs talk to the gateway with nothing but a
 * base_url change, which matters for code already written against Claude.
 */
import { readJson, sendJson } from '../util/http.js';
import { SSEStream } from '../util/sse.js';
import { newId } from '../util/ids.js';
import { splitMessages, flattenTranscript, tailTurn, enforceLimits } from '../messages.js';
import { conversationIdFrom } from './openai.js';

/**
 * @param {import('../engine.js').Engine} engine
 * @returns {import('../server.js').Handler}
 */
export function messages(engine) {
  return async (req, res, ctx) => {
    const body = await readJson(req, engine.cfg.maxBodyBytes);
    const agent = engine.resolveAgent(body.model, ctx.key);
    const conversationId = conversationIdFrom(engine, req, body);

    const { system, body: msgs } = splitMessages(body.messages, body.system);
    const blocks = enforceLimits(conversationId ? tailTurn(msgs) : flattenTranscript(msgs), {
      maxChars: engine.cfg.maxInputChars,
      maxImages: engine.cfg.maxImagesPerRequest,
      allowImages: agent.allowImages,
    });
    // A per-request system prompt cannot replace the agent's (the CLI fixes the
    // system prompt when a conversation starts), so it is prepended to the
    // opening turn instead — and only there, so a client that resends it every
    // call does not repeat it into a stateful conversation. Configure lasting
    // behaviour in config/agents.json.
    const finalBlocks =
      system && engine.isFreshConversation(conversationId)
        ? [{ type: 'text', text: `${system}\n\n---\n\n` }, ...blocks]
        : blocks;

    const id = newId('msg');

    if (!body.stream) {
      const result = await engine.run({
        agent,
        blocks: /** @type {any} */ (finalBlocks),
        keyName: ctx.key.name,
        conversationId: conversationId || undefined,
        signal: ctx.signal,
      });
      sendJson(res, 200, {
        id,
        type: 'message',
        role: 'assistant',
        model: result.model || agent.model,
        content: [{ type: 'text', text: result.text }],
        stop_reason: result.stopReason || 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: result.usage.input,
          output_tokens: result.usage.output,
          cache_read_input_tokens: result.usage.cacheRead,
          cache_creation_input_tokens: result.usage.cacheCreation,
        },
        conversation_id: conversationId || null,
      });
      return;
    }

    const sse = new SSEStream(res);
    const model = agent.model;
    let opened = false;
    let text = '';

    const openStream = () => {
      if (opened) return;
      opened = true;
      sse.send(
        {
          type: 'message_start',
          message: {
            id, type: 'message', role: 'assistant', model, content: [],
            stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
        'message_start',
      );
      sse.send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start');
    };

    try {
      const result = await engine.run({
        agent,
        blocks: /** @type {any} */ (finalBlocks),
        keyName: ctx.key.name,
        conversationId: conversationId || undefined,
        signal: ctx.signal,
        onDelta: (delta) => {
          openStream();
          text += delta;
          sse.send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } }, 'content_block_delta');
        },
      });

      openStream();
      if (!text && result.text) {
        sse.send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: result.text } }, 'content_block_delta');
      }
      sse.send({ type: 'content_block_stop', index: 0 }, 'content_block_stop');
      sse.send(
        {
          type: 'message_delta',
          delta: { stop_reason: result.stopReason || 'end_turn', stop_sequence: null },
          usage: { input_tokens: result.usage.input, output_tokens: result.usage.output },
        },
        'message_delta',
      );
      sse.send({ type: 'message_stop' }, 'message_stop');
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (Number(e?.status) !== 499) {
        sse.send(
          { type: 'error', error: { type: String(e?.code || 'api_error'), message: String(e?.message || 'stream failed') } },
          'error',
        );
      }
    } finally {
      sse.close();
    }
  };
}
