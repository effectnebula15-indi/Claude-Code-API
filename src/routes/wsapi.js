/**
 * WebSocket protocol for always-on devices.
 *
 * A wearable on a mobile network pays a TLS handshake per HTTP request and gets
 * its idle connections killed by carrier NAT. One long-lived socket with
 * server-side pings avoids both, and lets the device cancel a reply the moment
 * the wearer starts talking again.
 *
 * Client -> server:
 *   {"type":"ask","id":"1","prompt":"...","conversation":"g1","agent":"glasses","image":"data:..."}
 *   {"type":"cancel","id":"1"}
 *   {"type":"reset","conversation":"g1"}
 *   {"type":"ping"}
 *
 * Server -> client:
 *   {"type":"ready", ...}  {"type":"delta"|"sentence"|"done"|"error", "id":"1", ...}
 */
import { upgrade } from '../ws.js';
import { SentenceSplitter } from './simple.js';
import { sanitizeConversationId } from '../util/ids.js';
import { imageBlockFromUrl, enforceLimits } from '../messages.js';
import { log } from '../log.js';

/**
 * @param {import('../engine.js').Engine} engine
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:stream').Duplex} socket
 * @param {Buffer} head
 * @param {URL} url
 */
export function handleWsUpgrade(engine, req, socket, head, url) {
  // Browsers cannot set headers on a WebSocket handshake, so a query parameter
  // is the only option there. Header auth still works for everything else.
  const queryKey = url.searchParams.get('key') || url.searchParams.get('api_key');
  if (queryKey && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${queryKey}`;
  }
  const key = engine.auth.authenticate(req);
  if (!key) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const conn = upgrade(req, socket, head, { maxMessageBytes: engine.cfg.maxBodyBytes });
  if (!conn) return;
  engine.wsConnections.add(conn);

  const defaultConversation = sanitizeConversationId(url.searchParams.get('conversation') || '');
  const defaultAgent = url.searchParams.get('agent') || '';
  /** @type {AbortController|null} */
  let inFlight = null;
  let inFlightId = '';

  conn.sendJson({
    type: 'ready',
    agents: Object.keys(engine.cfg.agents).filter((n) => !key.agents || key.agents.includes(n)),
    default_agent: engine.cfg.defaultAgent,
    conversation: defaultConversation || null,
  });

  conn.on('message', async (data, isBinary) => {
    if (isBinary) return conn.sendJson({ type: 'error', message: 'binary frames are not supported' });
    /** @type {any} */
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return conn.sendJson({ type: 'error', message: 'invalid JSON' });
    }

    const id = typeof msg.id === 'string' ? msg.id.slice(0, 64) : '';

    switch (msg.type) {
      case 'ping':
        return conn.sendJson({ type: 'pong', id });

      case 'cancel':
        if (inFlight && (!id || id === inFlightId)) inFlight.abort();
        return conn.sendJson({ type: 'cancelled', id: id || inFlightId });

      case 'reset': {
        const cid = sanitizeConversationId(msg.conversation || defaultConversation || '');
        if (!cid) return conn.sendJson({ type: 'error', id, message: 'no conversation to reset' });
        engine.sessions.drop(cid);
        return conn.sendJson({ type: 'reset', id, conversation: cid });
      }

      case 'ask':
        break;

      default:
        return conn.sendJson({ type: 'error', id, message: `unknown message type ${JSON.stringify(msg.type)}` });
    }

    if (inFlight) {
      return conn.sendJson({ type: 'error', id, code: 'busy', message: 'a request is already in flight on this socket' });
    }

    const rate = engine.limiter.check(key.name, { rpm: key.rpm, daily: key.daily });
    if (!rate.ok) {
      engine.metrics.rateLimited++;
      return conn.sendJson({ type: 'error', id, code: `rate_limited_${rate.reason}`, retry_after: rate.retryAfter, message: 'rate limit exceeded' });
    }

    const controller = new AbortController();
    inFlight = controller;
    inFlightId = id;
    const splitter = new SentenceSplitter();

    try {
      const agent = engine.resolveAgent(msg.agent || defaultAgent, key);
      const conversationId = sanitizeConversationId(msg.conversation || defaultConversation || '');

      /** @type {import('../types.js').ContentBlock[]} */
      const blocks = [];
      if (typeof msg.prompt === 'string' && msg.prompt) blocks.push({ type: 'text', text: msg.prompt });
      else if (typeof msg.text === 'string' && msg.text) blocks.push({ type: 'text', text: msg.text });
      if (msg.image) {
        const src = String(msg.image);
        blocks.push(imageBlockFromUrl(src.startsWith('data:') ? src : `data:${msg.image_media_type || 'image/jpeg'};base64,${src}`));
      }
      if (!blocks.length) throw Object.assign(new Error('prompt is required'), { status: 400, code: 'invalid_request_error' });

      enforceLimits(blocks, {
        maxChars: engine.cfg.maxInputChars,
        maxImages: engine.cfg.maxImagesPerRequest,
        allowImages: agent.allowImages,
      });

      const result = await engine.run({
        agent,
        blocks,
        keyName: key.name,
        conversationId: conversationId || undefined,
        signal: controller.signal,
        onDelta: (text) => {
          conn.sendJson({ type: 'delta', id, text });
          for (const sentence of splitter.push(text)) conn.sendJson({ type: 'sentence', id, text: sentence });
        },
      });
      const tail = splitter.flush();
      if (tail) conn.sendJson({ type: 'sentence', id, text: tail });
      conn.sendJson({
        type: 'done',
        id,
        text: result.text,
        agent: agent.name,
        model: result.model,
        conversation: conversationId || null,
        ms: result.durationMs,
      });
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (e?.code !== 'client_aborted') {
        conn.sendJson({ type: 'error', id, code: String(e?.code || 'internal_error'), message: String(e?.message || 'failed'), retry_after: e?.retryAfter });
      }
    } finally {
      inFlight = null;
      inFlightId = '';
    }
  });

  conn.on('close', () => {
    engine.wsConnections.delete(conn);
    if (inFlight) inFlight.abort();
  });
  conn.on('error', (err) => log.debug('websocket error', { err: String(err && err.message) }));
}
