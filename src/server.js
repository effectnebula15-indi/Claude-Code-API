#!/usr/bin/env node
/**
 * claude-code-api — a self-hosted HTTP gateway that exposes the Claude Code CLI
 * as an OpenAI- and Anthropic-compatible API, running on a Claude subscription
 * instead of pay-per-token API credits.
 *
 * Start with: node src/server.js
 */
import http from 'node:http';
import { loadConfig } from './config.js';
import { log, setLevel } from './log.js';
import { Engine } from './engine.js';
import { applyCors, clientIp, sendError, sendJson, sendText } from './util/http.js';
import { listModels, chatCompletions } from './routes/openai.js';
import { messages } from './routes/anthropic.js';
import { ask } from './routes/simple.js';
import { usage, agents, listSessions, deleteSession, metrics } from './routes/admin.js';
import { handleWsUpgrade } from './routes/wsapi.js';

/**
 * @typedef {Object} RequestContext
 * @property {import('./types.js').ApiKey} key
 * @property {URL} url
 * @property {Record<string,string>} params
 * @property {AbortSignal} signal
 * @property {string} ip
 */

/**
 * @typedef {(req: import('node:http').IncomingMessage,
 *            res: import('node:http').ServerResponse,
 *            ctx: RequestContext) => Promise<void>} Handler
 */

