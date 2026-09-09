# Troubleshooting

Start here:

```bash
curl -s http://127.0.0.1:8787/readyz | python3 -m json.tool
docker compose logs --tail=100
```

`/readyz` tells you whether the CLI is installed and runnable; the logs are
one JSON object per line.

---

### `claude CLI is not authenticated`

The gateway starts fine but every turn fails with 502.

```bash
./scripts/login.sh
# or, anywhere you already use Claude Code:
claude setup-token     # → CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-… in .env
docker compose up -d
```

Check the token actually reached the container:

```bash
docker compose exec api sh -c 'echo ${CLAUDE_CODE_OAUTH_TOKEN:+token is set}'
```

### `claude CLI not found`

Docker: rebuild (`docker compose build --no-cache`). Bare metal:
`npm i -g @anthropic-ai/claude-code`, or point `CLAUDE_BIN` at the binary —
`which claude`.

### `No API keys configured` on startup

Deliberate: the service refuses to start without authentication. Set `API_KEYS`
in `.env`, or `ALLOW_ANONYMOUS=1` if the port is genuinely private.

### 429 `plan_window_guard`

Not a bug — your Claude plan window is nearly spent. `Retry-After` says when it
resets, and `/v1/usage` shows exactly how much is left. If you want to spend the
last few percent, raise `USAGE_GUARD` (`0.98` → `0.995`).

Burning the window faster than expected? Almost always one of:

* **Stateless calls.** Without a conversation id every request resends the whole
  history and re-primes the cache. Pass `X-Conversation-Id`.
* **Too big a model.** `haiku` is plenty for classification and routing; put it
  on a dedicated agent (see `vpn-triage`).
* **A retry loop.** A client that retries on 429 without honouring `Retry-After`
  turns one refusal into hundreds.

### 503 `queue_full` / `queue_timeout`

More callers than `MAX_CONCURRENCY` can serve. Raise it only if your plan can
take it — 2–3 is realistic. Otherwise raise `QUEUE_MAX` so callers wait instead
of failing, and make clients honour `Retry-After`.

### 504 `turn_timeout`

The turn ran past `TURN_TIMEOUT_MS`. The process is killed and the conversation
resumes on the next request. Long research-style answers may legitimately need
more than the default 300s.

### Streaming arrives all at once

A buffering proxy. nginx needs:

```nginx
proxy_buffering off;
proxy_read_timeout 600s;
proxy_set_header Connection '';
proxy_http_version 1.1;
```

The bundled Caddy config already sets `flush_interval -1`. The gateway sends
`X-Accel-Buffering: no` and a heartbeat comment every 15s.

### WebSocket connects and immediately closes

* **401**: pass `?key=…` — browsers cannot set an `Authorization` header on a
  handshake.
* Behind nginx, WebSockets need the upgrade headers:

  ```nginx
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  ```

* Code `1001 server shutting down` means the gateway restarted. Reconnect.

### `conversation is already handling a turn` (409)

Two requests hit the same conversation id at once. Serialise per conversation,
or give the second caller its own id.

### Memory keeps climbing

Each live conversation is a Node process holding a model context. Lower
`MAX_SESSIONS`, shorten `SESSION_IDLE_MS`, or raise `MEM_LIMIT`. `/v1/usage`
reports `sessions.alive`.

### Answers are too long, or full of markdown

That is the agent's system prompt talking. For anything spoken aloud, copy the
`glasses` profile: it forbids markdown and caps the reply. `max_reply_chars` is
a hard backstop, but a prompt that asks for brevity works better than truncation.

### The support bot invents prices

Fill in the `{{PLACEHOLDER}}`s in `config/prompts/vpn-support.md`. Until they
are replaced the prompt tells the model to treat them as unknown — but a prompt
full of placeholders is still a prompt full of nothing. Facts the model must not
guess belong in that file, spelled out.

### `claude did not start within 60000ms`

The CLI process could not reach its ready state in time. On a small or cold VPS
the first start after boot can genuinely take longer than the default — raise
`STARTUP_TIMEOUT_MS` (e.g. `120000`) and see whether it settles once warm. If it
times out consistently, run the CLI by hand to see what it is waiting on:

```bash
docker compose exec api claude --version
docker compose exec api claude -p 'say hi' --output-format json --verbose
```

A prewarm failure logged at startup (`prewarm failed`) is not fatal: the gateway
still answers, it just pays the start-up cost on the first request.

### Everything is slow to start

The first request pays the CLI's start-up. Set `"prewarm": 1` on the agents that
need to feel instant — that keeps a process ready and running.
