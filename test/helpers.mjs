/**
 * Test harness: boots a real gateway wired to the fake CLI, plus the small
 * HTTP/SSE/WebSocket clients the assertions need.
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';
import { setLevel } from '../src/log.js';
import { encodeFrame, decodeFrame, OPCODE } from '../src/ws.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_CLAUDE = path.join(HERE, 'fake-claude.mjs');
export const TEST_KEY = 'test-key';
export const ADMIN_KEY = 'admin-key';

/**
 * @param {Record<string,string>} [env]
 * @returns {Promise<{url:string, close:()=>Promise<void>, engine:any, dataDir:string}>}
 */
export async function startGateway(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-test-'));
  const saved = { ...process.env };
  // The overrides stay applied for the gateway's whole lifetime, not just for
  // loadConfig(): variables like FAKE_CLAUDE_MODE are read by the CLI child
  // processes it spawns later. close() puts the environment back.
  Object.assign(process.env, {
    CLAUDE_BIN: FAKE_CLAUDE,
    API_KEYS: `test:${TEST_KEY}`,
    ADMIN_KEY,
    DATA_DIR: dataDir,
    AGENTS_FILE: '',
    LOG_LEVEL: 'silent',
    PORT: '0',
    HOST: '127.0.0.1',
    MAX_CONCURRENCY: '2',
    RATE_LIMIT_RPM: '1000',
    STARTUP_TIMEOUT_MS: '20000',
    ...env,
  });

  const restoreEnv = () => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  };

  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    restoreEnv();
    throw err;
  }
  setLevel(cfg.logLevel);

  const { server, engine } = createServer(cfg);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    engine,
    dataDir,
    /** @param {{keepData?:boolean}} [opts] Keep DATA_DIR to test restart recovery. */
    close: async (opts = {}) => {
      // engine.stop() first: it hangs up the WebSocket connections, which
      // server.close() would otherwise wait on forever.
      await engine.stop();
      await new Promise((resolve) => {
        server.close(() => resolve(undefined));
        // Drop keep-alive sockets a client abandoned, too.
        server.closeAllConnections();
      });
      restoreEnv();
      if (!opts.keepData) fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * @param {string} url
 * @param {{method?:string, body?:any, key?:string|null, headers?:Record<string,string>}} [opts]
 */
export async function request(url, opts = {}) {
  /** @type {Record<string,string>} */
  const headers = { ...(opts.headers || {}) };
  const key = opts.key === undefined ? TEST_KEY : opts.key;
  if (key) headers.authorization = `Bearer ${key}`;
  let body;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(url, { method: opts.method || (body ? 'POST' : 'GET'), headers, body });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, text, json };
}

/**
 * Read an SSE response into its individual `data:` payloads.
 *
 * @param {string} url
 * @param {{body:any, key?:string}} opts
 * @returns {Promise<{status:number, events:any[], raw:string}>}
 */
export async function sse(url, opts) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.key ?? TEST_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(opts.body),
  });
  const raw = await res.text();
  const events = [];
  for (const block of raw.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') { events.push('[DONE]'); continue; }
      try { events.push(JSON.parse(payload)); } catch { events.push(payload); }
    }
  }
  return { status: res.status, events, raw };
}

/**
 * A WebSocket client just capable enough to drive /v1/ws.
 *
 * @param {string} httpUrl
 * @param {string} pathAndQuery
 */
export function wsConnect(httpUrl, pathAndQuery) {
  const u = new URL(pathAndQuery, httpUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(u.port), u.hostname, () => {
      const key = crypto.randomBytes(16).toString('base64');
      socket.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
          `Host: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });

    let buf = Buffer.alloc(0);
    let upgraded = false;
    /** @type {any[]} */
    const queue = [];
    /** @type {((m:any)=>void)[]} */
    const waiters = [];
    /** @type {((e:Error)=>void)|null} */
    let failWaiters = null;

    const client = {
      /** @param {any} obj */
      send(obj) {
        socket.write(maskFrame(encodeFrame(OPCODE.TEXT, Buffer.from(JSON.stringify(obj)))));
      },
      /** @param {(m:any)=>boolean} [predicate] @param {number} [timeoutMs] */
      next(predicate, timeoutMs = 15_000) {
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('timed out waiting for a websocket message')), timeoutMs);
          const tryDrain = () => {
            while (queue.length) {
              const msg = queue.shift();
              if (!predicate || predicate(msg)) { clearTimeout(timer); res(msg); return true; }
            }
            return false;
          };
          if (tryDrain()) return;
          waiters.push(() => tryDrain());
          failWaiters = (err) => { clearTimeout(timer); rej(err); };
        });
      },
      close() { socket.destroy(); },
      socket,
    };

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = buf.subarray(0, idx).toString();
        if (!/^HTTP\/1\.1 101/.test(head)) { reject(new Error(`handshake failed: ${head.split('\r\n')[0]}`)); socket.destroy(); return; }
        buf = buf.subarray(idx + 4);
        upgraded = true;
        resolve(client);
      }
      for (;;) {
        let decoded;
        try { decoded = decodeFrameFromServer(buf); } catch (err) { reject(err); return; }
        if (!decoded) break;
        buf = decoded.rest;
        if (decoded.opcode === OPCODE.TEXT) {
          try { queue.push(JSON.parse(decoded.payload.toString())); } catch { queue.push(decoded.payload.toString()); }
        } else if (decoded.opcode === OPCODE.PING) {
          socket.write(maskFrame(encodeFrame(OPCODE.PONG, decoded.payload)));
        } else if (decoded.opcode === OPCODE.CLOSE) {
          queue.push({ type: '__close__' });
        }
        while (waiters.length && waiters[0]()) waiters.shift();
      }
    });
    socket.on('error', (err) => { if (failWaiters) failWaiters(err); reject(err); });
    socket.on('close', () => { if (failWaiters) failWaiters(new Error('socket closed')); });
  });
}

/** Server frames are unmasked; decode without the client-mask requirement. */
function decodeFrameFromServer(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
  if (buf.length < offset + len) return null;
  return { opcode, payload: buf.subarray(offset, offset + len), rest: buf.subarray(offset + len) };
}

/** @param {Buffer} frame */
function maskFrame(frame) {
  let len = frame[1] & 0x7f;
  let offset = 2;
  if (len === 126) { len = frame.readUInt16BE(2); offset = 4; }
  else if (len === 127) { len = Number(frame.readBigUInt64BE(2)); offset = 10; }
  const payload = frame.subarray(offset);
  const mask = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
  const header = Buffer.from(frame.subarray(0, offset));
  header[1] |= 0x80;
  return Buffer.concat([header, mask, masked]);
}

export { http };
