/**
 * Small HTTP helpers over node:http. No framework: the routing surface is a
 * dozen endpoints, and zero dependencies is what makes this deployable by
 * copying a directory onto a box.
 */

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<any>}
 */
export function readJson(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared && declared > maxBytes) return reject(payloadTooLarge(maxBytes));

    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(payloadTooLarge(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        const e = new Error(`invalid JSON body: ${/** @type {Error} */ (err).message}`);
        /** @type {any} */ (e).status = 400;
        /** @type {any} */ (e).code = 'invalid_request_error';
        reject(e);
      }
    });
  });
}

/** @param {number} maxBytes */
function payloadTooLarge(maxBytes) {
  const err = new Error(`request body exceeds ${maxBytes} bytes`);
  /** @type {any} */ (err).status = 413;
  /** @type {any} */ (err).code = 'payload_too_large';
  return err;
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {any} body
 * @param {Record<string,string>} [headers]
 */
export function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} text
 * @param {Record<string,string>} [headers]
 */
export function sendText(res, status, text, headers = {}) {
  if (res.headersSent) return;
  const payload = Buffer.from(text);
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(payload.length),
    ...headers,
  });
  res.end(payload);
}

/**
 * Error shape mirrors OpenAI's so their SDKs surface a useful message instead
 * of "unknown error".
 *
 * @param {import('node:http').ServerResponse} res
 * @param {any} err
 * @param {'openai'|'anthropic'|'plain'} [style]
 */
export function sendError(res, err, style = 'openai') {
  const status = Number(err?.status) || 500;
  // 499 is nginx's "client closed request": nothing to send, the socket is gone.
  if (status === 499) { try { res.destroy(); } catch { /* already closed */ } return; }
  const message = String(err?.message || 'internal error');
  const code = String(err?.code || 'internal_error');
  /** @type {Record<string,string>} */
  const headers = {};
  if (err?.retryAfter) headers['retry-after'] = String(err.retryAfter);

  if (style === 'anthropic') {
    sendJson(res, status, { type: 'error', error: { type: anthropicErrorType(status), message } }, headers);
  } else if (style === 'plain') {
    sendJson(res, status, { error: message, code }, headers);
  } else {
    sendJson(res, status, { error: { message, type: code, param: err?.param ?? null, code } }, headers);
  }
}

/** @param {number} status */
function anthropicErrorType(status) {
  switch (status) {
    case 400: return 'invalid_request_error';
    case 401: return 'authentication_error';
    case 403: return 'permission_error';
    case 404: return 'not_found_error';
    case 413: return 'request_too_large';
    case 429: return 'rate_limit_error';
    case 529: return 'overloaded_error';
    default: return status >= 500 ? 'api_error' : 'invalid_request_error';
  }
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string[]} allowedOrigins
 * @returns {boolean} true when the request was a preflight and is fully handled
 */
export function applyCors(req, res, allowedOrigins) {
  if (!allowedOrigins.length) return false;
  const origin = req.headers.origin;
  const allowAll = allowedOrigins.includes('*');
  if (typeof origin === 'string' && (allowAll || allowedOrigins.includes(origin))) {
    res.setHeader('access-control-allow-origin', allowAll ? '*' : origin);
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-headers', 'authorization, content-type, x-api-key, anthropic-version, x-conversation-id');
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('access-control-max-age', '86400');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} trustProxy
 */
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}