/** @param {import('./config.js').Config} cfg */
export function createServer(cfg) {
  const engine = new Engine(cfg);
  const base = cfg.basePath;

  /**
   * @type {{method:string, path:string, handler:Handler, auth:boolean, style:'openai'|'anthropic'|'plain'}[]}
   */
  const routes = [
    { method: 'GET', path: '/healthz', handler: health(), auth: false, style: 'plain' },
    { method: 'GET', path: '/readyz', handler: ready(engine), auth: false, style: 'plain' },
    { method: 'GET', path: '/metrics', handler: metrics(engine), auth: !cfg.publicMetrics, style: 'plain' },
    { method: 'GET', path: '/v1/models', handler: listModels(engine), auth: true, style: 'openai' },
    { method: 'POST', path: '/v1/chat/completions', handler: chatCompletions(engine), auth: true, style: 'openai' },
    { method: 'POST', path: '/v1/messages', handler: messages(engine), auth: true, style: 'anthropic' },
    { method: 'POST', path: '/v1/ask', handler: ask(engine), auth: true, style: 'plain' },
    { method: 'GET', path: '/v1/usage', handler: usage(engine), auth: true, style: 'plain' },
    { method: 'GET', path: '/v1/agents', handler: agents(engine), auth: true, style: 'plain' },
    { method: 'GET', path: '/v1/sessions', handler: listSessions(engine), auth: true, style: 'plain' },
    { method: 'DELETE', path: '/v1/sessions/:id', handler: deleteSession(engine), auth: true, style: 'plain' },
    { method: 'POST', path: '/v1/sessions/:id/reset', handler: deleteSession(engine), auth: true, style: 'plain' },
    { method: 'GET', path: '/', handler: index(cfg), auth: false, style: 'plain' },
  ];

  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      engine.metrics.request(res.statusCode);
      log.debug('request', {
        method: req.method,
        path: req.url,
        status: res.statusCode,
        ms: Date.now() - startedAt,
      });
    });

    /** @type {'openai'|'anthropic'|'plain'} */
    let style = 'plain';
    try {
      if (applyCors(req, res, cfg.corsOrigins)) return;

      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      let pathname = url.pathname.replace(/\/+$/, '') || '/';
      if (base && pathname.startsWith(base)) pathname = pathname.slice(base.length) || '/';

      const match = matchRoute(routes, req.method || 'GET', pathname);
      if (!match) {
        if (routes.some((r) => matchPath(r.path, pathname))) {
          return sendError(res, Object.assign(new Error('method not allowed'), { status: 405, code: 'method_not_allowed' }));
        }
        return sendError(res, Object.assign(new Error(`no route for ${pathname}`), { status: 404, code: 'not_found' }));
      }
      style = match.route.style;

      /** @type {import('./types.js').ApiKey} */
      let key = { key: '', name: 'anonymous', agents: null, rpm: null, daily: null, admin: false };
      if (match.route.auth) {
        const authed = engine.auth.authenticate(req);
        if (!authed) {
          res.setHeader('www-authenticate', 'Bearer realm="claude-code-api"');
          return sendError(res, Object.assign(new Error('missing or invalid API key'), { status: 401, code: 'authentication_error' }), style);
        }
        key = authed;

        // Only model calls consume the plan; reading /v1/usage should not be
        // rate limited or the dashboards break exactly when you need them.
        if (isModelCall(match.route.path)) {
          const verdict = engine.limiter.check(key.name, { rpm: key.rpm, daily: key.daily });
          if (!verdict.ok) {
            engine.metrics.rateLimited++;
            return sendError(
              res,
              Object.assign(new Error(`rate limit exceeded (${verdict.reason})`), {
                status: 429,
                code: 'rate_limit_exceeded',
                retryAfter: verdict.retryAfter,
              }),
              style,
            );
          }
        }
      }

      const controller = new AbortController();
      // The model keeps working after the caller hangs up unless we say stop.
      //
      // Watch the *response*, not the request: `req` emits 'close' as soon as
      // its body has been read, which for any POST is long before the reply is
      // ready. `res` closes either when we finish (writableEnded) or when the
      // client actually goes away.
      res.on('close', () => { if (!res.writableEnded) controller.abort(); });

      await match.route.handler(req, res, {
        key,
        url,
        params: match.params,
        signal: controller.signal,
        ip: clientIp(req, cfg.trustProxy),
      });
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (Number(e?.status) >= 500 || !e?.status) {
        log.error('request failed', { path: req.url, err: e });
      } else {
        log.debug('request rejected', { path: req.url, status: e.status, msg: e.message });
      }
      if (e?.code === 'queue_full' || e?.code === 'queue_timeout') engine.metrics.queueRejected++;
      sendError(res, e, style);
    }
  });

  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      let pathname = url.pathname.replace(/\/+$/, '') || '/';
      if (base && pathname.startsWith(base)) pathname = pathname.slice(base.length) || '/';
      if (pathname !== '/v1/ws') {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      handleWsUpgrade(engine, req, socket, head, url);
    } catch (err) {
      log.warn('upgrade failed', { err: String(/** @type {any} */ (err)?.message) });
      socket.destroy();
    }
  });

  // Long model turns must not be cut short by Node's default socket timeouts.
  server.headersTimeout = 30_000;
  server.requestTimeout = cfg.requestTimeoutMs;
  server.keepAliveTimeout = 75_000;

  return { server, engine };
}

/** @returns {Handler} */
function health() {
  return async (_req, res) => sendJson(res, 200, { status: 'ok' });
}

/**
 * Readiness is "can we actually answer a question", which for this service
 * means the CLI is installed and authenticated. Verified lazily and cached, so
 * a load balancer polling every second does not spawn a process every second.
 *
 * @param {import('./engine.js').Engine} engine
 * @returns {Handler}
 */
function ready(engine) {
  let cache = { at: 0, ok: false, detail: '' };
  return async (_req, res) => {
    const stats = engine.sessions.stats();
    if (stats.alive > 0 || stats.warm > 0) {
      return sendJson(res, 200, { status: 'ready', detail: 'claude process running', sessions: stats });
    }
    if (Date.now() - cache.at > 30_000) {
      const probe = await probeCli(engine.cfg.claudeBin);
      cache = { at: Date.now(), ok: probe.ok, detail: probe.detail };
    }
    sendJson(res, cache.ok ? 200 : 503, { status: cache.ok ? 'ready' : 'unavailable', detail: cache.detail, sessions: stats });
  };
}

