import test from 'node:test';
import assert from 'node:assert/strict';

import { toBlocks, splitMessages, flattenTranscript, tailTurn, enforceLimits, imageBlockFromUrl, BadRequest } from '../src/messages.js';
import { SentenceSplitter } from '../src/routes/simple.js';
import { RateLimiter } from '../src/ratelimit.js';
import { ConcurrencyGate } from '../src/queue.js';
import { timingSafeEqual, Authenticator, generateKey } from '../src/auth.js';
import { encodeFrame, decodeFrame, acceptKey, OPCODE } from '../src/ws.js';
import { matchPath } from '../src/server.js';
import { sanitizeConversationId } from '../src/util/ids.js';
import { buildArgs } from '../src/claude/args.js';

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('toBlocks handles strings, parts and images', () => {
  assert.deepEqual(toBlocks('hi'), [{ type: 'text', text: 'hi' }]);
  assert.deepEqual(toBlocks(''), []);
  assert.deepEqual(toBlocks([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), [
    { type: 'text', text: 'a' },
    { type: 'text', text: 'b' },
  ]);
  const withImage = toBlocks([{ type: 'image_url', image_url: { url: PNG_1PX } }]);
  assert.equal(withImage[0].type, 'image');
  assert.equal(withImage[0].source.media_type, 'image/png');
});

test('remote image URLs are refused (no server-side fetching)', () => {
  assert.throws(() => imageBlockFromUrl('https://example.com/cat.png'), BadRequest);
  assert.throws(() => imageBlockFromUrl('data:image/tiff;base64,AAAA'), BadRequest);
});

test('splitMessages pulls system prompts out of the body', () => {
  const { system, body } = splitMessages([
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'again' },
  ]);
  assert.equal(system, 'be terse');
  assert.equal(body.length, 3);
  assert.equal(body[0].role, 'user');
});

test('splitMessages accepts Anthropic top-level system', () => {
  const { system } = splitMessages([{ role: 'user', content: 'x' }], 'top level');
  assert.equal(system, 'top level');
});

test('splitMessages rejects empty and malformed input', () => {
  assert.throws(() => splitMessages([]), BadRequest);
  assert.throws(() => splitMessages([{ role: 'tool', content: 'x' }]), BadRequest);
  assert.throws(() => splitMessages([{ role: 'system', content: 'only system' }]), BadRequest);
});

test('flattenTranscript labels turns and keeps a single user turn verbatim', () => {
  const single = flattenTranscript([{ role: 'user', blocks: [{ type: 'text', text: 'just me' }] }]);
  assert.deepEqual(single, [{ type: 'text', text: 'just me' }]);

  const multi = flattenTranscript([
    { role: 'user', blocks: [{ type: 'text', text: 'q1' }] },
    { role: 'assistant', blocks: [{ type: 'text', text: 'a1' }] },
    { role: 'user', blocks: [{ type: 'text', text: 'q2' }] },
  ]);
  assert.equal(multi.length, 1);
  assert.match(multi[0].text, /User: q1[\s\S]*Assistant: a1[\s\S]*User: q2[\s\S]*Assistant:$/);
});

