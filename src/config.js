/**
 * Configuration loading.
 *
 * Everything is driven by environment variables so the service is trivial to
 * run under Docker, systemd or a bare `node src/server.js`. Agent profiles
 * (system prompts, models, tool policy) live in a separate JSON file because
 * they are long-form and version-controlled per deployment.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @param {string} name @param {string} fallback */
function str(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

/** @param {string} name @param {number} fallback */
function num(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${JSON.stringify(v)}`);
  return n;
}

/** @param {string} name @param {boolean} fallback */
function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/** @param {string} name */
function list(name) {
  return str(name, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * API keys may be given inline (`API_KEYS=name:secret,other:secret2`) or in a
 * JSON file (`API_KEYS_FILE`), which is what the installer generates so secrets
 * never sit in a process listing.
 *
 * @returns {import('./types.js').ApiKey[]}
 */
function loadApiKeys() {
  /** @type {import('./types.js').ApiKey[]} */
  const keys = [];
  const file = str('API_KEYS_FILE', '');
  if (file) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entries = Array.isArray(raw) ? raw : Array.isArray(raw.keys) ? raw.keys : [];
    for (const e of entries) {
      if (!e || typeof e.key !== 'string' || !e.key) continue;
      keys.push({
        key: e.key,
        name: String(e.name || 'key'),
        agents: Array.isArray(e.agents) ? e.agents : null,
        rpm: Number.isFinite(e.rpm) ? e.rpm : null,
        daily: Number.isFinite(e.daily) ? e.daily : null,
        admin: e.admin === true,
      });
    }
  }
  for (const entry of list('API_KEYS')) {
    // Accept "secret" or "name:secret". A bare secret is named by its prefix so
    // logs and metrics can distinguish callers without revealing the key.
    const idx = entry.indexOf(':');
    const name = idx === -1 ? `key-${entry.slice(0, 6)}` : entry.slice(0, idx);
    const key = idx === -1 ? entry : entry.slice(idx + 1);
    if (!key) continue;
    keys.push({ key, name, agents: null, rpm: null, daily: null, admin: false });
  }
  return keys;
}

/**
 * @param {string} file
 * @param {string} defaultModel
 * @returns {Record<string, import('./types.js').Agent>}
 */
function loadAgents(file, defaultModel) {
  /** @type {Record<string, any>} */
  let raw = {};
  if (file && fs.existsSync(file)) {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw.agents && typeof raw.agents === 'object') raw = raw.agents;
  }
  if (!raw.default) {
    raw.default = {
      description: 'General purpose assistant',
      system_prompt:
        'You are a helpful, concise assistant. Answer in the language the user writes in. ' +
        'You have no access to files, the shell or the internet, so never claim to have used them.',
    };
  }

  /** @type {Record<string, import('./types.js').Agent>} */
  const agents = {};
  for (const [name, a] of Object.entries(raw)) {
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name)) {
      throw new Error(`Invalid agent name ${JSON.stringify(name)}`);
    }
    let systemPrompt = typeof a.system_prompt === 'string' ? a.system_prompt : '';
    if (a.system_prompt_file) {
      const p = path.resolve(path.dirname(file || '.'), a.system_prompt_file);
      systemPrompt = fs.readFileSync(p, 'utf8');
    }
    agents[name] = {
      name,
      description: String(a.description || ''),
      model: String(a.model || defaultModel),
      systemPrompt,
      appendSystemPrompt: typeof a.append_system_prompt === 'string' ? a.append_system_prompt : '',
      // `tools: []` (the default) means a pure chat model: no Bash, no file
      // access, no network. Anything else is an explicit opt-in by the operator.
      tools: Array.isArray(a.tools) ? a.tools.map(String) : [],
      permissionMode: String(a.permission_mode || 'default'),
      workdir: a.workdir ? String(a.workdir) : '',
      addDirs: Array.isArray(a.add_dirs) ? a.add_dirs.map(String) : [],
      mcpConfig: a.mcp_config ? String(a.mcp_config) : '',
      effort: a.effort ? String(a.effort) : '',
      allowImages: a.allow_images !== false,
      prewarm: Number.isFinite(a.prewarm) ? Math.max(0, Math.min(8, a.prewarm)) : 0,
      maxReplyChars: Number.isFinite(a.max_reply_chars) ? a.max_reply_chars : 0,
      extraArgs: Array.isArray(a.extra_args) ? a.extra_args.map(String) : [],
    };
  }
  return agents;
}

export function loadConfig(env = process.env) {
  const dataDir = str('DATA_DIR', path.join(os.tmpdir(), 'claude-code-api'));
  const defaultModel = str('DEFAULT_MODEL', 'sonnet');
  const agentsFile = str('AGENTS_FILE', fs.existsSync('config/agents.json') ? 'config/agents.json' : '');

  const cfg = {
    host: str('HOST', '0.0.0.0'),
    port: num('PORT', 8787),
    /** Path prefix, e.g. "/claude" when mounted behind a shared reverse proxy. */
    basePath: str('BASE_PATH', '').replace(/\/+$/, ''),

    claudeBin: str('CLAUDE_BIN', 'claude'),
    defaultModel,
    defaultAgent: str('DEFAULT_AGENT', 'default'),
    dataDir,
    /** Working directory handed to every Claude process. Kept empty of secrets. */
    workdir: str('WORKDIR', path.join(dataDir, 'work')),

    apiKeys: loadApiKeys(),
    /** When true the API is open to anyone who can reach the port. */
    allowAnonymous: bool('ALLOW_ANONYMOUS', false),
    adminKey: str('ADMIN_KEY', ''),

    // Throughput control. A subscription is a small, shared resource: the
    // gateway serialises work rather than letting bursts blow the limit.
    maxConcurrency: num('MAX_CONCURRENCY', 2),
    queueMax: num('QUEUE_MAX', 64),
    queueTimeoutMs: num('QUEUE_TIMEOUT_MS', 120_000),
    turnTimeoutMs: num('TURN_TIMEOUT_MS', 300_000),
    startupTimeoutMs: num('STARTUP_TIMEOUT_MS', 60_000),

    // Conversation-scoped Claude processes.
    sessionIdleMs: num('SESSION_IDLE_MS', 600_000),
    maxSessions: num('MAX_SESSIONS', 32),
    sessionMaxTurns: num('SESSION_MAX_TURNS', 0),

    // Per-key request limits (the gateway's own limits, independent of the
    // Anthropic subscription window).
    rateLimitRpm: num('RATE_LIMIT_RPM', 30),
    rateLimitDaily: num('RATE_LIMIT_DAILY', 0),

    /**
     * Many OpenAI clients have no way to pass a conversation id but do send
     * `user`. Turning this on makes each distinct `user` value a conversation,
     * which is what you want behind Open WebUI or a chat front-end.
     */
    conversationFromUserField: bool('CONVERSATION_FROM_USER_FIELD', false),

    maxBodyBytes: num('MAX_BODY_BYTES', 12 * 1024 * 1024),
    maxInputChars: num('MAX_INPUT_CHARS', 60_000),
    maxImagesPerRequest: num('MAX_IMAGES_PER_REQUEST', 4),

    // Subscription window guard: refuse new work above this utilisation so an
    // automated client cannot burn the whole 5-hour window in one loop.
    usageGuard: num('USAGE_GUARD', 0.98),
    usageGuardWeekly: num('USAGE_GUARD_WEEKLY', 0.99),

    corsOrigins: list('CORS_ORIGINS'),
    trustProxy: bool('TRUST_PROXY', false),
    publicMetrics: bool('PUBLIC_METRICS', false),
    logLevel: str('LOG_LEVEL', 'info'),
    logPrompts: bool('LOG_PROMPTS', false),
    requestTimeoutMs: num('REQUEST_TIMEOUT_MS', 0),

    agentsFile,
    agents: loadAgents(agentsFile, defaultModel),
  };

  if (!cfg.agents[cfg.defaultAgent]) {
    throw new Error(
      `DEFAULT_AGENT=${cfg.defaultAgent} is not defined in ${cfg.agentsFile || 'the built-in agents'}`,
    );
  }
  if (!cfg.apiKeys.length && !cfg.allowAnonymous) {
    throw new Error(
      'No API keys configured. Set API_KEYS / API_KEYS_FILE, or ALLOW_ANONYMOUS=1 if the port is ' +
        'only reachable from localhost or a private network.',
    );
  }
  return cfg;
}

/** @typedef {ReturnType<typeof loadConfig>} Config */
