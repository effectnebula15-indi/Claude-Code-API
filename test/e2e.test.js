/**
 * End-to-end tests against a real gateway process wired to the fake CLI.
 * Covers routing, auth, both wire formats, streaming, conversations,
 * cancellation, plan-window guarding and the WebSocket protocol.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startGateway, request, sse, wsConnect, TEST_KEY, ADMIN_KEY } from './helpers.mjs';

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('health and index need no credentials', async (t) => {
  const gw = await startGateway();
  t.after(() => gw.close());

  const health = await request(`${gw.url}/healthz`, { key: null });
  assert.equal(health.status, 200);
  assert.equal(health.json.status, 'ok');

  const index = await request(`${gw.url}/`, { key: null });
  assert.equal(index.status, 200);
  assert.match(index.text, /\/v1\/chat\/completions/);

  const ready = await request(`${gw.url}/readyz`, { key: null });
  assert.equal(ready.status, 200);
});

test('every /v1 route rejects a missing or wrong key', async (t) => {
  const gw = await startGateway();
  t.after(() => gw.close());

  for (const path of ['/v1/models', '/v1/usage', '/v1/agents']) {
    const anon = await request(`${gw.url}${path}`, { key: null });
    assert.equal(anon.status, 401, `${path} without a key`);
    assert.match(String(anon.headers.get('www-authenticate')), /Bearer/);

    const wrong = await request(`${gw.url}${path}`, { key: 'not-the-key' });
    assert.equal(wrong.status, 401, `${path} with a wrong key`);
  }

  const ok = await request(`${gw.url}/v1/models`);
  assert.equal(ok.status, 200);
});

test('unknown paths 404 and wrong methods 405', async (t) => {
  const gw = await startGateway();
  t.after(() => gw.close());

  assert.equal((await request(`${gw.url}/v1/nope`)).status, 404);
  assert.equal((await request(`${gw.url}/v1/models`, { method: 'POST', body: {} })).status, 405);
});

test('models list exposes agents and bare aliases', async (t) => {
  const gw = await startGateway();
  t.after(() => gw.close());

  const res = await request(`${gw.url}/v1/models`);
  const ids = res.json.data.map((/** @type {any} */ m) => m.id);
  assert.ok(ids.includes('default'));
  assert.ok(ids.includes('sonnet'));
});

