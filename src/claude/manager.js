/**
 * Owns every `claude` child process: warm spares, conversation binding, idle
 * eviction and crash recovery.
 *
 * Conversations are addressed by a caller-chosen id. The Claude session id we
 * assign to each one is persisted to disk, so a gateway restart (or a process
 * that died mid-flight) resumes the same conversation with `--resume` instead
 * of losing the user's context.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ClaudeProcess, TurnError } from './process.js';
import { log } from '../log.js';

export class SessionManager {
  /** @param {import('../config.js').Config} cfg */
  constructor(cfg) {
    this.cfg = cfg;
    /** @type {Map<string, {proc:ClaudeProcess|null, agent:string, claudeSessionId:string, createdAt:number, lastUsedAt:number, turns:number}>} */
    this.sessions = new Map();
    /** @type {Map<string, ClaudeProcess[]>} */
    this.warm = new Map();
    /** @type {Map<string, number>} */
    this.warming = new Map();
    /** @type {import('../types.js').RateLimitSnapshot|null} */
    this.rateLimit = null;
    this.storePath = path.join(cfg.dataDir, 'sessions.json');
    this._saveTimer = null;
    this._stopped = false;

    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.mkdirSync(cfg.workdir, { recursive: true });
    this._load();

    this._sweeper = setInterval(() => this._sweep(), 30_000);
    this._sweeper.unref?.();
  }

  /** Spawn the configured warm spares. Failures are logged, never fatal. */
  async prewarmAll() {
    for (const agent of Object.values(this.cfg.agents)) {
      for (let i = 0; i < agent.prewarm; i++) {
        await this._addWarm(agent).catch((/** @type {any} */ err) =>
          log.warn('prewarm failed', { agent: agent.name, err: String(err?.message || err) }),
        );
      }
    }
  }

  /**
   * Get (or create) the process bound to a conversation.
   *
   * @param {Object} o
   * @param {string} o.conversationId
   * @param {import('../types.js').Agent} o.agent
   * @returns {Promise<ClaudeProcess>}
   */
  async acquire({ conversationId, agent }) {
    const existing = this.sessions.get(conversationId);

    if (existing) {
      if (existing.agent !== agent.name) {
        throw new TurnError(
          `conversation ${conversationId} belongs to agent "${existing.agent}", not "${agent.name}"`,
          { code: 'agent_mismatch', status: 409 },
        );
      }
      if (existing.proc && existing.proc.ready && !existing.proc._exited) {
        existing.lastUsedAt = Date.now();
        return existing.proc;
      }
      // The conversation exists on disk but its process is gone (restart, crash,
      // idle eviction, aborted turn). Reattach to the same Claude session.
      const proc = new ClaudeProcess({
        bin: this.cfg.claudeBin,
        agent,
        sessionId: existing.claudeSessionId,
        cwd: agent.workdir || this.cfg.workdir,
        resume: true,
        startupTimeoutMs: this.cfg.startupTimeoutMs,
      });
      this._wire(proc, conversationId);
      try {
        await proc.start();
      } catch (err) {
        // A resume can fail if the transcript was pruned on disk; start clean
        // rather than leaving the caller with a dead conversation.
        log.warn('resume failed, starting a fresh conversation', {
          conversationId,
          err: String(/** @type {any} */ (err)?.message || err),
        });
        this.sessions.delete(conversationId);
        return this.acquire({ conversationId, agent });
      }
      existing.proc = proc;
      existing.claudeSessionId = proc.sessionId;
      existing.lastUsedAt = Date.now();
      this._scheduleSave();
      return proc;
    }

    this._evictIfFull();

    const proc = (await this._takeWarm(agent)) || (await this._spawn(agent));
    this._wire(proc, conversationId);
    this.sessions.set(conversationId, {
      proc,
      agent: agent.name,
      claudeSessionId: proc.sessionId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      turns: 0,
    });
    this._scheduleSave();
    this._replenish(agent);
    return proc;
  }

  /**
   * Mark a completed turn against a conversation.
   *
   * @param {string} conversationId
   */
  recordTurn(conversationId) {
    const s = this.sessions.get(conversationId);
    if (!s) return;
    s.turns += 1;
    s.lastUsedAt = Date.now();
    this._scheduleSave();
    if (this.cfg.sessionMaxTurns > 0 && s.turns >= this.cfg.sessionMaxTurns) {
      log.info('conversation hit max turns, closing', { conversationId, turns: s.turns });
      this.drop(conversationId);
    }
  }

  /**
   * Close a conversation's process and forget it entirely.
   *
   * @param {string} conversationId
   */
  drop(conversationId) {
    const s = this.sessions.get(conversationId);
    if (!s) return false;
    this.sessions.delete(conversationId);
    s.proc?.close().catch(() => {});
    this._scheduleSave();
    return true;
  }

  /**
   * Keep the conversation id but start a brand new Claude session under it.
   *
   * @param {string} conversationId
   */
  reset(conversationId) {
    const existed = this.drop(conversationId);
    return existed;
  }

  list() {
    return [...this.sessions.entries()].map(([id, s]) => ({
      id,
      agent: s.agent,
      claude_session_id: s.claudeSessionId,
      alive: Boolean(s.proc && s.proc.ready && !s.proc._exited),
      busy: Boolean(s.proc?.busy),
      turns: s.turns,
      created_at: new Date(s.createdAt).toISOString(),
      last_used_at: new Date(s.lastUsedAt).toISOString(),
    }));
  }

  stats() {
    let alive = 0;
    let busy = 0;
    for (const s of this.sessions.values()) {
      if (s.proc && s.proc.ready && !s.proc._exited) alive++;
      if (s.proc?.busy) busy++;
    }
    let warm = 0;
    for (const arr of this.warm.values()) warm += arr.length;
    return { conversations: this.sessions.size, alive, busy, warm };
  }

  async stop() {
    this._stopped = true;
    clearInterval(this._sweeper);
    this._flushSave();
    /** @type {Promise<any>[]} */
    const closing = [];
    for (const s of this.sessions.values()) if (s.proc) closing.push(s.proc.close(1500));
    for (const arr of this.warm.values()) for (const p of arr) closing.push(p.close(1500));
    this.warm.clear();
    await Promise.allSettled(closing);
  }

  // ---------------------------------------------------------------- internals

  /** @param {import('../types.js').Agent} agent */
  async _spawn(agent) {
    const proc = new ClaudeProcess({
      bin: this.cfg.claudeBin,
      agent,
      sessionId: crypto.randomUUID(),
      cwd: agent.workdir || this.cfg.workdir,
      startupTimeoutMs: this.cfg.startupTimeoutMs,
    });
    proc.on('rate_limit', (info) => this._onRateLimit(info));
    await proc.start();
    return proc;
  }

  /** @param {import('../types.js').Agent} agent */
  async _addWarm(agent) {
    const arr = this.warm.get(agent.name) || [];
    if (arr.length >= agent.prewarm) return;
    const proc = await this._spawn(agent);
    if (this._stopped) return proc.close();
    // A spare that dies while idle must not be handed out later.
    proc.once('exit', () => {
      const list = this.warm.get(agent.name);
      if (!list) return;
      const i = list.indexOf(proc);
      if (i !== -1) list.splice(i, 1);
    });
    arr.push(proc);
    this.warm.set(agent.name, arr);
    log.debug('warm spare ready', { agent: agent.name, count: arr.length });
  }

  /** @param {import('../types.js').Agent} agent */
  async _takeWarm(agent) {
    const arr = this.warm.get(agent.name);
    while (arr && arr.length) {
      const proc = arr.shift();
      if (proc && proc.ready && !proc._exited) return proc;
    }
    return null;
  }

  /**
   * Refill spares in the background; never blocks a request.
   *
   * @param {import('../types.js').Agent} agent
   */
  _replenish(agent) {
    if (this._stopped || agent.prewarm <= 0) return;
    const inFlight = this.warming.get(agent.name) || 0;
    const have = (this.warm.get(agent.name) || []).length;
    if (have + inFlight >= agent.prewarm) return;
    this.warming.set(agent.name, inFlight + 1);
    this._addWarm(agent)
      .catch((/** @type {any} */ err) => log.warn('prewarm failed', { agent: agent.name, err: String(err?.message || err) }))
      .finally(() => this.warming.set(agent.name, Math.max(0, (this.warming.get(agent.name) || 1) - 1)));
  }

  /** @param {ClaudeProcess} proc @param {string} conversationId */
  _wire(proc, conversationId) {
    proc.removeAllListeners('rate_limit');
    proc.on('rate_limit', (info) => this._onRateLimit(info));
    proc.once('exit', () => {
      const s = this.sessions.get(conversationId);
      // Keep the on-disk mapping: the next request resumes rather than
      // silently starting a new conversation.
      if (s && s.proc === proc) s.proc = null;
    });
  }

  /** @param {any} info */
  _onRateLimit(info) {
    /** @type {Record<string, {utilization:number, resetsAt:number|null}>} */
    const windows = {};
    for (const [name, w] of Object.entries(info.unifiedWindows || {})) {
      const win = /** @type {any} */ (w);
      windows[name] = {
        utilization: Number(win.utilization) || 0,
        resetsAt: Number.isFinite(win.resetsAt) ? win.resetsAt : null,
      };
    }
    this.rateLimit = {
      status: String(info.status || 'unknown'),
      resetsAt: Number.isFinite(info.resetsAt) ? info.resetsAt : null,
      windows,
      observedAt: Date.now(),
    };
  }

  _evictIfFull() {
    while (this.sessions.size >= this.cfg.maxSessions) {
      /** @type {[string, any]|null} */
      let oldest = null;
      for (const entry of this.sessions.entries()) {
        if (entry[1].proc?.busy) continue;
        if (!oldest || entry[1].lastUsedAt < oldest[1].lastUsedAt) oldest = entry;
      }
      if (!oldest) {
        throw new TurnError('all conversation slots are busy, try again shortly', {
          code: 'sessions_exhausted',
          status: 503,
          retryAfter: 5,
        });
      }
      log.info('evicting idle conversation', { conversationId: oldest[0] });
      this.drop(oldest[0]);
    }
  }

  /**
   * Idle conversations release their process (freeing ~300MB of Node heap each)
   * but keep the id→session mapping so the next turn resumes seamlessly.
   */
  _sweep() {
    const now = Date.now();
    for (const [id, s] of this.sessions.entries()) {
      if (!s.proc || s.proc.busy) continue;
      if (now - s.lastUsedAt < this.cfg.sessionIdleMs) continue;
      log.debug('releasing idle process', { conversationId: id });
      const proc = s.proc;
      s.proc = null;
      proc.close().catch(() => {});
    }
    // Forget mappings nobody has touched for a day.
    const stale = this.cfg.sessionIdleMs * 24;
    for (const [id, s] of this.sessions.entries()) {
      if (!s.proc && now - s.lastUsedAt > stale) this.sessions.delete(id);
    }
    this._scheduleSave();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      for (const [id, s] of Object.entries(raw.sessions || {})) {
        const e = /** @type {any} */ (s);
        if (!e || typeof e.claudeSessionId !== 'string') continue;
        if (!this.cfg.agents[e.agent]) continue;
        this.sessions.set(id, {
          proc: null,
          agent: e.agent,
          claudeSessionId: e.claudeSessionId,
          createdAt: e.createdAt || Date.now(),
          lastUsedAt: e.lastUsedAt || Date.now(),
          turns: e.turns || 0,
        });
      }
      log.info('restored conversations', { count: this.sessions.size });
    } catch {
      // No store yet, or it is unreadable — start empty.
    }
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => this._flushSave(), 1000);
    this._saveTimer.unref?.();
  }

  _flushSave() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    /** @type {Record<string, any>} */
    const out = {};
    for (const [id, s] of this.sessions.entries()) {
      out[id] = {
        agent: s.agent,
        claudeSessionId: s.claudeSessionId,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
        turns: s.turns,
      };
    }
    try {
      const tmp = `${this.storePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions: out }), { mode: 0o600 });
      fs.renameSync(tmp, this.storePath);
    } catch (err) {
      log.warn('could not persist sessions', { err: String(/** @type {any} */ (err)?.message || err) });
    }
  }
}
