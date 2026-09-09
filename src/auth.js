/**
 * Bearer-token auth over a small static key list.
 *
 * Keys are compared in constant time: a timing oracle on a public endpoint is
 * the one classic way a "just a personal gateway" leaks its credential.
 */
import crypto from 'node:crypto';

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
export function extractKey(req) {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  // Anthropic SDKs send x-api-key; OpenAI SDKs send Authorization. Support both
  // so unmodified client libraries work against the same port.
  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey) return xApiKey.trim();
  return '';
}

/** @param {string} a @param {string} b */
export function timingSafeEqual(a, b) {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // Hash first so differing lengths do not short-circuit the comparison.
  const ha = crypto.createHash('sha256').update(ba).digest();
  const hb = crypto.createHash('sha256').update(bb).digest();
  return crypto.timingSafeEqual(ha, hb) && ba.length === bb.length;
}

export class Authenticator {
  /** @param {{keys:import('./types.js').ApiKey[], allowAnonymous:boolean, adminKey:string}} o */
  constructor({ keys, allowAnonymous, adminKey }) {
    this.keys = keys;
    this.allowAnonymous = allowAnonymous;
    this.adminKey = adminKey;
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @returns {import('./types.js').ApiKey|null}
   */
  authenticate(req) {
    const presented = extractKey(req);
    if (presented) {
      if (this.adminKey && timingSafeEqual(presented, this.adminKey)) {
        return { key: presented, name: 'admin', agents: null, rpm: null, daily: null, admin: true };
      }
      for (const k of this.keys) {
        if (timingSafeEqual(presented, k.key)) return k;
      }
      return null;
    }
    if (this.allowAnonymous) {
      return { key: '', name: 'anonymous', agents: null, rpm: null, daily: null, admin: false };
    }
    return null;
  }
}

/** Generate a key that is obvious in logs and safe to paste into a config. */
export function generateKey(prefix = 'cca') {
  return `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
}