test('OpenAI chat completion returns a well-formed non-streaming response', async (t) => {
  const gw = await startGateway();
  t.after(() => gw.close());

  const res = await request(`${gw.url}/v1/chat/completions`, {
    body: { model: 'default', messages: [{ role: 'user', content: 'hello there' }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.object, 'chat.completion');
  assert.equal(res.json.choices[0].message.role, 'assistant');
  assert.match(res.json.choices[0].message.content, /ECHO\[1\]: hello there/);
  assert.equal(res.json.choices[0].finish_reason, 'stop');
  assert.ok(res.json.usage.total_tokens > 0);
  assert.ok(res.json.usage.prompt_tokens > 0);
});

test('OpenAI streaming emits role, deltas and a terminating chunk', async (t) => {
  const gw = await startGateway();
  t.after(() => gw.close());

  const { status, events } = await sse(`${gw.url}/v1/chat/completions`, {
    body: { model: 'default', messages: [{ role: 'user', content: 'stream me please' }], stream: true },
  });
  assert.equal(status, 200);
  assert.equal(events.at(-1), '[DONE]');

  const chunks = events.filter((e) => e !== '[DONE]');
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  const text = chunks.map((c) => c.choices[0].delta.content || '').join('');
  assert.match(text, /ECHO\[1\]: stream me please/);

  const final = chunks.at(-1);
  assert.equal(final.choices[0].finish_reason, 'stop');
  assert.ok(final.usage.completion_tokens > 0);
});

test('a system message is honoured and the transcript is flattened statelessly', async (t) => {
  const gw = await startGateway();
  t.after(() => gw.close());

  const res = await request(`${gw.url}/v1/chat/completions`, {
    body: {
      model: 'default',
      messages: [
        { role: 'system', content: 'BE-TERSE' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answered' },
        { role: 'user', content: 'second' },
      ],
    },
  });
  const echoed = res.json.choices[0].message.content;
  assert.match(echoed, /BE-TERSE/, 'system prompt reaches the model');
  assert.match(echoed, /User: first/, 'history is replayed in stateless mode');
  assert.match(echoed, /User: second/);
});

test('a resent system prompt is delivered once per conversation, not every turn', async (t) => {
  const gw = await startGateway();
  t.after(() => gw.close());

  const headers = { 'x-conversation-id': 'sys-once' };
  const send = (/** @type {string} */ question) =>
    request(`${gw.url}/v1/chat/completions`, {
      headers,
      body: {
        model: 'default',
        messages: [
          { role: 'system', content: 'BE-TERSE' },
          { role: 'user', content: question },
        ],
      },
    });

  const first = await send('one');
  assert.match(first.json.choices[0].message.content, /BE-TERSE/, 'the opening turn carries it');

  const second = await send('two');
  assert.doesNotMatch(
    second.json.choices[0].message.content,
    /BE-TERSE/,
    'a later turn must not repeat the system prompt into the conversation',
  );
});

test('a conversation id keeps context on the server and sends only the new turn', async (t) => {
  const gw = await startGateway({ FAKE_CLAUDE_MODE: 'memory' });
  t.after(() => gw.close());

  const first = await request(`${gw.url}/v1/chat/completions`, {
    headers: { 'x-conversation-id': 'conv-1' },
    body: { model: 'default', messages: [{ role: 'user', content: 'one' }] },
  });
  assert.match(first.json.choices[0].message.content, /turn=1/);

  const second = await request(`${gw.url}/v1/chat/completions`, {
    headers: { 'x-conversation-id': 'conv-1' },
    body: {
      model: 'default',
      messages: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'turn=1 history=1' },
        { role: 'user', content: 'two' },
      ],
    },
  });
  // Same CLI process, so the turn counter advanced instead of resetting.
  assert.match(second.json.choices[0].message.content, /turn=2/);

  // A different conversation id gets its own process and starts from scratch.
  const other = await request(`${gw.url}/v1/chat/completions`, {
    headers: { 'x-conversation-id': 'conv-2' },
    body: { model: 'default', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.match(other.json.choices[0].message.content, /turn=1/);
});

test('deleting a conversation makes the next call start over', async (t) => {
  const gw = await startGateway({ FAKE_CLAUDE_MODE: 'memory' });
  t.after(() => gw.close());

  const body = { model: 'default', messages: [{ role: 'user', content: 'x' }] };
  const headers = { 'x-conversation-id': 'conv-reset' };
  await request(`${gw.url}/v1/chat/completions`, { headers, body });
  const before = await request(`${gw.url}/v1/chat/completions`, { headers, body });
  assert.match(before.json.choices[0].message.content, /turn=2/);

  const del = await request(`${gw.url}/v1/sessions/conv-reset`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal(del.json.deleted, true);

  const after = await request(`${gw.url}/v1/chat/completions`, { headers, body });
  assert.match(after.json.choices[0].message.content, /turn=1/);
});

test('Anthropic /v1/messages works non-streaming and streaming', async (t) => {
  const gw = await startGateway();
  t.after(() => gw.close());

  const res = await request(`${gw.url}/v1/messages`, {
    body: { model: 'default', max_tokens: 100, system: 'SYS', messages: [{ role: 'user', content: 'anthropic hi' }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.type, 'message');
  assert.equal(res.json.content[0].type, 'text');
  assert.match(res.json.content[0].text, /SYS/);
  assert.equal(res.json.stop_reason, 'end_turn');

  const stream = await sse(`${gw.url}/v1/messages`, {
    body: { model: 'default', max_tokens: 100, messages: [{ role: 'user', content: 'stream' }], stream: true },
  });
  const types = stream.events.map((/** @type {any} */ e) => e.type);
  assert.deepEqual(types.slice(0, 2), ['message_start', 'content_block_start']);
  assert.ok(types.includes('content_block_delta'));
  assert.deepEqual(types.slice(-3), ['content_block_stop', 'message_delta', 'message_stop']);
});

test('x-api-key authenticates, as the Anthropic SDKs send it', async (t) => {
  const gw = await startGateway();
  t.after(() => gw.close());

  const res = await request(`${gw.url}/v1/messages`, {
    key: null,
    headers: { 'x-api-key': TEST_KEY },
    body: { model: 'default', max_tokens: 10, messages: [{ role: 'user', content: 'via x-api-key' }] },
  });
  assert.equal(res.status, 200);
});

test('/v1/ask answers plainly and streams sentence by sentence', async (t) => {
  const gw = await startGateway();
  t.after(() => gw.close());

  const plain = await request(`${gw.url}/v1/ask`, { body: { prompt: 'how far is the moon' } });
  assert.equal(plain.status, 200);
  assert.match(plain.json.text, /ECHO\[1\]: how far is the moon/);
  assert.equal(plain.json.agent, 'default');
  assert.ok(plain.json.usage.output_tokens > 0);

  const streamed = await sse(`${gw.url}/v1/ask`, {
    body: { prompt: 'First sentence here. Second sentence here.', stream: true },
  });
  const kinds = streamed.events.map((/** @type {any} */ e) => e.type);
  assert.ok(kinds.includes('delta'));
  assert.ok(kinds.includes('sentence'), 'a speech client needs whole sentences');
  const done = streamed.events.at(-1);
  assert.equal(done.type, 'done');
  assert.ok(done.text.length > 0);
});

test('/v1/ask accepts an image for the glasses camera path', async (t) => {
  const gw = await startGateway();
  t.after(() => gw.close());

  const res = await request(`${gw.url}/v1/ask`, { body: { prompt: 'what is this', image: PNG_1PX } });
  assert.equal(res.status, 200);
  assert.match(res.json.text, /img=1/, 'the image block reached the CLI');

  const bare = await request(`${gw.url}/v1/ask`, {
    body: { prompt: 'raw base64', image: PNG_1PX.split(',')[1], image_media_type: 'image/png' },
  });
  assert.equal(bare.status, 200);
  assert.match(bare.json.text, /img=1/);
});

test('bad requests are rejected with a useful message, not a 500', async (t) => {
  const gw = await startGateway();
  t.after(() => gw.close());

  const noMessages = await request(`${gw.url}/v1/chat/completions`, { body: { model: 'default' } });
  assert.equal(noMessages.status, 400);
  assert.match(noMessages.json.error.message, /messages/);

  const badRole = await request(`${gw.url}/v1/chat/completions`, {
    body: { model: 'default', messages: [{ role: 'wizard', content: 'hi' }] },
  });
  assert.equal(badRole.status, 400);

  const remoteImage = await request(`${gw.url}/v1/ask`, {
    body: { prompt: 'x', image: 'https://example.com/a.png' },
  });
  assert.equal(remoteImage.status, 400);
  assert.match(remoteImage.json.error, /data:/);

  const unknownAgent = await request(`${gw.url}/v1/ask`, { body: { prompt: 'x', agent: 'agent:ghost' } });
  assert.equal(unknownAgent.status, 404);

  const badConversation = await request(`${gw.url}/v1/ask`, { body: { prompt: 'x', conversation: 'bad id!' } });
  assert.equal(badConversation.status, 400);
});

test('an oversized prompt is refused before a process is spawned', async (t) => {
  const gw = await startGateway({ MAX_INPUT_CHARS: '50' });
  t.after(() => gw.close());

  const res = await request(`${gw.url}/v1/ask`, { body: { prompt: 'x'.repeat(500) } });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /limit is 50/);
  assert.equal(gw.engine.sessions.stats().conversations, 0);
});

test('gateway rate limiting returns 429 with Retry-After', async (t) => {
  const gw = await startGateway({ RATE_LIMIT_RPM: '1' });
  t.after(() => gw.close());

  assert.equal((await request(`${gw.url}/v1/ask`, { body: { prompt: 'first' } })).status, 200);
  const limited = await request(`${gw.url}/v1/ask`, { body: { prompt: 'second' } });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);

  // Reads must keep working while writes are throttled.
  assert.equal((await request(`${gw.url}/v1/usage`)).status, 200);
});

test('the plan-window guard refuses work when the subscription is nearly spent', async (t) => {
  const gw = await startGateway({ FAKE_CLAUDE_MODE: 'ratelimit', USAGE_GUARD: '0.9' });
  t.after(() => gw.close());

  // The first call is what teaches the gateway how full the window is.
  assert.equal((await request(`${gw.url}/v1/ask`, { body: { prompt: 'one' } })).status, 200);

  const blocked = await request(`${gw.url}/v1/ask`, { body: { prompt: 'two' } });
  assert.equal(blocked.status, 429);
  assert.match(blocked.json.error, /5-hour window/);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);

  const usage = await request(`${gw.url}/v1/usage`);
  assert.ok(usage.json.plan.windows.five_hour.utilization > 0.9);
});

test('a CLI failure surfaces as a clean error, not a hang', async (t) => {
  const gw = await startGateway({ FAKE_CLAUDE_MODE: 'error' });
  t.after(() => gw.close());

  const res = await request(`${gw.url}/v1/ask`, { body: { prompt: 'boom' } });
  assert.equal(res.status, 502);
  assert.match(res.json.error, /fake failure/);
});

test('a CLI that cannot start reports why', async (t) => {
  const gw = await startGateway({ FAKE_CLAUDE_MODE: 'crash-startup' });
  t.after(() => gw.close());

  const res = await request(`${gw.url}/v1/ask`, { body: { prompt: 'hi' } });
  assert.equal(res.status, 502);
  assert.match(res.json.error, /startup|refusing/i);
});

test('a turn that outlives its timeout is cut off', async (t) => {
  const gw = await startGateway({ FAKE_CLAUDE_MODE: 'slow', TURN_TIMEOUT_MS: '1200' });
  t.after(() => gw.close());

  const res = await request(`${gw.url}/v1/ask`, { body: { prompt: 'this reply will never finish in time' } });
  assert.equal(res.status, 504);
  assert.match(res.json.error, /exceeded/);
});

test('usage and metrics report real activity', async (t) => {
  const gw = await startGateway({ PUBLIC_METRICS: '1' });
  t.after(() => gw.close());

  await request(`${gw.url}/v1/ask`, { body: { prompt: 'count me' } });

  const usage = await request(`${gw.url}/v1/usage`);
  assert.equal(usage.status, 200);
  assert.equal(usage.json.gateway.turns, 1);
  assert.ok(usage.json.plan.windows.five_hour);

  const metrics = await request(`${gw.url}/metrics`, { key: null });
  assert.equal(metrics.status, 200);
  assert.match(metrics.text, /cca_turns_total\{agent="default"\} 1/);
  assert.match(metrics.text, /cca_subscription_utilization\{window="five_hour"\}/);
});

test('metrics and session listing require the admin key by default', async (t) => {
  const gw = await startGateway();
  t.after(() => gw.close());

  assert.equal((await request(`${gw.url}/metrics`)).status, 403);
  assert.equal((await request(`${gw.url}/v1/sessions`)).status, 403);

  assert.equal((await request(`${gw.url}/metrics`, { key: ADMIN_KEY })).status, 200);
  const sessions = await request(`${gw.url}/v1/sessions`, { key: ADMIN_KEY });
  assert.equal(sessions.status, 200);
  assert.ok(Array.isArray(sessions.json.data));
});

test('a key scoped to one agent cannot reach another', async (t) => {
  const gw = await startGateway({
    API_KEYS: '',
    API_KEYS_FILE: await writeKeyFile([
      { name: 'device', key: 'device-key', agents: ['default'] },
      { name: 'other', key: 'other-key', agents: ['nonexistent'] },
    ]),
  });
  t.after(() => gw.close());

  assert.equal((await request(`${gw.url}/v1/ask`, { key: 'device-key', body: { prompt: 'ok' } })).status, 200);
  const denied = await request(`${gw.url}/v1/ask`, { key: 'other-key', body: { prompt: 'nope' } });
  assert.equal(denied.status, 403);
});

test('concurrency is capped and the queue is bounded', async (t) => {
  const gw = await startGateway({ FAKE_CLAUDE_MODE: 'slow', MAX_CONCURRENCY: '1', QUEUE_MAX: '1', TURN_TIMEOUT_MS: '30000' });
  t.after(() => gw.close());

  const body = { prompt: 'a b c d e' };
  const inFlight = request(`${gw.url}/v1/ask`, { body });
  await new Promise((r) => setTimeout(r, 400));
  const queued = request(`${gw.url}/v1/ask`, { body });
  await new Promise((r) => setTimeout(r, 200));
  const rejected = await request(`${gw.url}/v1/ask`, { body });

  assert.equal(rejected.status, 503);
  assert.match(rejected.json.error, /capacity/);
  assert.ok(Number(rejected.headers.get('retry-after')) > 0);

  assert.equal((await inFlight).status, 200);
  assert.equal((await queued).status, 200);
});

test('a client that hangs up mid-turn frees the slot instead of leaking it', async (t) => {
  const gw = await startGateway({ FAKE_CLAUDE_MODE: 'slow', MAX_CONCURRENCY: '1', TURN_TIMEOUT_MS: '30000' });
  t.after(() => gw.close());

  const ac = new AbortController();
  const pending = fetch(`${gw.url}/v1/ask`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TEST_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'one two three four five' }),
    signal: ac.signal,
  }).catch(() => 'aborted');

  await new Promise((r) => setTimeout(r, 500));
  assert.equal(gw.engine.gate.active, 1);
  ac.abort();
  assert.equal(await pending, 'aborted');

  await new Promise((r) => setTimeout(r, 300));
  assert.equal(gw.engine.gate.active, 0, 'the concurrency slot must be released');
});

test('websocket: handshake, streaming answer and per-socket conversation', async (t) => {
  const gw = await startGateway({ FAKE_CLAUDE_MODE: 'memory' });
  t.after(() => gw.close());

  const ws = await wsConnect(gw.url, `/v1/ws?key=${TEST_KEY}&conversation=glass-1`);
  t.after(() => ws.close());

  const ready = await ws.next((m) => m.type === 'ready');
  assert.ok(ready.agents.includes('default'));

  ws.send({ type: 'ask', id: 'q1', prompt: 'hello glasses' });
  const done = await ws.next((m) => m.type === 'done' && m.id === 'q1');
  assert.match(done.text, /turn=1/);
  assert.equal(done.conversation, 'glass-1');

  ws.send({ type: 'ask', id: 'q2', prompt: 'again' });
  const done2 = await ws.next((m) => m.type === 'done' && m.id === 'q2');
  assert.match(done2.text, /turn=2/, 'the socket keeps one warm conversation');

  ws.send({ type: 'ping', id: 'p' });
  assert.equal((await ws.next((m) => m.type === 'pong')).id, 'p');

  ws.send({ type: 'reset', conversation: 'glass-1' });
  await ws.next((m) => m.type === 'reset');
  ws.send({ type: 'ask', id: 'q3', prompt: 'after reset' });
  assert.match((await ws.next((m) => m.type === 'done' && m.id === 'q3')).text, /turn=1/);
});

test('websocket rejects an unauthenticated handshake', async () => {
  const gw = await startGateway();
  try {
    await assert.rejects(() => wsConnect(gw.url, '/v1/ws'), /401/);
    await assert.rejects(() => wsConnect(gw.url, '/v1/ws?key=wrong'), /401/);
  } finally {
    await gw.close();
  }
});

test('websocket cancel stops a long answer', async (t) => {
  const gw = await startGateway({ FAKE_CLAUDE_MODE: 'slow', TURN_TIMEOUT_MS: '30000' });
  t.after(() => gw.close());

  const ws = await wsConnect(gw.url, `/v1/ws?key=${TEST_KEY}`);
  t.after(() => ws.close());
  await ws.next((m) => m.type === 'ready');

  ws.send({ type: 'ask', id: 'long', prompt: 'one two three four five six' });
  await ws.next((m) => m.type === 'delta');
  ws.send({ type: 'cancel', id: 'long' });
  await ws.next((m) => m.type === 'cancelled');

  // The socket is usable again straight away.
  ws.send({ type: 'ping', id: 'after-cancel' });
  assert.equal((await ws.next((m) => m.type === 'pong')).id, 'after-cancel');
});

test('websocket refuses a second question while one is in flight', async (t) => {
  const gw = await startGateway({ FAKE_CLAUDE_MODE: 'slow', TURN_TIMEOUT_MS: '30000' });
  t.after(() => gw.close());

  const ws = await wsConnect(gw.url, `/v1/ws?key=${TEST_KEY}`);
  t.after(() => ws.close());
  await ws.next((m) => m.type === 'ready');

  ws.send({ type: 'ask', id: 'a', prompt: 'one two three four' });
  await ws.next((m) => m.type === 'delta');
  ws.send({ type: 'ask', id: 'b', prompt: 'jump the queue' });
  const err = await ws.next((m) => m.type === 'error');
  assert.equal(err.code, 'busy');
});

test('conversations survive a gateway restart via the on-disk mapping', async (t) => {
  const first = await startGateway({ FAKE_CLAUDE_MODE: 'memory' });
  const dataDir = first.dataDir;

  const before = await request(`${first.url}/v1/ask`, { body: { prompt: 'before restart', conversation: 'durable' } });
  assert.match(before.json.text, /turn=1/);
  assert.equal(first.engine.sessions.list().length, 1);
  // stop() flushes the debounced session store to disk.
  await first.close({ keepData: true });

  const second = await startGateway({ FAKE_CLAUDE_MODE: 'memory', DATA_DIR: dataDir });
  t.after(() => second.close());

  const restored = second.engine.sessions.list();
  assert.equal(restored.length, 1, 'the conversation mapping is reloaded from disk');
  assert.equal(restored[0].id, 'durable');
  assert.equal(restored[0].alive, false, 'no process is spawned until the next turn');

  // The next turn resumes that Claude session rather than starting a new one.
  const after = await request(`${second.url}/v1/ask`, { body: { prompt: 'after restart', conversation: 'durable' } });
  assert.equal(after.status, 200);
  assert.equal(second.engine.sessions.list()[0].alive, true);
});

/** @param {any[]} keys */
async function writeKeyFile(keys) {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cca-keys-')), 'keys.json');
  fs.writeFileSync(file, JSON.stringify({ keys }));
  return file;
}
