# How it works

## The idea

The Claude Code CLI has a headless mode that speaks newline-delimited JSON on
stdin and stdout:

```bash
claude --print --input-format stream-json --output-format stream-json --verbose
```

Send `{"type":"user","message":{...}}` on stdin, read assistant events on
stdout. The process keeps reading after each answer, so one child process can
serve a whole conversation — and it authenticates with the same subscription
login you already use interactively.

This gateway is the plumbing around that: process lifecycle, HTTP surfaces,
and the rails that keep an automated client from eating the plan.

## Request path

```
HTTP request
  ├─ router            src/server.js        path + method → handler
  ├─ auth              src/auth.js          constant-time key comparison
  ├─ per-key limits    src/ratelimit.js     token bucket + daily cap
  ├─ format decoding   src/messages.js      OpenAI/Anthropic → content blocks
  └─ engine            src/engine.js
       ├─ plan guard                        refuse if the plan window is spent
       ├─ concurrency gate  src/queue.js    FIFO, bounded queue
       ├─ session bind      src/claude/manager.js
       └─ turn              src/claude/process.js  → claude CLI
```

## Files

| File | Responsibility |
|---|---|
| `src/server.js` | HTTP server, routing, CORS, shutdown. |
| `src/engine.js` | The shared pipeline every endpoint runs. |
| `src/config.js` | Environment + `config/agents.json` → one config object. |
| `src/messages.js` | Wire formats ⇄ content blocks; transcript flattening. |
| `src/claude/args.js` | The CLI argv, including the lockdown flags. |
| `src/claude/process.js` | One child process, one conversation, one turn at a time. |
| `src/claude/manager.js` | Warm spares, conversation binding, eviction, resume. |
| `src/queue.js` | Concurrency gate. |
| `src/ratelimit.js` | Per-key limits. |
| `src/ws.js` | RFC 6455 frame codec and connection. |
| `src/routes/*` | One file per API surface. |

## Design decisions

**Zero runtime dependencies.** The gateway hands out access to your Claude
account. A dependency tree is attack surface, and "clone and run" is the whole
promise of the project. Node 20 already has an HTTP server, a streaming JSON
parser and crypto; the only thing genuinely missing is a WebSocket
implementation, which is ~250 lines in `src/ws.js` and is unit-tested against
the RFC's own example vectors.

**One process per conversation, not per request.** Starting the CLI costs one
to two seconds. Keeping the process warm makes a follow-up question feel
instant, keeps prompt caching effective (which is what actually conserves the
plan window), and lets Claude hold the history so clients need not resend it.

**Conversations outlive their processes.** The `conversation id → Claude session
id` map is persisted to disk. An idle process is released after
`SESSION_IDLE_MS` to free memory, a crashed one is not mourned, and the next
request re-attaches with `--resume`. A gateway restart does not lose context.

**Tools are off by default.** `--tools ""` plus `--safe-mode` and
`--strict-mcp-config` means an agent is a chat model with no shell, no file
access and no host configuration. Anything more is opt-in per agent, in the
config file, by someone who meant it.

**Backpressure over parallelism.** A subscription is a single small resource.
Running many turns at once does not finish them sooner; it just makes everyone
slow and empties the window faster. So: a small concurrency limit, a bounded
FIFO queue, and a fast 503 when the queue is full.

**The plan window is a first-class signal.** The CLI emits `rate_limit_event`
with real utilisation for the 5-hour and weekly windows. The gateway records it,
serves it on `/v1/usage` and `/metrics`, and refuses new turns past
`USAGE_GUARD` — so a runaway bot cannot lock you out of your own Claude.

**Sentences, not tokens, for speech.** `src/routes/simple.js` buffers deltas
until a real sentence boundary. A wearable can start speaking the first sentence
while the model writes the second, which is the difference between a usable
assistant and an awkward one.

## Testing

`test/fake-claude.mjs` is a stand-in CLI speaking the same stream-json protocol,
with modes for crashes, slowness, errors and an exhausted plan. The E2E suite
boots the real server against it, so routing, streaming, conversation state,
cancellation, timeouts, rate limiting and the WebSocket protocol are all covered
without spending tokens.

`npm run typecheck` runs TypeScript over the JSDoc annotations — full checking,
no build step.
