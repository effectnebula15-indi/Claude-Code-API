/**
 * FIFO concurrency gate.
 *
 * A Claude subscription is one small shared resource. Running four turns at
 * once does not make them finish faster — it just makes every caller slow and
 * burns the plan window quicker. So the gateway admits `maxConcurrency` turns
 * and queues the rest, with a bounded wait so clients fail fast instead of
 * hanging when the server is oversubscribed.
 */
export class ConcurrencyGate {
  /** @param {{limit:number, queueMax:number, timeoutMs:number}} o */
  constructor({ limit, queueMax, timeoutMs }) {
    this.limit = Math.max(1, limit);
    this.queueMax = queueMax;
    this.timeoutMs = timeoutMs;
    this.active = 0;
    /** @type {{resolve:(v:()=>void)=>void, reject:(e:Error)=>void, timer:NodeJS.Timeout, signal?:AbortSignal, onAbort?:()=>void}[]} */
    this.waiters = [];
    this.totalQueued = 0;
    this.totalRejected = 0;
  }

  get queued() {
    return this.waiters.length;
  }

  /**
   * @param {AbortSignal} [signal]
   * @returns {Promise<() => void>} release function
   */
  acquire(signal) {
    if (signal?.aborted) return Promise.reject(abortError());

    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this._release());
    }
    if (this.waiters.length >= this.queueMax) {
      this.totalRejected++;
      const err = new Error('server is at capacity, try again shortly');
      /** @type {any} */ (err).status = 503;
      /** @type {any} */ (err).code = 'queue_full';
      /** @type {any} */ (err).retryAfter = 10;
      return Promise.reject(err);
    }

    this.totalQueued++;
    return new Promise((resolve, reject) => {
      /** @type {any} */
      const waiter = { resolve, reject };
      waiter.timer = setTimeout(() => {
        this._remove(waiter);
        const err = new Error(`waited ${this.timeoutMs}ms for a free slot`);
        /** @type {any} */ (err).status = 503;
        /** @type {any} */ (err).code = 'queue_timeout';
        /** @type {any} */ (err).retryAfter = 15;
        reject(err);
      }, this.timeoutMs);
      if (signal) {
        waiter.signal = signal;
        waiter.onAbort = () => { this._remove(waiter); reject(abortError()); };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  _release() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const next = this.waiters.shift();
      if (!next) return;
      clearTimeout(next.timer);
      if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
      this.active++;
      next.resolve(this._release());
    };
  }

  /** @param {any} waiter */
  _remove(waiter) {
    const i = this.waiters.indexOf(waiter);
    if (i !== -1) this.waiters.splice(i, 1);
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
  }
}

function abortError() {
  const err = new Error('client disconnected');
  /** @type {any} */ (err).status = 499;
  /** @type {any} */ (err).code = 'client_aborted';
  return err;
}
