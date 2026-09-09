/**
 * A single `claude` CLI child process, driven over stream-json on stdin/stdout.
 *
 * One process holds one conversation. Because the CLI keeps reading stdin after
 * emitting a `result`, a warm process serves every follow-up turn without
 * paying the ~1-2s startup cost again — which is what makes the gateway usable
 * for latency-sensitive clients like wearables.
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { buildArgs } from './args.js';
import { log } from '../log.js';

export class TurnError extends Error {
  /** @param {string} message @param {{code?:string, status?:number, retryAfter?:number}} [opts] */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'TurnError';
    this.code = opts.code || 'turn_failed';
    this.status = opts.status || 502;
    this.retryAfter = opts.retryAfter;
  }
}

export class ClaudeProcess extends EventEmitter {
  /**
   * @param {Object} o
   * @param {string} o.bin
   * @param {import('../types.js').Agent} o.agent
   * @param {string} o.sessionId
   * @param {string} o.cwd
   * @param {boolean} [o.resume]
   * @param {number} [o.startupTimeoutMs]
   * @param {number} [o.settleMs]     How long to watch for an immediate crash.
   * @param {NodeJS.ProcessEnv} [o.env]
   */
  constructor({ bin, agent, sessionId, cwd, resume = false, startupTimeoutMs = 60_000, settleMs = 2000, env }) {
    super();
    this.bin = bin;
    this.agent = agent;
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.resume = resume;
    this.startupTimeoutMs = startupTimeoutMs;
    this.settleMs = settleMs;
    this.env = env || process.env;

    /** @type {import('node:child_process').ChildProcessWithoutNullStreams|null} */
    this.child = null;
    this.ready = false;
    this.busy = false;
    this.turns = 0;
    this.lastUsedAt = Date.now();
    this.startedAt = 0;
    /** Model the CLI actually reported at init — may differ from the request. */
    this.model = agent.model;
    /** @type {string} */
    this.stderrTail = '';
    /** True once the CLI has emitted system:init, which it only does after the first turn's input. */
    this.initialized = false;
    /** True once anything at all has come back on stdout. */
    this.sawOutput = false;
    /** @type {((r:any)=>void)|null} */
    this._onTurnEvent = null;
    this._closing = false;
    this._exited = false;
  }