test('flattenTranscript preserves images as real image blocks', () => {
  const image = imageBlockFromUrl(PNG_1PX);
  const out = flattenTranscript([
    { role: 'user', blocks: [{ type: 'text', text: 'q1' }] },
    { role: 'assistant', blocks: [{ type: 'text', text: 'a1' }] },
    { role: 'user', blocks: [{ type: 'text', text: 'what is this' }, image] },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[1].type, 'image');
});

test('tailTurn forwards only what the model has not seen', () => {
  const body = [
    { role: 'user', blocks: [{ type: 'text', text: 'old' }] },
    { role: 'assistant', blocks: [{ type: 'text', text: 'answered' }] },
    { role: 'user', blocks: [{ type: 'text', text: 'new1' }] },
    { role: 'user', blocks: [{ type: 'text', text: 'new2' }] },
  ];
  assert.deepEqual(tailTurn(body), [
    { type: 'text', text: 'new1' },
    { type: 'text', text: 'new2' },
  ]);
});

test('tailTurn nudges the model when the client ends on an assistant turn', () => {
  const out = tailTurn([
    { role: 'user', blocks: [{ type: 'text', text: 'q' }] },
    { role: 'assistant', blocks: [{ type: 'text', text: 'a' }] },
  ]);
  assert.deepEqual(out, [{ type: 'text', text: 'Continue.' }]);
});

test('enforceLimits guards size, image count and image permission', () => {
  const long = [{ type: 'text', text: 'x'.repeat(50) }];
  assert.throws(() => enforceLimits(long, { maxChars: 10, maxImages: 4, allowImages: true }), BadRequest);

  const image = imageBlockFromUrl(PNG_1PX);
  assert.throws(() => enforceLimits([image], { maxChars: 0, maxImages: 4, allowImages: false }), BadRequest);
  assert.throws(() => enforceLimits([image, image], { maxChars: 0, maxImages: 1, allowImages: true }), BadRequest);
  assert.doesNotThrow(() => enforceLimits([image], { maxChars: 0, maxImages: 1, allowImages: true }));
});

test('SentenceSplitter emits speakable sentences and keeps the remainder', () => {
  const s = new SentenceSplitter();
  assert.deepEqual(s.push('Hello there, this is a test. '), ['Hello there, this is a test.']);
  assert.deepEqual(s.push('Half a '), []);
  assert.deepEqual(s.push('sentence still coming'), []);
  assert.equal(s.flush(), 'Half a sentence still coming');
});

test('SentenceSplitter does not split on short abbreviations', () => {
  const s = new SentenceSplitter();
  assert.deepEqual(s.push('Dr. '), []);
  const out = s.push('Smith says the number is 3.5 and that settles it. ');
  assert.equal(out.length, 1);
  assert.match(out[0], /^Dr\. Smith/);
});

test('SentenceSplitter force-breaks a runaway sentence at a word boundary', () => {
  const s = new SentenceSplitter({ minChars: 5, maxChars: 40 });
  const out = s.push('word '.repeat(20));
  assert.ok(out.length >= 1);
  assert.ok(out.every((line) => line.length <= 40));
});

test('RateLimiter enforces rpm and daily caps', () => {
  const rl = new RateLimiter({ rpm: 2, daily: 3 });
  const now = Date.now();
  assert.equal(rl.check('k', {}, now).ok, true);
  assert.equal(rl.check('k', {}, now).ok, true);
  const third = rl.check('k', {}, now);
  assert.equal(third.ok, false);
  assert.equal(third.reason, 'rpm');
  assert.ok(third.retryAfter > 0);

  // A minute later the bucket has refilled, but the daily cap still bites.
  assert.equal(rl.check('k', {}, now + 60_000).ok, true);
  const daily = rl.check('k', {}, now + 120_000);
  assert.equal(daily.ok, false);
  assert.equal(daily.reason, 'daily');
});

test('RateLimiter honours per-key overrides and isolates keys', () => {
  const rl = new RateLimiter({ rpm: 1, daily: 0 });
  const now = Date.now();
  assert.equal(rl.check('a', { rpm: 5 }, now).ok, true);
  assert.equal(rl.check('a', { rpm: 5 }, now).ok, true);
  assert.equal(rl.check('b', {}, now).ok, true);
  assert.equal(rl.check('b', {}, now).ok, false);
});

test('ConcurrencyGate serialises beyond its limit and releases in order', async () => {
  const gate = new ConcurrencyGate({ limit: 1, queueMax: 4, timeoutMs: 1000 });
  const release1 = await gate.acquire();
  assert.equal(gate.active, 1);

  let secondStarted = false;
  const second = gate.acquire().then((r) => { secondStarted = true; return r; });
  await new Promise((r) => setImmediate(r));
  assert.equal(secondStarted, false, 'second caller must wait');
  assert.equal(gate.queued, 1);

  release1();
  const release2 = await second;
  assert.equal(secondStarted, true);
  release2();
  assert.equal(gate.active, 0);
});

test('ConcurrencyGate rejects when the queue is full', async () => {
  const gate = new ConcurrencyGate({ limit: 1, queueMax: 1, timeoutMs: 1000 });
  const r1 = await gate.acquire();
  const waiting = gate.acquire();
  await assert.rejects(() => gate.acquire(), (err) => err.code === 'queue_full' && err.status === 503);
  r1();
  (await waiting)();
});

test('ConcurrencyGate times out a waiter and stops holding the slot', async () => {
  const gate = new ConcurrencyGate({ limit: 1, queueMax: 4, timeoutMs: 30 });
  const r1 = await gate.acquire();
  await assert.rejects(() => gate.acquire(), (err) => err.code === 'queue_timeout');
  assert.equal(gate.queued, 0);
  r1();
});

test('ConcurrencyGate drops an aborted waiter', async () => {
  const gate = new ConcurrencyGate({ limit: 1, queueMax: 4, timeoutMs: 5000 });
  const r1 = await gate.acquire();
  const ac = new AbortController();
  const pending = gate.acquire(ac.signal);
  ac.abort();
  await assert.rejects(() => pending, (err) => err.code === 'client_aborted');
  assert.equal(gate.queued, 0);
  r1();
});

test('timingSafeEqual compares by value, not by length shortcut', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
  assert.equal(timingSafeEqual('', ''), true);
});

