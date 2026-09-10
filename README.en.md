# claude-code-api

**A self-hosted HTTP API for Claude that runs on your subscription instead of
pay-per-token API credits.**

The gateway runs the real `claude` CLI in headless mode and exposes it as an
ordinary OpenAI- and Anthropic-compatible endpoint. Anything that already speaks
OpenAI works against your subscription with a `base_url` change.

Built around two concrete jobs: **DIY smart glasses** (voice, camera frames, low
latency) and **automated first-line support** (Telegram, conversation state,
escalation to a human).

```
device / bot  ──HTTP/WS──▶  claude-code-api  ──stdin/stdout──▶  claude CLI  ──▶  Claude
                                  │
                          limits, queue,
                          keys, conversations
```

* Zero runtime dependencies — Node 20+ and the CLI. `npm install` installs nothing.
* One config file, one `docker compose up`.
* 65 tests, including a full end-to-end run against a fake CLI.

*(Русская версия: [README.md](README.md))*

---

## Read this first

The gateway talks to Claude under your subscription, which brings two
constraints worth knowing up front:

1. **Plan limits are shared.** Your plan has a 5-hour and a weekly window. A bot
   answering customers eats the same window as your own interactive Claude Code.
   The gateway sees this (the CLI reports real utilisation) and refuses new work
   at `USAGE_GUARD=0.98` so automation cannot drain the window entirely.
2. **Consumer plans are meant for personal use.** Your own glasses are exactly
   that. Public-facing support for paying customers is a grey area — check
   Anthropic's Usage Policy and Consumer Terms before shipping, because the
   supported path for a product is the paid API. Technically the gateway does
   both: put `ANTHROPIC_API_KEY` in `.env` and the CLI uses the API instead,
   with no other changes.

---

## Quick start

```bash
curl -fsSL https://raw.githubusercontent.com/effectnebula15-indi/Claude-Code-API/main/install.sh | bash
```

Clones to `~/claude-code-api`, generates a `.env` with fresh API keys, and tells
you what is left to do. It never overwrites an existing `.env`.

Manually:

```bash
git clone https://github.com/effectnebula15-indi/Claude-Code-API.git
cd Claude-Code-API
cp .env.example .env

./scripts/login.sh          # runs `claude setup-token`, writes the token to .env
docker compose up -d
```

`claude setup-token` opens a browser login and prints a long-lived token; put it
in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`. (Alternatively mount an already
logged-in `~/.claude` into the container — the token is sturdier.)

Check it:

```bash
curl http://127.0.0.1:8787/v1/ask \
  -H "Authorization: Bearer $YOUR_KEY" -H 'Content-Type: application/json' \
  -d '{"prompt":"Say hello in one sentence"}'
```

### HTTPS

```bash
# .env: DOMAIN=api.example.com  ACME_EMAIL=you@example.com
docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d
```

Caddy handles certificates. The gateway port stops being published; only 80/443
are exposed.

### Without Docker

```bash
npm i -g @anthropic-ai/claude-code
node src/server.js
```

A hardened systemd unit is in `deploy/claude-code-api.service`.

---

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/chat/completions` | OpenAI-compatible, SSE streaming. |
| `POST` | `/v1/messages` | Anthropic-compatible, for the official SDKs. |
| `POST` | `/v1/ask` | Simple prompt → answer, for devices and bots. |
| `WS` | `/v1/ws` | Long-lived socket: sentence streaming, cancellation. |
| `GET` | `/v1/models` · `/v1/agents` | What you can call. |
| `GET` | `/v1/usage` | How much of the plan window is gone. |
| `DELETE` | `/v1/sessions/{id}` | End a conversation. |
| `GET` | `/healthz` · `/readyz` · `/metrics` | Monitoring, Prometheus. |

