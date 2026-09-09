import crypto from 'node:crypto';

/** @param {string} prefix */
export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

/**
 * Conversation ids come from untrusted clients and end up in a Map key and in
 * logs, so keep them short and boring.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeConversationId(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(s)) {
    const err = new Error('conversation id must be 1-128 chars of [A-Za-z0-9._:-]');
    /** @type {any} */ (err).status = 400;
    /** @type {any} */ (err).code = 'invalid_request_error';
    throw err;
  }
  return s;
}
