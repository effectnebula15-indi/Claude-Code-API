/**
 * Server-Sent Events writer.
 *
 * Includes a heartbeat because the common deployment is behind nginx/Caddy on a
 * mobile link, where an idle connection is dropped long before a slow model
 * finishes thinking.
 */
export class SSEStream {
  /**
   * @param {import('node:http').ServerResponse} res
   * @param {{heartbeatMs?:number, headers?:Record<string,string>}} [opts]
   */
  constructor(res, opts = {}) {
    this.res = res;
    this.closed = false;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Tells nginx not to buffer the stream into uselessness.
      'x-accel-buffering': 'no',
      ...(opts.headers || {}),
    });
    res.flushHeaders?.();
    const heartbeatMs = opts.heartbeatMs ?? 15_000;
    if (heartbeatMs > 0) {
      this.heartbeat = setInterval(() => this.comment('ping'), heartbeatMs);
      this.heartbeat.unref?.();
    }
    res.on('close', () => this.close());
  }

  /** @param {string} text */
  comment(text) {
    if (this.closed) return;
    this.res.write(`: ${text}\n\n`);
  }

  /**
   * @param {any} data
   * @param {string} [event]
   */
  send(data, event) {
    if (this.closed) return;
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    let frame = '';
    if (event) frame += `event: ${event}\n`;
    frame += `data: ${payload}\n\n`;
    this.res.write(frame);
  }

  /** OpenAI's terminator; Anthropic streams do not use it. */
  done() {
    this.send('[DONE]');
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    try { this.res.end(); } catch { /* socket already gone */ }
  }
}