test('Authenticator matches bearer, x-api-key, admin and anonymous', () => {
  const keys = [{ key: 'secret', name: 'device', agents: ['glasses'], rpm: null, daily: null, admin: false }];
  const auth = new Authenticator({ keys, allowAnonymous: false, adminKey: 'root' });

  assert.equal(auth.authenticate({ headers: { authorization: 'Bearer secret' } })?.name, 'device');
  assert.equal(auth.authenticate({ headers: { 'x-api-key': 'secret' } })?.name, 'device');
  assert.equal(auth.authenticate({ headers: { authorization: 'Bearer root' } })?.admin, true);
  assert.equal(auth.authenticate({ headers: { authorization: 'Bearer nope' } }), null);
  assert.equal(auth.authenticate({ headers: {} }), null);

  const open = new Authenticator({ keys: [], allowAnonymous: true, adminKey: '' });
  assert.equal(open.authenticate({ headers: {} })?.name, 'anonymous');
  // An anonymous gateway must still reject a wrong key rather than wave it through.
  assert.equal(open.authenticate({ headers: { authorization: 'Bearer wrong' } }), null);
});

test('generateKey produces distinct, URL-safe keys', () => {
  const a = generateKey();
  const b = generateKey();
  assert.notEqual(a, b);
  assert.match(a, /^cca_[A-Za-z0-9_-]{30,}$/);
});

