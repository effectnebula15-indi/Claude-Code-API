/**
 * Prometheus text-format metrics. Enough to answer the two questions an
 * operator actually has: "is it working?" and "how much of my plan is left?".
 */
export class Metrics {
  constructor() {
    this.startedAt = Date.now();
    this.requests = 0;
    /** @type {Map<string, number>} */
    this.byStatus = new Map();
    /** @type {Map<string, number>} */
    this.byAgent = new Map();
    /** @type {Map<string, number>} */
    this.byKey = new Map();
    this.turns = 0;
    this.turnErrors = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cacheReadTokens = 0;
    this.costUsd = 0;
    this.durationMsTotal = 0;
    this.rateLimited = 0;
    this.queueRejected = 0;
  }

  /** @param {number} status */
  request(status) {
    this.requests++;
    const bucket = `${Math.floor(status / 100)}xx`;
    this.byStatus.set(bucket, (this.byStatus.get(bucket) || 0) + 1);
  }

  /**
   * @param {string} agent
   * @param {string} keyName
   * @param {import('./types.js').TurnResult} result
   */
  turn(agent, keyName, result) {
    this.turns++;
    this.byAgent.set(agent, (this.byAgent.get(agent) || 0) + 1);
    this.byKey.set(keyName, (this.byKey.get(keyName) || 0) + 1);
    this.inputTokens += result.usage.input + result.usage.cacheCreation;
    this.outputTokens += result.usage.output;
    this.cacheReadTokens += result.usage.cacheRead;
    this.costUsd += result.costUsd;
    this.durationMsTotal += result.durationMs;
  }

  /**
   * @param {{gate:import('./queue.js').ConcurrencyGate, sessions:{conversations:number, alive:number, busy:number, warm:number}, rateLimit:import('./types.js').RateLimitSnapshot|null}} live
   */
  render(live) {
    /** @type {string[]} */
    const lines = [];
    const push = (/** @type {string} */ name, /** @type {string} */ type, /** @type {string} */ help, /** @type {[string,number][]} */ samples) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
      for (const [labels, value] of samples) lines.push(`${name}${labels}${' '}${value}`);
    };

    push('cca_uptime_seconds', 'gauge', 'Seconds since the gateway started.', [
      ['', Math.floor((Date.now() - this.startedAt) / 1000)],
    ]);
    push('cca_requests_total', 'counter', 'HTTP requests handled, by status class.', [
      ...[...this.byStatus.entries()].map((/** @type {[string,number]} */ e) => /** @type {[string,number]} */ ([`{class="${e[0]}"}`, e[1]])),
    ]);
    push('cca_turns_total', 'counter', 'Completed model turns, by agent.', [
      ...[...this.byAgent.entries()].map((/** @type {[string,number]} */ e) => /** @type {[string,number]} */ ([`{agent="${escapeLabel(e[0])}"}`, e[1]])),
    ]);
    push('cca_turns_by_key_total', 'counter', 'Completed model turns, by API key name.', [
      ...[...this.byKey.entries()].map((/** @type {[string,number]} */ e) => /** @type {[string,number]} */ ([`{key="${escapeLabel(e[0])}"}`, e[1]])),
    ]);
    push('cca_turn_errors_total', 'counter', 'Turns that ended in an error.', [['', this.turnErrors]]);
    push('cca_rate_limited_total', 'counter', 'Requests rejected by the gateway rate limiter.', [['', this.rateLimited]]);
    push('cca_queue_rejected_total', 'counter', 'Requests rejected because the queue was full.', [['', this.queueRejected]]);
    push('cca_tokens_total', 'counter', 'Token usage reported by the CLI.', [
      ['{kind="input"}', this.inputTokens],
      ['{kind="output"}', this.outputTokens],
      ['{kind="cache_read"}', this.cacheReadTokens],
    ]);
    push('cca_cost_usd_total', 'counter', 'List-price equivalent of the work done (not billed on a subscription).', [
      ['', round(this.costUsd, 6)],
    ]);
    push('cca_turn_duration_ms_total', 'counter', 'Summed turn latency in milliseconds.', [['', Math.round(this.durationMsTotal)]]);
    push('cca_inflight', 'gauge', 'Turns currently executing.', [['', live.gate.active]]);
    push('cca_queued', 'gauge', 'Requests waiting for a free slot.', [['', live.gate.queued]]);
    push('cca_conversations', 'gauge', 'Known conversations.', [['', live.sessions.conversations]]);
    push('cca_processes', 'gauge', 'Claude CLI processes.', [
      ['{state="alive"}', live.sessions.alive],
      ['{state="busy"}', live.sessions.busy],
      ['{state="warm"}', live.sessions.warm],
    ]);

    if (live.rateLimit) {
      const samples = Object.entries(live.rateLimit.windows).map(
        (/** @type {[string, {utilization:number}]} */ e) =>
          /** @type {[string,number]} */ ([`{window="${escapeLabel(e[0])}"}`, round(e[1].utilization, 4)]),
      );
      push('cca_subscription_utilization', 'gauge', 'Fraction of the Claude plan window consumed (0-1).', samples);
      const resets = Object.entries(live.rateLimit.windows)
        .filter((/** @type {[string, {resetsAt:number|null}]} */ e) => e[1].resetsAt)
        .map((/** @type {[string, {resetsAt:number|null}]} */ e) =>
          /** @type {[string,number]} */ ([`{window="${escapeLabel(e[0])}"}`, Number(e[1].resetsAt)]));
      if (resets.length) push('cca_subscription_resets_at', 'gauge', 'Unix time when each plan window resets.', resets);
    }
    return lines.join('\n') + '\n';
  }
}

/** @param {string} v */
function escapeLabel(v) {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

/** @param {number} n @param {number} digits */
function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