One-page cheat sheet: [docs/CHEATSHEET.md](docs/CHEATSHEET.md) (Russian).
Full reference: [docs/API.md](docs/API.md).

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="cca_your_key")
reply = client.chat.completions.create(
    model="glasses",                       # an agent name, not a model name
    messages=[{"role": "user", "content": "How far is the moon?"}],
)
```

Open WebUI, LibreChat, n8n, Home Assistant and anything else that takes an
"OpenAI-compatible endpoint" work the same way.

---

## Conversations

**Stateless** (default): the client sends the whole history each time, as OpenAI
clients do. Works with any software, but resends everything.

**Stateful**: pass a conversation id — `X-Conversation-Id`, a body field, or
`?conversation=` on the WebSocket. Then Claude holds the history, only the new
turn travels, the CLI process stays warm, and prompt caching keeps the plan
window from draining. This is the mode for glasses and for support bots.

The `conversation id → Claude session id` map is persisted, so a gateway restart
resumes rather than forgetting.

---

## Agents

An agent is a named profile: system prompt, model, tool policy, reply length.
They live in `config/agents.json` and need no rebuild.

| Agent | For |
|---|---|
| `default` | General assistant. |
| `glasses` | Speech-shaped answers: no markdown, two sentences, spoken numbers. |
| `vpn-support` | VPN first-line support; prompt in `config/prompts/vpn-support.md`. |
| `vpn-triage` | Classifies incoming tickets, returns JSON, runs on `haiku`. |

`"prewarm": 1` keeps a CLI process hot so the first question skips start-up.

**Tools are off by default** (`--tools ""`, `--safe-mode`, `--strict-mcp-config`):
no shell, no files, no host configuration. An internet-facing gateway should not
hand out a shell. Enable explicitly, per agent:

```json
{ "tools": ["Read", "WebSearch"], "add_dirs": ["/srv/knowledge-base"] }
```

---

## Smart glasses

Clients in [`examples/glasses/`](examples/glasses/): `ask_sse.py` (stdlib only)
and `ws_client.py` (WebSocket, with cancellation).

The gateway splits replies into **sentences** and streams them as they complete:

```
{"type":"sentence","text":"The moon is about 384,000 kilometres away."}
{"type":"sentence","text":"Light covers that in just over a second."}
{"type":"done","text":"…","ms":2100}
```

Text-to-speech starts on the first sentence while the model writes the second.

Camera frames are base64 in the same request:

```json
{ "prompt": "What is this?", "image": "data:image/jpeg;base64,/9j/…", "conversation": "glasses-1" }
```

## VPN support

[`examples/vpn-support-bot/`](examples/vpn-support-bot/) is a Telegram bot on the
standard library alone: one conversation per chat, `/reset`, `[[ESCALATE]]`
handover to a human, polite handling of 429s, and card numbers stripped from
replies as a backstop.

Fill in the `{{PLACEHOLDER}}`s in `config/prompts/vpn-support.md` first. While
they are there the model treats those facts as unknown and escalates rather than
inventing prices.

---

## Staying inside the plan

| Control | Variable | Default |
|---|---|---|
| Concurrent model turns | `MAX_CONCURRENCY` | `2` |
| Queue depth before 503 | `QUEUE_MAX` | `64` |
| Per-key requests/minute | `RATE_LIMIT_RPM` | `30` |
| Per-key requests/day | `RATE_LIMIT_DAILY` | unlimited |
| Stop at 5-hour window fill | `USAGE_GUARD` | `0.98` |
| Stop at weekly window fill | `USAGE_GUARD_WEEKLY` | `0.99` |
| Single-turn ceiling | `TURN_TIMEOUT_MS` | `300000` |

```bash
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:8787/v1/usage
```

```json
{ "plan": { "status": "allowed", "windows": {
    "five_hour": { "utilization": 0.31, "resets_at": "2026-09-09T21:00:00.000Z" },
    "seven_day": { "utilization": 0.44, "resets_at": "2026-09-13T00:00:00.000Z" } } },
  "gateway": { "inflight": 0, "queued": 0, "turns": 128 } }
```

The same numbers are in `/metrics` as `cca_subscription_utilization`, so you can
alert before the window runs out.

---

## Security

The gateway hands out access to your Claude account.

* **Keys are mandatory** — it refuses to start without them. Comparison is
  constant-time. `ALLOW_ANONYMOUS=1` exists and warns loudly.
* **Scoped keys** via `API_KEYS_FILE`: per-key limits and an agent allowlist.

  ```json
  { "keys": [
      { "name": "glasses", "key": "cca_…", "agents": ["glasses"], "rpm": 20 },
      { "name": "vpnbot",  "key": "cca_…", "agents": ["vpn-support"], "daily": 2000 }
  ] }
  ```
* **Tools disabled**, host settings ignored, MCP only where configured.
* **Images must be `data:` URLs** — the gateway never fetches a URL for you,
  which closes an SSRF.
* **Binds to `127.0.0.1`** by default; expose only through a TLS proxy.
* **Prompts are never logged** (`LOG_PROMPTS=0`), the container runs non-root,
  and `.env` is created `600`.

It does not moderate content, does not store conversations beyond the CLI's own
transcripts, and does not authenticate your end users — that stays your app's
job.

---

## Development

```bash
npm test           # 65 tests: unit + end-to-end against a fake CLI
npm run typecheck  # TypeScript over the JSDoc types
npm run dev        # auto-restart
```

`test/fake-claude.mjs` speaks the same stream-json protocol as the real CLI, so
routing, streaming, conversation state, cancellation and error handling are all
covered without spending tokens.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
[docs/API.md](docs/API.md) ·
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) ·
[docs/CHEATSHEET.md](docs/CHEATSHEET.md) and [docs/CODEMAP.md](docs/CODEMAP.md) (quick reference, Russian)

## License

MIT. Not affiliated with or endorsed by Anthropic.
