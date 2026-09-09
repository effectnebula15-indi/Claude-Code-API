/**
 * OpenAI-compatible surface: /v1/models and /v1/chat/completions.
 *
 * This is the endpoint that makes the gateway useful with software you did not
 * write — anything that already speaks OpenAI (SDKs, Open WebUI, LibreChat,
 * n8n, Home Assistant) points at this URL and works.
 */
import { readJson, sendJson } from '../util/http.js';
import { SSEStream } from '../util/sse.js';
import { newId, sanitizeConversationId } from '../util/ids.js';
import { splitMessages, flattenTranscript, tailTurn, enforceLimits, BadRequest } from '../messages.js';

/**
 * @param {import('../engine.js').Engine} engine
 * @param {import('node:http').IncomingMessage} req
 * @param {any} body
 * @returns {string}
 */
export function conversationIdFrom(engine, req, body) {
  const header = req.headers['x-conversation-id'];
  const raw =
    (typeof header === 'string' && header) ||
    body.conversation_id ||
    body.session_id ||
    (engine.cfg.conversationFromUserField ? body.user : '') ||
    '';
  return sanitizeConversationId(raw);
}

/**
 * @param {import('../engine.js').Engine} engine
 * @returns {import('../server.js').Handler}
 */
export function listModels(engine) {
  return async (_req, res) => {
    const created = Math.floor(engine.metrics.startedAt / 1000);
    const data = [
      ...Object.values(engine.cfg.agents).map((a) => ({
        id: a.name,
        object: 'model',
        created,
        owned_by: 'claude-code-api',
        description: a.description || `Claude (${a.model}) as agent "${a.name}"`,
        claude_model: a.model,
        supports_images: a.allowImages,
      })),
      // Bare model aliases so a client can pick a model without knowing about
      // this gateway's agent concept.
      ...['opus', 'sonnet', 'haiku'].map((m) => ({
        id: m,
        object: 'model',
        created,
        owned_by: 'anthropic',
        description: `Default agent running the "${m}" model alias`,
      })),
    ];
    sendJson(res, 200, { object: 'list', data });
  };
}

/**
 * @param {import('../engine.js').Engine} engine
 * @returns {import('../server.js').Handler}
 */
export function chatCompletions(engine) {
  return async (req, res, ctx) => {
    const body = await readJson(req, engine.cfg.maxBodyBytes);
    const agent = engine.resolveAgent(body.model, ctx.key);
    const conversationId = conversationIdFrom(engine, req, body);

    const { system, body: messages } = splitMessages(body.messages);
    const blocks = enforceLimits(conversationId ? tailTurn(messages) : flattenTranscript(messages), {
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

    const id = newId('chatcmpl');
    const created = Math.floor(Date.now() / 1000);

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
        object: 'chat.completion',
        created,
        model: agent.name,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: result.text },
            logprobs: null,
            finish_reason: finishReason(result.stopReason),
          },
        ],
        usage: usageFor(result),
        // Non-standard, but the only way a client can keep the conversation
        // warm on the next call.
        conversation_id: conversationId || null,
        claude_session_id: result.sessionId,
      });
      return;
    }

    const sse = new SSEStream(res);
    let sentRole = false;
    try {
      const result = await engine.run({
        agent,
        blocks: /** @type {any} */ (finalBlocks),
        keyName: ctx.key.name,
        conversationId: conversationId || undefined,
        signal: ctx.signal,
        onDelta: (text) => {
          if (!sentRole) {
            sentRole = true;
            sse.send(chunk(id, created, agent.name, { role: 'assistant', content: '' }));
          }
          sse.send(chunk(id, created, agent.name, { content: text }));
        },
      });

      if (!sentRole) {
        // The CLI can deliver a whole short answer without partial events.
        sse.send(chunk(id, created, agent.name, { role: 'assistant', content: result.text }));
      }
      sse.send({
        id,
        object: 'chat.completion.chunk',
        created,
        model: agent.name,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason(result.stopReason) }],
        usage: usageFor(result),
        conversation_id: conversationId || null,
      });
      sse.done();
    } catch (err) {
      // Headers are already out, so the error has to travel inside the stream.
      const e = /** @type {any} */ (err);
      if (Number(e?.status) !== 499) {
        sse.send({ error: { message: String(e?.message || 'stream failed'), type: String(e?.code || 'internal_error') } });
        sse.done();
      }
    } finally {
      sse.close();
    }
  };
}

/** @param {string} id @param {number} created @param {string} model @param {any} delta */
function chunk(id, created, model, delta) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: null }],
  };
}

/** @param {import('../types.js').TurnResult} r */
function usageFor(r) {
  const prompt = r.usage.input + r.usage.cacheCreation + r.usage.cacheRead;
  return {
    prompt_tokens: prompt,
    completion_tokens: r.usage.output,
    total_tokens: prompt + r.usage.output,
    prompt_tokens_details: { cached_tokens: r.usage.cacheRead },
  };
}

/** @param {string} stopReason */
function finishReason(stopReason) {
  switch (stopReason) {
    case 'max_tokens': return 'length';
    case 'tool_use': return 'tool_calls';
    case 'refusal': return 'content_filter';
    default: return 'stop';
  }
}

export { BadRequest };
