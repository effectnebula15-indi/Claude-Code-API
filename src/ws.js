/**
 * A small RFC 6455 server: handshake, frame codec, ping/pong, close.
 *
 * Written by hand rather than pulled from npm to keep the project at zero
 * runtime dependencies — `git clone && node src/server.js` has to just work on
 * a box with nothing but Node on it. Only what a client needs is implemented:
 * text and binary data frames, fragmentation, control frames. No extensions,
 * no permessage-deflate.
 */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

/** @param {string} key */
export function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/**
 * Encode one server frame. Server-to-client frames are never masked.
 *
 * @param {number} opcode
 * @param {Buffer} payload
 * @returns {Buffer<ArrayBuffer>}
 */
export function encodeFrame(opcode, payload) {
  const len = payload.length;
  /** @type {Buffer<ArrayBuffer>} */
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, payload]);
}

/**
 * Pull one complete frame off the front of a buffer.
 *
 * @param {Buffer<ArrayBuffer>} buf
 * @returns {{frame:{fin:boolean, opcode:number, payload:Buffer<ArrayBuffer>}, rest:Buffer<ArrayBuffer>}|null}
 *          null when more bytes are needed.
 */
export function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const rsv = buf[0] & 0x70;
  if (rsv !== 0) throw new WsError(1002, 'RSV bits must be zero');
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    const big = buf.readBigUInt64BE(offset);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new WsError(1009, 'frame too large');
    len = Number(big);
    offset += 8;
  }

  // Control frames must be short and unfragmented (RFC 6455 §5.5).
  if (opcode >= 0x8 && (len > 125 || !fin)) throw new WsError(1002, 'invalid control frame');
  // Clients must mask; an unmasked client frame is a protocol error.
  if (!masked) throw new WsError(1002, 'client frames must be masked');

  if (buf.length < offset + 4 + len) return null;
  const mask = buf.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) payload[i] = buf[offset + i] ^ mask[i & 3];

  return { frame: { fin, opcode, payload }, rest: Buffer.from(buf.subarray(offset + len)) };
}

export class WsError extends Error {
  /** @param {number} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'WsError';
    this.code = code;
  }
}

/**
 * @typedef {Object} WsOptions
 * @property {number} [maxMessageBytes]
 * @property {number} [pingIntervalMs]
 */

export class WebSocketConnection extends EventEmitter {
  /**
   * @param {import('node:net').Socket} socket
   * @param {WsOptions} [opts]
   */
  constructor(socket, opts = {}) {
    super();
    this.socket = socket;
    this.maxMessageBytes = opts.maxMessageBytes ?? 8 * 1024 * 1024;
    this.closed = false;
    /** @type {Buffer<ArrayBuffer>} */
    this.buffer = Buffer.alloc(0);
    /** @type {Buffer<ArrayBuffer>[]} */
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.fragmentBytes = 0;
    this.alive = true;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._onClose());
    socket.on('error', (err) => { this.emit('error', err); this._onClose(); });

    const interval = opts.pingIntervalMs ?? 25_000;
    if (interval > 0) {
      this.pinger = setInterval(() => {
        if (!this.alive) return this.terminate();
        this.alive = false;
        this.ping();
      }, interval);
      this.pinger.unref?.();
    }
  }

  /** @param {Buffer} chunk */
  _onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    try {
      for (;;) {
        const decoded = decodeFrame(this.buffer);
        if (!decoded) break;
        this.buffer = decoded.rest;
        this._onFrame(decoded.frame);
        if (this.closed) break;
      }
    } catch (err) {
      const e = /** @type {WsError} */ (err);
      this.close(e.code || 1002, e.message);
    }
  }

  /** @param {{fin:boolean, opcode:number, payload:Buffer<ArrayBuffer>}} frame */
  _onFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OPCODE.PING:
        this._send(OPCODE.PONG, payload);
        return;
      case OPCODE.PONG:
        this.alive = true;
        return;
      case OPCODE.CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        this.close(code === 1005 ? 1000 : code, '');
        return;
      }
      case OPCODE.TEXT:
      case OPCODE.BINARY:
        if (this.fragments.length) throw new WsError(1002, 'interleaved data frame');
        if (!fin) {
          this.fragmentOpcode = opcode;
          this.fragments = [payload];
          this.fragmentBytes = payload.length;
          this._checkSize();
          return;
        }
        this._deliver(opcode, payload);
        return;
      case OPCODE.CONTINUATION: {
        if (!this.fragments.length) throw new WsError(1002, 'continuation without start');
        this.fragments.push(payload);
        this.fragmentBytes += payload.length;
        this._checkSize();
        if (!fin) return;
        const full = Buffer.concat(this.fragments);
        const op = this.fragmentOpcode;
        this.fragments = [];
        this.fragmentBytes = 0;
        this._deliver(op, full);
        return;
      }
      default:
        throw new WsError(1002, `unknown opcode ${opcode}`);
    }
  }

  _checkSize() {
    if (this.fragmentBytes > this.maxMessageBytes) throw new WsError(1009, 'message too large');
  }

  /** @param {number} opcode @param {Buffer} payload */
  _deliver(opcode, payload) {
    if (payload.length > this.maxMessageBytes) throw new WsError(1009, 'message too large');
    this.alive = true;
    if (opcode === OPCODE.TEXT) this.emit('message', payload.toString('utf8'), false);
    else this.emit('message', payload, true);
  }

  /** @param {string|object} data */
  sendJson(data) {
    this.sendText(JSON.stringify(data));
  }

  /** @param {string} text */
  sendText(text) {
    this._send(OPCODE.TEXT, Buffer.from(text, 'utf8'));
  }

  /** @param {Buffer} [payload] */
  ping(payload = Buffer.alloc(0)) {
    this._send(OPCODE.PING, payload);
  }

  /** @param {number} opcode @param {Buffer} payload */
  _send(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    try {
      this.socket.write(encodeFrame(opcode, payload));
    } catch {
      this.terminate();
    }
  }

  /** @param {number} [code] @param {string} [reason] */
  close(code = 1000, reason = '') {
    if (this.closed) return;
    const reasonBuf = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this._send(OPCODE.CLOSE, payload);
    this.closed = true;
    if (this.pinger) clearInterval(this.pinger);
    this.socket.end();
    this.emit('close', code, reason);
  }

  terminate() {
    if (this.closed) return;
    this.closed = true;
    if (this.pinger) clearInterval(this.pinger);
    this.socket.destroy();
    this.emit('close', 1006, 'terminated');
  }

  _onClose() {
    if (this.closed) return;
    this.closed = true;
    if (this.pinger) clearInterval(this.pinger);
    this.emit('close', 1006, 'socket closed');
  }
}

/**
 * Complete the HTTP upgrade and return a live connection, or null if the
 * request was not a valid WebSocket handshake (the socket is closed for you).
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:stream').Duplex} socket
 * @param {Buffer} head
 * @param {WsOptions} [opts]
 * @returns {WebSocketConnection|null}
 */
export function upgrade(req, socket, head, opts) {
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];
  if (
    String(req.headers.upgrade || '').toLowerCase() !== 'websocket' ||
    typeof key !== 'string' ||
    String(version) !== '13'
  ) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return null;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  /** @type {import('node:net').Socket} */ (socket).setNoDelay(true);
  const conn = new WebSocketConnection(/** @type {import('node:net').Socket} */ (socket), opts);
  if (head && head.length) conn._onData(head);
  return conn;
}