  /**
   * Spawn the CLI and resolve once the process is up and running.
   *
   * Deliberately NOT "once it reports system:init": with
   * `--input-format stream-json` the CLI emits `system:init` only after it has
   * read the first user message, so waiting for it here would deadlock — we
   * would be waiting for output that only our own input can trigger. Instead we
   * resolve on the first sign of life (any stdout line, which the CLI produces
   * about half a second in) or after a short settle window, and let the first
   * turn surface any failure.
   */
  async start() {
    const args = buildArgs({ agent: this.agent, sessionId: this.sessionId, resume: this.resume });
    log.debug('spawning claude', { sessionId: this.sessionId, agent: this.agent.name, resume: this.resume });

    const child = spawn(this.bin, args, {
      cwd: this.cwd,
      env: {
        ...this.env,
        // The CLI otherwise tries to render progress UI when it detects a TTY.
        CI: '1',
        TERM: 'dumb',
        NO_COLOR: '1',
        // Never let a nested run inherit this gateway's own session wiring.
        CLAUDE_CODE_ENTRYPOINT: 'sdk-cli',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.startedAt = Date.now();

    child.stdin.on('error', (err) => {
      // EPIPE when the CLI exits first; the turn's own error path reports it.
      log.debug('claude stdin error', { sessionId: this.sessionId, err });
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!this.sawOutput) {
        this.sawOutput = true;
        this.emit('alive');
      }
      this._onLine(line);
    });

    child.on('exit', (code, signal) => {
      this._exited = true;
      this.ready = false;
      log.debug('claude exited', { sessionId: this.sessionId, code, signal });
      this.emit('exit', { code, signal, stderr: this.stderrTail });
    });
    child.on('error', (err) => {
      this._exited = true;
      this.ready = false;
      this.emit('exit', { code: null, signal: null, stderr: String(err && err.message) });
    });

    await new Promise((resolve, reject) => {
      // A process that is alive but silent is still usable: the settle window
      // only has to be long enough to catch an immediate crash (bad flags, a
      // missing binary, a refused login).
      const settleMs = Math.min(this.settleMs, this.startupTimeoutMs);
      const timer = setTimeout(() => { cleanup(); resolve(undefined); }, settleMs);

      const onAlive = () => { cleanup(); resolve(undefined); };
      const onExit = (/** @type {any} */ info) => {
        cleanup();
        reject(startupError(info, this.bin));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off('alive', onAlive);
        this.off('exit', onExit);
      };
      this.once('alive', onAlive);
      this.once('exit', onExit);
    });

    this.ready = true;
  }

  /** @param {string} line */
  _onLine(line) {
    if (!line) return;
    /** @type {any} */
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log.debug('unparsable line from claude', { sessionId: this.sessionId, sample: line.slice(0, 200) });
      return;
    }

    if (msg.type === 'system' && msg.subtype === 'init') {
      this.initialized = true;
      if (msg.model) this.model = msg.model;
      // The CLI is authoritative about the session id (it may normalise ours).
      if (msg.session_id) this.sessionId = msg.session_id;
      this.emit('init', msg);
      return;
    }

    // Subscription window telemetry — the gateway's only view of how much of
    // the plan is left. Surfaced on /v1/usage and /metrics.
    if (msg.type === 'rate_limit_event' && msg.rate_limit_info) {
      this.emit('rate_limit', msg.rate_limit_info);
      return;
    }

    if (this._onTurnEvent) this._onTurnEvent(msg);
  }

  /**
   * Run one turn.
   *
   * @param {import('../types.js').ContentBlock[]} content
   * @param {Object} [opts]
   * @param {(text:string)=>void} [opts.onDelta]     Text deltas as they arrive.
   * @param {(name:string)=>void} [opts.onToolUse]
   * @param {AbortSignal} [opts.signal]
   * @param {number} [opts.timeoutMs]
   * @returns {Promise<import('../types.js').TurnResult>}
   */
  async send(content, opts = {}) {
    if (this.busy) throw new TurnError('conversation is already handling a turn', { code: 'conversation_busy', status: 409 });
    if (!this.child || this._exited) throw new TurnError('claude process is not running', { code: 'process_gone', status: 503 });

    this.busy = true;
    this.lastUsedAt = Date.now();
    const child = this.child;
    const startedAt = Date.now();
    let text = '';

    try {
      return await new Promise((resolve, reject) => {
        const timeoutMs = opts.timeoutMs || 300_000;
        let settled = false;

        const finish = (/** @type {(v:any)=>void} */ fn, /** @type {any} */ value) => {
          if (settled) return;
          settled = true;
          cleanup();
          fn(value);
        };

        const timer = setTimeout(() => {
          finish(reject, new TurnError(`turn exceeded ${timeoutMs}ms`, { code: 'turn_timeout', status: 504 }));
          // The CLI cannot be interrupted mid-turn from here; drop the process
          // and let the session layer resume the conversation on the next call.
          this.kill();
        }, timeoutMs);

        const onAbort = () => {
          finish(reject, new TurnError('client disconnected', { code: 'client_aborted', status: 499 }));
          this.kill();
        };
        const onExit = (/** @type {any} */ info) => {
          // Dying before the first system:init means the CLI never really came
          // up — usually a bad login or a missing binary. Report that, not a
          // vague "exited mid-turn".
          finish(
            reject,
            this.initialized
              ? new TurnError(
                  `claude exited mid-turn (code ${info.code}${info.signal ? `, signal ${info.signal}` : ''})` +
                    (info.stderr ? `: ${String(info.stderr).trim().slice(-500)}` : ''),
                  { code: 'process_exited', status: 502 },
                )
              : startupError(info, this.bin),
          );
        };

        const cleanup = () => {
          clearTimeout(timer);
          this._onTurnEvent = null;
          this.off('exit', onExit);
          if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
        };

        if (opts.signal) {
          if (opts.signal.aborted) { this.busy = false; cleanup(); return reject(new TurnError('client disconnected', { code: 'client_aborted', status: 499 })); }
          opts.signal.addEventListener('abort', onAbort, { once: true });
        }
        this.once('exit', onExit);

        this._onTurnEvent = (msg) => {
          switch (msg.type) {
            case 'stream_event': {
              const ev = msg.event;
              if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
                text += ev.delta.text;
                opts.onDelta?.(ev.delta.text);
              } else if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
                opts.onToolUse?.(String(ev.content_block.name || 'tool'));
              }
              break;
            }
            case 'result': {
              this.turns += 1;
              this.lastUsedAt = Date.now();
              if (msg.session_id) this.sessionId = msg.session_id;
              if (msg.is_error) {
                finish(reject, resultError(msg));
                return;
              }
              const u = msg.usage || {};
              finish(resolve, {
                // `result` carries the authoritative final text; deltas are only
                // a preview and can be empty when the CLI batches output.
                text: typeof msg.result === 'string' && msg.result.length ? msg.result : text,
                sessionId: this.sessionId,
                stopReason: msg.stop_reason || 'end_turn',
                usage: {
                  input: u.input_tokens || 0,
                  output: u.output_tokens || 0,
                  cacheRead: u.cache_read_input_tokens || 0,
                  cacheCreation: u.cache_creation_input_tokens || 0,
                },
                costUsd: msg.total_cost_usd || 0,
                durationMs: Date.now() - startedAt,
                model: this.model,
              });
              break;
            }
            default:
              break;
          }
        };

        const payload = JSON.stringify({
          type: 'user',
          message: { role: 'user', content },
        });
        child.stdin.write(payload + '\n', (err) => {
          if (err) finish(reject, new TurnError(`failed to write to claude: ${err.message}`, { code: 'write_failed', status: 502 }));
        });
      });
    } finally {
      this.busy = false;
      this.lastUsedAt = Date.now();
    }
  }

  /** Close stdin so the CLI shuts down cleanly, then hard-kill if it lingers. */
  async close(graceMs = 3000) {
    if (this._closing) return;
    this._closing = true;
    const child = this.child;
    if (!child || this._exited) return;
    try { child.stdin.end(); } catch { /* already gone */ }
    await new Promise((resolve) => {
      const timer = setTimeout(() => { this.kill(); resolve(undefined); }, graceMs);
      child.once('exit', () => { clearTimeout(timer); resolve(undefined); });
    });
  }

  kill() {
    const child = this.child;
    if (!child || this._exited) return;
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/** @param {any} info @param {string} bin */
function startupError(info, bin) {
  const stderr = String(info.stderr || '').trim();
  if (/ENOENT/.test(stderr) || info.code === 127) {
    return new TurnError(
      `claude CLI not found (tried "${bin}"). Install it with: npm i -g @anthropic-ai/claude-code`,
      { code: 'cli_missing', status: 500 },
    );
  }
  if (/not logged in|Invalid API key|OAuth|authentication/i.test(stderr)) {
    return new TurnError(
      `claude CLI is not authenticated. Run "claude setup-token" and set CLAUDE_CODE_OAUTH_TOKEN. Details: ${stderr.slice(-500)}`,
      { code: 'not_authenticated', status: 500 },
    );
  }
  return new TurnError(
    `claude exited during startup (code ${info.code})${stderr ? `: ${stderr.slice(-500)}` : ''}`,
    { code: 'startup_failed', status: 502 },
  );
}

/** @param {any} msg */
function resultError(msg) {
  const status = msg.api_error_status;
  const detail = typeof msg.result === 'string' ? msg.result : msg.subtype || 'unknown error';
  if (status === 429 || /rate.?limit|usage limit/i.test(String(detail))) {
    return new TurnError(`upstream rate limit: ${detail}`, { code: 'upstream_rate_limited', status: 429, retryAfter: 60 });
  }
  if (msg.subtype === 'error_max_turns') {
    return new TurnError('conversation hit its max turn limit', { code: 'max_turns', status: 400 });
  }
  return new TurnError(String(detail).slice(0, 800), { code: msg.subtype || 'turn_failed', status: status && status >= 400 ? status : 502 });
}
