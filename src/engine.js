/**
 * The request pipeline every endpoint shares:
 *
 *   plan-window guard -> concurrency gate -> conversation binding -> turn
 *
 * Endpoints differ only in how they parse the request and format the response.
 */
import crypto from 'node:crypto';
import { SessionManager } from './claude/manager.js';
import { TurnError } from './claude/process.js';
import { ConcurrencyGate } from './queue.js';
import { RateLimiter } from './ratelimit.js';
import { Authenticator } from './auth.js';
import { Metrics } from './metrics.js';
import { log } from './log.js';

export class Engine {
  /** @param {import('./config.js').Config} cfg */
  constructor(cfg) {
    this.cfg = cfg;
    this.sessions = new SessionManager(cfg);
    this.gate = new ConcurrencyGate({
      limit: cfg.maxConcurrency,
      queueMax: cfg.queueMax,
      timeoutMs: cfg.queueTimeoutMs,
    });
    this.limiter = new RateLimiter({ rpm: cfg.rateLimitRpm, daily: cfg.rateLimitDaily });
    this.auth = new Authenticator({
      keys: cfg.apiKeys,
      allowAnonymous: cfg.allowAnonymous,
      adminKey: cfg.adminKey,
    });
    this.metrics = new Metrics();
    /**
     * Live WebSocket connections. An upgraded socket is detached from
     * http.Server's own tracking, so neither close() nor closeAllConnections()
     * can end it — without this set a restart hangs until the device
     * disconnects on its own.
     *
     * @type {Set<{close:(code?:number, reason?:string)=>void}>}
     */
    this.wsConnections = new Set();
  }

  /**
   * Resolve the agent profile for a request.
   *
   * The OpenAI `model` field doubles as the agent selector, because that is the
   * only knob most third-party clients expose. Both `vpn-support` and
   * `agent:vpn-support` work; a bare model name (`sonnet`, `claude-opus-5`)
   * falls through to the default agent running that model.
   *
   * @param {string|undefined} requested
   * @param {import('./types.js').ApiKey} key
   * @returns {import('./types.js').Agent}
   */
  resolveAgent(requested, key) {
    const raw = String(requested || '').trim();
    const name = raw.startsWith('agent:') ? raw.slice(6) : raw;

    /** @type {import('./types.js').Agent} */
    let agent;
    if (name && this.cfg.agents[name]) {
      agent = this.cfg.agents[name];
    } else {
      agent = this.cfg.agents[this.cfg.defaultAgent];
      if (name && !raw.startsWith('agent:')) {
        // Treat the value as a model override on the default profile.
        agent = { ...agent, model: name };
      } else if (name) {
        throw new TurnError(`unknown agent "${name}"`, { code: 'unknown_agent', status: 404 });
      }
    }

    if (key.agents && !key.agents.includes(agent.name)) {
      throw new TurnError(`this API key may not use agent "${agent.name}"`, {
        code: 'agent_forbidden',
        status: 403,
      });
    }
    return agent;
  }

  /**
   * Whether a per-request system prompt should still be sent.
   *
   * The CLI fixes a conversation's system prompt when it starts, so a client
   * that resends `system` on every call (as the OpenAI and Anthropic SDKs do)
   * would otherwise repeat it into every turn of a stateful conversation —
   * wasted tokens, and a transcript full of duplicated instructions.
   *
   * @param {string} [conversationId]
   */
  isFreshConversation(conversationId) {
    if (!conversationId) return true;
    const existing = this.sessions.sessions.get(conversationId);
    return !existing || existing.turns === 0;
  }

  /**
   * Refuse work when the Claude plan window is effectively spent, so an
   * automated client cannot silently exhaust the subscription for the humans
   * who also depend on it.
   */
  checkPlanWindow() {
    const rl = this.sessions.rateLimit;
    if (!rl) return;
    if (rl.status === 'rejected' || rl.status === 'blocked') {
      throw new TurnError('Claude plan limit reached', {
        code: 'plan_limit_reached',
        status: 429,
        retryAfter: retryAfterFrom(rl.resetsAt),
      });
    }
    const five = rl.windows.five_hour;
    const week = rl.windows.seven_day;
    if (five && five.utilization >= this.cfg.usageGuard) {
      throw new TurnError(
        `Claude 5-hour window is ${(five.utilization * 100).toFixed(1)}% used (guard at ${(this.cfg.usageGuard * 100).toFixed(0)}%)`,
        { code: 'plan_window_guard', status: 429, retryAfter: retryAfterFrom(five.resetsAt) },
      );
    }
    if (week && week.utilization >= this.cfg.usageGuardWeekly) {
      throw new TurnError(
        `Claude weekly window is ${(week.utilization * 100).toFixed(1)}% used (guard at ${(this.cfg.usageGuardWeekly * 100).toFixed(0)}%)`,
        { code: 'plan_window_guard', status: 429, retryAfter: retryAfterFrom(week.resetsAt) },
      );
    }
  }

