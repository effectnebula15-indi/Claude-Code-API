#!/usr/bin/env node
/**
 * A stand-in for the real `claude` CLI.
 *
 * It speaks the same stream-json protocol, which lets the whole gateway be
 * tested end to end — routing, streaming, sessions, cancellation, error
 * mapping — without spending a single token of anyone's plan.
 *
 * Behaviour is steered by FAKE_CLAUDE_MODE:
 *   ok (default)   echo the prompt back, one word per delta
 *   slow           1s between deltas, for timeout and cancellation tests
 *   crash-startup  exit before emitting system:init
 *   crash-midturn  exit while answering
 *   error          return a result with is_error
 *   ratelimit      report a nearly exhausted plan window
 */
import readline from 'node:readline';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('9.9.9 (Fake Claude)\n');
  process.exit(0);
}

/** @param {string} name */
function arg(name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

const mode = process.env.FAKE_CLAUDE_MODE || 'ok';
const sessionId = arg('--resume') || arg('--session-id') || crypto.randomUUID();
const model = arg('--model') || 'sonnet';
const systemPrompt = arg('--system-prompt') || '';

if (mode === 'crash-startup') {
  process.stderr.write('fake: refusing to start\n');
  process.exit(3);
}

const emit = (obj) => process.stdout.write(JSON.stringify({ ...obj, session_id: sessionId }) + '\n');

// The real CLI emits a couple of housekeeping lines shortly after boot, and
// then stays quiet: with --input-format stream-json it does NOT emit
// system:init until it has read the first user message. The gateway's start-up
// logic depends on that, so the fake reproduces it exactly.
emit({ type: 'active_goal', value: null });
emit({ type: 'autocompact_state', value: { enabled: true, effective_window: 980000 } });

let initialised = false;
function emitInit() {
  if (initialised) return;
  initialised = true;
  emit({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    model,
    tools: (arg('--tools') || '').split(',').filter(Boolean),
    permissionMode: 'default',
    apiKeySource: 'none',
    claude_code_version: '9.9.9',
    // Echoed back so tests can assert the gateway locked the CLI down.
    _args: argv,
    _system_prompt_len: systemPrompt.length,
  });
  emitRateLimit();
}

function emitRateLimit() {
  emit({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: mode === 'ratelimit' ? 'allowed' : 'allowed',
    resetsAt: Math.floor(Date.now() / 1000) + 3600,
    unifiedWindows: {
      five_hour: { utilization: mode === 'ratelimit' ? 0.995 : 0.05, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
      seven_day: { utilization: 0.2, resetsAt: Math.floor(Date.now() / 1000) + 86400 },
    },
  },
  });
}

let turn = 0;
/** @type {string[]} */
const memory = [];

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type !== 'user') return;

  emitInit();
  turn += 1;
  const blocks = msg.message?.content || [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const images = blocks.filter((b) => b.type === 'image').length;
  memory.push(text);

  const reply =
    mode === 'memory'
      ? `turn=${turn} history=${memory.length}`
      : `ECHO[${turn}${images ? `,img=${images}` : ''}]: ${text}`;

  emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_fake', model, role: 'assistant', content: [] } } });
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });

  const words = reply.split(' ');
  for (let i = 0; i < words.length; i++) {
    if (mode === 'crash-midturn' && i === 1) process.exit(4);
    if (mode === 'slow') await sleep(1000);
    const chunk = i === 0 ? words[i] : ` ${words[i]}`;
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } } });
  }

  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  emit({ type: 'stream_event', event: { type: 'message_stop' } });

  if (mode === 'error') {
    emit({
      type: 'result', subtype: 'error_during_execution', is_error: true,
      result: 'fake failure', duration_ms: 1, num_turns: turn, api_error_status: null,
    });
    return;
  }

  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: reply,
    stop_reason: 'end_turn',
    duration_ms: 5,
    num_turns: turn,
    total_cost_usd: 0.001,
    usage: {
      input_tokens: 10 + text.length,
      output_tokens: reply.length,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 1,
    },
  });
});

rl.on('close', () => process.exit(0));

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