test('websocket accept key matches the RFC 6455 example', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('websocket frames round-trip across all length encodings', () => {
  for (const size of [0, 5, 125, 126, 1000, 65535, 65536, 70000]) {
    const payload = Buffer.alloc(size, 0x61);
    const server = encodeFrame(OPCODE.TEXT, payload);
    // Re-mask it as a client would, then decode.
    const masked = maskAsClient(server);
    const decoded = decodeFrame(masked);
    assert.ok(decoded, `size ${size} should decode`);
    assert.equal(decoded.frame.opcode, OPCODE.TEXT);
    assert.equal(decoded.frame.payload.length, size);
    assert.equal(decoded.rest.length, 0);
  }
});

test('decodeFrame waits for more bytes instead of guessing', () => {
  const full = maskAsClient(encodeFrame(OPCODE.TEXT, Buffer.from('hello world')));
  for (let cut = 1; cut < full.length; cut++) {
    assert.equal(decodeFrame(full.subarray(0, cut)), null, `partial length ${cut}`);
  }
  assert.ok(decodeFrame(full));
});

test('decodeFrame leaves trailing bytes for the next frame', () => {
  const a = maskAsClient(encodeFrame(OPCODE.TEXT, Buffer.from('one')));
  const b = maskAsClient(encodeFrame(OPCODE.TEXT, Buffer.from('two')));
  const decoded = decodeFrame(Buffer.concat([a, b]));
  assert.equal(decoded.frame.payload.toString(), 'one');
  const next = decodeFrame(decoded.rest);
  assert.equal(next.frame.payload.toString(), 'two');
});

test('decodeFrame rejects protocol violations', () => {
  // Unmasked client frame.
  assert.throws(() => decodeFrame(encodeFrame(OPCODE.TEXT, Buffer.from('x'))), /must be masked/);
  // Oversized control frame.
  const bigPing = maskAsClient(encodeFrame(OPCODE.PING, Buffer.alloc(200)));
  assert.throws(() => decodeFrame(bigPing), /invalid control frame/);
});

test('router matches literals and params without crossing segments', () => {
  assert.deepEqual(matchPath('/v1/models', '/v1/models'), {});
  assert.equal(matchPath('/v1/models', '/v1/model'), null);
  assert.deepEqual(matchPath('/v1/sessions/:id', '/v1/sessions/abc'), { id: 'abc' });
  assert.equal(matchPath('/v1/sessions/:id', '/v1/sessions/abc/reset'), null);
  assert.deepEqual(matchPath('/v1/sessions/:id/reset', '/v1/sessions/a%20b/reset'), { id: 'a b' });
});

test('conversation ids are validated before they reach a Map key or a log', () => {
  assert.equal(sanitizeConversationId('glasses-1'), 'glasses-1');
  assert.equal(sanitizeConversationId(''), '');
  assert.throws(() => sanitizeConversationId('has space'), /conversation id/);
  assert.throws(() => sanitizeConversationId('x'.repeat(200)), /conversation id/);
});

test('buildArgs locks the CLI down by default', () => {
  const agent = {
    name: 'a', description: '', model: 'sonnet', systemPrompt: 'sys', appendSystemPrompt: '',
    tools: [], permissionMode: 'default', workdir: '', addDirs: [], mcpConfig: '', effort: '',
    allowImages: true, prewarm: 0, maxReplyChars: 0, extraArgs: [],
  };
  const args = buildArgs({ agent, sessionId: 'sid', resume: false });

  assert.ok(args.includes('--print'));
  assert.ok(args.includes('--verbose'), 'stream-json output requires --verbose');
  assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', '']);
  assert.deepEqual(args.slice(args.indexOf('--permission-prompts'), args.indexOf('--permission-prompts') + 2), ['--permission-prompts', 'none']);
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--safe-mode'));
  assert.ok(args.includes('--session-id'));
  assert.ok(!args.includes('--resume'));
  assert.ok(!args.includes('--dangerously-skip-permissions'));

  const resumed = buildArgs({ agent, sessionId: 'sid', resume: true });
  assert.deepEqual(resumed.slice(resumed.indexOf('--resume'), resumed.indexOf('--resume') + 2), ['--resume', 'sid']);
  assert.ok(!resumed.includes('--session-id'));
});

test('buildArgs passes an explicit tool allowlist through', () => {
  const agent = {
    name: 'a', description: '', model: 'sonnet', systemPrompt: '', appendSystemPrompt: '',
    tools: ['Read', 'WebSearch'], permissionMode: 'acceptEdits', workdir: '', addDirs: ['/srv/kb'],
    mcpConfig: '', effort: 'low', allowImages: true, prewarm: 0, maxReplyChars: 0, extraArgs: [],
  };
  const args = buildArgs({ agent, sessionId: 'sid', resume: false });
  assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', 'Read,WebSearch']);
  assert.deepEqual(args.slice(args.indexOf('--add-dir'), args.indexOf('--add-dir') + 2), ['--add-dir', '/srv/kb']);
  assert.deepEqual(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2), ['--effort', 'low']);
});

/**
 * Turn a server-encoded frame into a client-encoded (masked) one so the decoder
 * sees what it would see on the wire.
 *
 * @param {Buffer} frame
 */