  /**
   * Execute one turn end to end.
   *
   * @param {Object} o
   * @param {import('./types.js').Agent} o.agent
   * @param {import('./types.js').ContentBlock[]} o.blocks
   * @param {string} o.keyName
   * @param {string} [o.conversationId] Omit for a stateless one-shot turn.
   * @param {(text:string)=>void} [o.onDelta]
   * @param {AbortSignal} [o.signal]
   * @returns {Promise<import('./types.js').TurnResult>}
   */
  async run({ agent, blocks, keyName, conversationId, onDelta, signal }) {
    this.checkPlanWindow();

    const ephemeral = !conversationId;
    const convId = conversationId || `oneshot:${crypto.randomUUID()}`;
    const release = await this.gate.acquire(signal);
    const startedAt = Date.now();

    try {
      let proc = await this.sessions.acquire({ conversationId: convId, agent });
      /** @type {import('./types.js').TurnResult} */
      let result;
      try {
        result = await proc.send(blocks, { onDelta, signal, timeoutMs: this.cfg.turnTimeoutMs });
      } catch (err) {
        const e = /** @type {TurnError} */ (err);
        // A process that died between acquire() and the first write is a race
        // we can absorb once: reattach to the same Claude session and retry.
        if (e.code === 'process_exited' || e.code === 'process_gone') {
          if (signal?.aborted) throw e;
          log.warn('retrying turn after process loss', { conversationId: convId, err: e.message });
          proc = await this.sessions.acquire({ conversationId: convId, agent });
          result = await proc.send(blocks, { onDelta, signal, timeoutMs: this.cfg.turnTimeoutMs });
        } else {
          throw e;
        }
      }

      this.sessions.recordTurn(convId);
      this.metrics.turn(agent.name, keyName, result);
      log.info('turn completed', {
        agent: agent.name,
        key: keyName,
        conversation: ephemeral ? 'oneshot' : convId,
        ms: Date.now() - startedAt,
        in: result.usage.input + result.usage.cacheCreation,
        out: result.usage.output,
        cached: result.usage.cacheRead,
      });

      if (agent.maxReplyChars > 0 && result.text.length > agent.maxReplyChars) {
        result.text = result.text.slice(0, agent.maxReplyChars);
      }
      return result;
    } catch (err) {
      this.metrics.turnErrors++;
      throw err;
    } finally {
      release();
      // One-shot conversations must not accumulate: drop the process as soon as
      // the answer is out.
      if (ephemeral) this.sessions.drop(convId);
    }
  }

  usage() {
    const rl = this.sessions.rateLimit;
    return {
      plan: rl
        ? {
            status: rl.status,
            observed_at: new Date(rl.observedAt).toISOString(),
            windows: Object.fromEntries(
              Object.entries(rl.windows).map(([k, v]) => [
                k,
                {
                  utilization: v.utilization,
                  resets_at: v.resetsAt ? new Date(v.resetsAt * 1000).toISOString() : null,
                },
              ]),
            ),
          }
        : null,
      gateway: {
        inflight: this.gate.active,
        queued: this.gate.queued,
        max_concurrency: this.gate.limit,
        turns: this.metrics.turns,
        turn_errors: this.metrics.turnErrors,
        tokens: {
          input: this.metrics.inputTokens,
          output: this.metrics.outputTokens,
          cache_read: this.metrics.cacheReadTokens,
        },
        // Not a bill — a subscription has no per-token charge. Useful only as a
        // "what would this have cost on the API" signal.
        equivalent_api_cost_usd: Math.round(this.metrics.costUsd * 1e6) / 1e6,
        sessions: this.sessions.stats(),
        uptime_seconds: Math.floor((Date.now() - this.metrics.startedAt) / 1000),
      },
    };
  }

  async stop() {
    for (const conn of this.wsConnections) {
      // 1001 "going away" tells a client this is a restart, not an error, so it
      // reconnects instead of backing off.
      try { conn.close(1001, 'server shutting down'); } catch { /* already gone */ }
    }
    this.wsConnections.clear();
    await this.sessions.stop();
  }
}

/** @param {number|null} resetsAt Unix seconds. */
function retryAfterFrom(resetsAt) {
  if (!resetsAt) return 300;
  return Math.max(1, Math.min(3600, Math.ceil(resetsAt - Date.now() / 1000)));
}
