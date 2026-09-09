/**
 * Operational endpoints: plan usage, conversation lifecycle, agent listing.
 */
import { sendJson, sendText } from '../util/http.js';
import { sanitizeConversationId } from '../util/ids.js';

/** @param {import('../engine.js').Engine} engine @returns {import('../server.js').Handler} */
export function usage(engine) {
  return async (_req, res) => sendJson(res, 200, engine.usage());
}

/** @param {import('../engine.js').Engine} engine @returns {import('../server.js').Handler} */
export function agents(engine) {
  return async (_req, res, ctx) => {
    const allowed = ctx.key.agents;
    const data = Object.values(engine.cfg.agents)
      .filter((a) => !allowed || allowed.includes(a.name))
      .map((a) => ({
        name: a.name,
        description: a.description,
        model: a.model,
        tools: a.tools,
        supports_images: a.allowImages,
        prewarm: a.prewarm,
      }));
    sendJson(res, 200, { object: 'list', data });
  };
}

/** @param {import('../engine.js').Engine} engine @returns {import('../server.js').Handler} */
export function listSessions(engine) {
  return async (_req, res, ctx) => {
    requireAdmin(ctx);
    sendJson(res, 200, { object: 'list', data: engine.sessions.list() });
  };
}

/**
 * Ends a conversation. The next request with the same id starts fresh, which is
 * what a "/reset" command in a support bot needs.
 *
 * @param {import('../engine.js').Engine} engine
 * @returns {import('../server.js').Handler}
 */
export function deleteSession(engine) {
  return async (_req, res, ctx) => {
    const id = sanitizeConversationId(ctx.params.id);
    const existed = engine.sessions.drop(id);
    sendJson(res, existed ? 200 : 404, { id, deleted: existed });
  };
}

/** @param {import('../engine.js').Engine} engine @returns {import('../server.js').Handler} */
export function metrics(engine) {
  return async (_req, res, ctx) => {
    if (!engine.cfg.publicMetrics) requireAdmin(ctx);
    const text = engine.metrics.render({
      gate: engine.gate,
      sessions: engine.sessions.stats(),
      rateLimit: engine.sessions.rateLimit,
    });
    sendText(res, 200, text, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
  };
}

/** @param {import('../server.js').RequestContext} ctx */
function requireAdmin(ctx) {
  if (ctx.key.admin) return;
  const err = new Error('admin key required');
  /** @type {any} */ (err).status = 403;
  /** @type {any} */ (err).code = 'forbidden';
  throw err;
}
