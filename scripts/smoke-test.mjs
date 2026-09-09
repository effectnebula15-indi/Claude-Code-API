#!/usr/bin/env node
/**
 * Post-install check: proves a running gateway can actually answer.
 *
 *   CCA_URL=http://127.0.0.1:8787 CCA_KEY=cca_xxx node scripts/smoke-test.mjs
 *
 * Unlike `npm test`, this talks to the real Claude CLI, so it spends a small
 * amount of your plan — a couple of very short turns.
 */
const URL_BASE = (process.env.CCA_URL || process.argv[2] || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const KEY = process.env.CCA_KEY || process.argv[3] || '';

let failures = 0;

/** @param {string} name @param {() => Promise<string>} fn */
async function check(name, fn) {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    console.log(`\x1b[32m✓\x1b[0m ${name} \x1b[2m(${Date.now() - startedAt}ms)\x1b[0m${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    failures++;
    console.log(`\x1b[31m✗\x1b[0m ${name} — ${err.message}`);
  }
}

/** @param {string} path @param {RequestInit} [init] */
async function call(path, init = {}) {
  const res = await fetch(`${URL_BASE}${path}`, {
    ...init,
    headers: {
      ...(KEY ? { authorization: `Bearer ${KEY}` } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    const message = json?.error?.message || json?.error || text.slice(0, 300);
    throw new Error(`HTTP ${res.status}: ${message}`);
  }
  return json ?? text;
}

console.log(`checking ${URL_BASE}\n`);

await check('liveness', async () => {
  const body = await call('/healthz');
  if (body.status !== 'ok') throw new Error(`unexpected: ${JSON.stringify(body)}`);
  return '';
});

await check('readiness (CLI installed and authenticated)', async () => {
  const body = await call('/readyz');
  return body.detail || body.status;
});

if (!KEY) {
  console.log('\n\x1b[33m!\x1b[0m no CCA_KEY given — skipping the authenticated checks');
  process.exit(failures ? 1 : 0);
}

await check('agents are listed', async () => {
  const body = await call('/v1/agents');
  return body.data.map((/** @type {any} */ a) => a.name).join(', ');
});

await check('a real turn answers', async () => {
  const body = await call('/v1/ask', {
    method: 'POST',
    body: JSON.stringify({ prompt: 'Reply with exactly the word: pong' }),
  });
  if (!body.text) throw new Error('empty answer');
  return `${JSON.stringify(body.text.slice(0, 40))} in ${body.ms}ms`;
});

await check('conversation state is kept', async () => {
  const conversation = `smoke-${Date.now()}`;
  await call('/v1/ask', {
    method: 'POST',
    body: JSON.stringify({ prompt: 'Remember the number 4242. Reply: ok', conversation }),
  });
  const second = await call('/v1/ask', {
    method: 'POST',
    body: JSON.stringify({ prompt: 'Which number did I ask you to remember? Digits only.', conversation }),
  });
  await call(`/v1/sessions/${conversation}`, { method: 'DELETE' });
  if (!String(second.text).includes('4242')) throw new Error(`the model did not recall it: ${second.text}`);
  return 'recalled across turns';
});

await check('streaming yields speakable sentences', async () => {
  const res = await fetch(`${URL_BASE}/v1/ask`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'Say two very short sentences about the sea.', stream: true }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let sentences = 0;
  let firstAt = 0;
  const startedAt = Date.now();
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const event = JSON.parse(line.slice(5));
      if (event.type === 'sentence' && event.text) {
        sentences++;
        if (!firstAt) firstAt = Date.now() - startedAt;
      }
      if (event.type === 'error') throw new Error(event.message);
    }
  }
  if (!sentences) throw new Error('no sentence events arrived');
  return `${sentences} sentences, first at ${firstAt}ms`;
});

await check('OpenAI compatibility', async () => {
  const body = await call('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'default', messages: [{ role: 'user', content: 'Reply with exactly: ok' }] }),
  });
  if (body.object !== 'chat.completion') throw new Error('wrong response shape');
  return JSON.stringify(body.choices[0].message.content.slice(0, 30));
});

await check('plan usage is visible', async () => {
  const body = await call('/v1/usage');
  const five = body.plan?.windows?.five_hour;
  if (!five) return 'no plan data yet (API key mode?)';
  return `5h window ${(five.utilization * 100).toFixed(1)}% used`;
});

console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32mall good\x1b[0m');
process.exit(failures ? 1 : 0);