function maskAsClient(frame) {
  const first = frame[0];
  let len = frame[1] & 0x7f;
  let offset = 2;
  if (len === 126) { len = frame.readUInt16BE(2); offset = 4; }
  else if (len === 127) { len = Number(frame.readBigUInt64BE(2)); offset = 10; }
  const payload = frame.subarray(offset);
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
  const header = Buffer.from(frame.subarray(0, offset));
  header[0] = first;
  header[1] |= 0x80;
  return Buffer.concat([header, mask, masked]);
}

test('ClaudeProcess.start() does not wait for system:init', async () => {
  // With --input-format stream-json the CLI emits system:init only after it has
  // read the first user message. Waiting for it in start() deadlocks: the
  // gateway would be waiting for output that only its own input can trigger.
  const { ClaudeProcess } = await import('../src/claude/process.js');
  const { FAKE_CLAUDE } = await import('./helpers.mjs');

  const proc = new ClaudeProcess({
    bin: FAKE_CLAUDE,
    agent: {
      name: 'default', description: '', model: 'sonnet', systemPrompt: '', appendSystemPrompt: '',
      tools: [], permissionMode: 'default', workdir: '', addDirs: [], mcpConfig: '', effort: '',
      allowImages: true, prewarm: 0, maxReplyChars: 0, extraArgs: [],
    },
    sessionId: '11111111-2222-3333-4444-555555555555',
    cwd: process.cwd(),
    startupTimeoutMs: 10_000,
  });

  await proc.start();
  assert.equal(proc.ready, true);
  assert.equal(proc.initialized, false, 'init has not arrived yet, and must not be required');

  const result = await proc.send([{ type: 'text', text: 'hello' }], { timeoutMs: 10_000 });
  assert.match(result.text, /ECHO\[1\]: hello/);
  assert.equal(proc.initialized, true, 'init arrives with the first turn');
  await proc.close();
});

test('ClaudeProcess.start() still rejects when the CLI dies immediately', async () => {
  const { ClaudeProcess } = await import('../src/claude/process.js');
  const { FAKE_CLAUDE } = await import('./helpers.mjs');

  const saved = process.env.FAKE_CLAUDE_MODE;
  process.env.FAKE_CLAUDE_MODE = 'crash-startup';
  try {
    const proc = new ClaudeProcess({
      bin: FAKE_CLAUDE,
      agent: {
        name: 'default', description: '', model: 'sonnet', systemPrompt: '', appendSystemPrompt: '',
        tools: [], permissionMode: 'default', workdir: '', addDirs: [], mcpConfig: '', effort: '',
        allowImages: true, prewarm: 0, maxReplyChars: 0, extraArgs: [],
      },
      sessionId: '11111111-2222-3333-4444-666666666666',
      cwd: process.cwd(),
      startupTimeoutMs: 10_000,
    });
    await assert.rejects(() => proc.start(), (err) => /startup|refusing/i.test(err.message));
  } finally {
    if (saved === undefined) delete process.env.FAKE_CLAUDE_MODE;
    else process.env.FAKE_CLAUDE_MODE = saved;
  }
});

test('a missing CLI binary is reported as a missing CLI, not a mystery', async () => {
  const { ClaudeProcess } = await import('../src/claude/process.js');
  const proc = new ClaudeProcess({
    bin: '/nonexistent/claude-binary',
    agent: {
      name: 'default', description: '', model: 'sonnet', systemPrompt: '', appendSystemPrompt: '',
      tools: [], permissionMode: 'default', workdir: '', addDirs: [], mcpConfig: '', effort: '',
      allowImages: true, prewarm: 0, maxReplyChars: 0, extraArgs: [],
    },
    sessionId: '11111111-2222-3333-4444-777777777777',
    cwd: process.cwd(),
    startupTimeoutMs: 5000,
  });
  await assert.rejects(
    () => proc.start(),
    // 503, matching /readyz: the gateway cannot serve at all, so a load
    // balancer should take it out of rotation rather than retry into a wall.
    (err) => err.code === 'cli_missing' && err.status === 503 && err.retryAfter > 0,
  );
});