/** @param {string} bin */
async function probeCli(bin) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const cp = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    cp.stdout.on('data', (d) => { out += d; });
    cp.on('error', (err) => resolve({ ok: false, detail: `claude CLI not runnable: ${err.message}` }));
    cp.on('exit', (code) => resolve(code === 0 ? { ok: true, detail: out.trim() } : { ok: false, detail: `claude --version exited ${code}` }));
    setTimeout(() => { cp.kill('SIGKILL'); resolve({ ok: false, detail: 'claude --version timed out' }); }, 10_000).unref?.();
  });
}

/** @param {import('./config.js').Config} cfg @returns {Handler} */
function index(cfg) {
  return async (_req, res) =>
    sendText(
      res,
      200,
      [
        'claude-code-api',
        '',
        'OpenAI-compatible:   POST /v1/chat/completions   GET /v1/models',
        'Anthropic-compatible: POST /v1/messages',
        'Simple:              POST /v1/ask                WS  /v1/ws',
        'Ops:                 GET /v1/usage  GET /v1/agents  GET /healthz  GET /metrics',
        '',
        `agents: ${Object.keys(cfg.agents).join(', ')}`,
        '',
        'All /v1 endpoints require: Authorization: Bearer <your key>',
        '',
      ].join('\n'),
    );
}

/** @param {string} path */
function isModelCall(path) {
  return path === '/v1/chat/completions' || path === '/v1/messages' || path === '/v1/ask';
}

/**
 * @param {{method:string, path:string}[]} routes
 * @param {string} method
 * @param {string} pathname
 */
function matchRoute(routes, method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchPath(route.path, pathname);
    if (params) return { route: /** @type {any} */ (route), params };
  }
  return null;
}

/**
 * @param {string} pattern
 * @param {string} pathname
 * @returns {Record<string,string>|null}
 */
export function matchPath(pattern, pathname) {
  if (!pattern.includes(':')) return pattern === pathname ? {} : null;
  const p = pattern.split('/');
  const s = pathname.split('/');
  if (p.length !== s.length) return null;
  /** @type {Record<string,string>} */
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) {
      if (!s[i]) return null;
      params[p[i].slice(1)] = decodeURIComponent(s[i]);
    } else if (p[i] !== s[i]) {
      return null;
    }
  }
  return params;
}

async function main() {
  const cfg = loadConfig();
  setLevel(cfg.logLevel);

  const { server, engine } = createServer(cfg);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => resolve(undefined));
  });

  log.info('claude-code-api listening', {
    url: `http://${cfg.host}:${cfg.port}${cfg.basePath}`,
    agents: Object.keys(cfg.agents),
    default_agent: cfg.defaultAgent,
    max_concurrency: cfg.maxConcurrency,
    keys: cfg.apiKeys.length,
    anonymous: cfg.allowAnonymous,
  });
  if (cfg.allowAnonymous) {
    log.warn('ALLOW_ANONYMOUS is on: anyone who can reach this port can spend your Claude plan');
  }

  engine.sessions.prewarmAll().catch((err) => log.warn('prewarm failed', { err: String(err?.message) }));

  let shuttingDown = false;
  const shutdown = async (/** @type {string} */ signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });
    // Stop accepting work, release idle keep-alive sockets, and let in-flight
    // turns finish. closeAllConnections() is the backstop if one will not.
    server.close();
    server.closeIdleConnections();
    const timer = setTimeout(() => {
      log.warn('forced exit: connections still open');
      server.closeAllConnections();
      process.exit(1);
    }, 15_000);
    timer.unref();
    await engine.stop();
    clearTimeout(timer);
    server.closeAllConnections();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => log.error('unhandled rejection', { err }));
}

// Only auto-start when executed directly, so tests can import createServer().
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    log.error('failed to start', { err });
    process.exit(1);
  });
}
