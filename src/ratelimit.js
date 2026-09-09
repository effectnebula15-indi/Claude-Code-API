/**
 * Per-key request limiting: a sliding-window-ish token bucket for burst control
 * plus an optional hard daily cap.
 *
 * In-memory on purpose. One gateway instance drives one subscription, so there
 * is nothing to share across replicas — and adding Redis would defeat the
 * "copy one file to a server and run it" goal.
 */
export class RateLimiter {
  /** @param {{rpm:number, daily:number}} defaults */
  constructor(defaults) {
    this.defaults = defaults;
    /** @type {Map<string, {tokens:number, updatedAt:number, day:string, used:number}>} */
    this.buckets = new Map();
  }

  /**
   * @param {string} id                       Usually the API key name.
   * @param {{rpm?:number|null, daily?:number|null}} [overrides]
   * @param {number} [now]
   * @returns {{ok:true}|{ok:false, reason:'rpm'|'daily', retryAfter:number}}
   */
  check(id, overrides = {}, now = Date.now()) {
    const rpm = overrides.rpm ?? this.defaults.rpm;
    const daily = overrides.daily ?? this.defaults.daily;
    const day = new Date(now).toISOString().slice(0, 10);

    let b = this.buckets.get(id);
    if (!b) {
      b = { tokens: rpm, updatedAt: now, day, used: 0 };
      this.buckets.set(id, b);
    }
    if (b.day !== day) {
      b.day = day;
      b.used = 0;
    }

    if (daily > 0 && b.used >= daily) {
      const midnight = Date.UTC(
        new Date(now).getUTCFullYear(),
        new Date(now).getUTCMonth(),
        new Date(now).getUTCDate() + 1,
      );
      return { ok: false, reason: 'daily', retryAfter: Math.ceil((midnight - now) / 1000) };
    }

    if (rpm > 0) {
      const refill = ((now - b.updatedAt) / 60_000) * rpm;
      b.tokens = Math.min(rpm, b.tokens + refill);
      b.updatedAt = now;
      if (b.tokens < 1) {
        const waitMs = ((1 - b.tokens) / rpm) * 60_000;
        return { ok: false, reason: 'rpm', retryAfter: Math.max(1, Math.ceil(waitMs / 1000)) };
      }
      b.tokens -= 1;
    }

    b.used += 1;
    return { ok: true };
  }

  /** @param {string} id */
  snapshot(id) {
    const b = this.buckets.get(id);
    return b ? { tokens: Math.floor(b.tokens), usedToday: b.used } : { tokens: this.defaults.rpm, usedToday: 0 };
  }
}
