# API reference

Every `/v1` endpoint requires a key:

```
Authorization: Bearer <your key>
```

`x-api-key: <your key>` is also accepted, because the Anthropic SDKs send that
instead. Errors follow the shape of whichever API you called: OpenAI-style
`{"error": {...}}` on `/v1/chat/completions`, Anthropic-style
`{"type": "error", ...}` on `/v1/messages`, and `{"error": "...", "code": "..."}`
on the rest.

---

## Choosing an agent

The `model` field selects the agent profile, since that is the only knob most
third-party clients expose:

| Value | Effect |
|---|---|
| `glasses` | Use the agent named `glasses`. |
| `agent:glasses` | Same, explicit. Fails with 404 if the agent is unknown. |
| `sonnet`, `claude-opus-5`, … | Default agent, but with that model. |
| omitted | `DEFAULT_AGENT`. |

`GET /v1/agents` lists what the calling key is allowed to use.

## Conversations

Pass a conversation id to keep the history on the server. Any of these work:

* header `X-Conversation-Id: glasses-1`
* body field `conversation_id`, `session_id`, or `conversation`
* query `?conversation=glasses-1` on the WebSocket
* body field `user`, when `CONVERSATION_FROM_USER_FIELD=1`

With an id, only the newest user turn is forwarded — Claude holds the rest.
Without one, the whole transcript you send is flattened into a single prompt and
run in a throwaway conversation.

Ids must match `[A-Za-z0-9._:-]{1,128}`.

---

## POST /v1/chat/completions

OpenAI-compatible. Recognised fields: `model`, `messages`, `stream`, `user`.
`temperature`, `max_tokens`, `tools` and friends are accepted and ignored — the
CLI does not expose them.

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"default","messages":[{"role":"user","content":"Hello"}]}'
```

```json
{
  "id": "chatcmpl_…",
  "object": "chat.completion",
  "model": "default",
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "Hello!" }, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 1200, "completion_tokens": 8, "total_tokens": 1208 },
  "conversation_id": null,
  "claude_session_id": "0f3b…"
}
```

With `"stream": true` the response is SSE carrying `chat.completion.chunk`
objects and a final `data: [DONE]`.

Images use the standard content-parts form, but only `data:` URLs:

```json
{ "role": "user", "content": [
    { "type": "text", "text": "What is this?" },
    { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,/9j/…" } }
] }
```

## POST /v1/messages

Anthropic-compatible, including the top-level `system` field and the full
streaming event sequence (`message_start`, `content_block_start`,
`content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`).

```python
from anthropic import Anthropic
client = Anthropic(base_url="http://127.0.0.1:8787", api_key="cca_…")
client.messages.create(model="default", max_tokens=1024,
                       messages=[{"role": "user", "content": "Hi"}])
```

## POST /v1/ask

The endpoint for your own devices.

```json
{
  "prompt": "How far is the moon?",
  "agent": "glasses",
  "conversation": "glasses-1",
  "image": "data:image/jpeg;base64,…",
  "stream": false
}
```

`image` also accepts bare base64 plus `image_media_type`, and `images` accepts a
list. Response:

```json
{
  "text": "About 384,000 kilometres.",
  "agent": "glasses",
  "model": "claude-sonnet-5",
  "conversation": "glasses-1",
  "ms": 1840,
  "usage": { "input_tokens": 1180, "output_tokens": 9, "cache_read_tokens": 4400 }
}
```

With `"stream": true` (or `?stream=1`) it becomes SSE:

```
data: {"type":"delta","text":"About "}
data: {"type":"sentence","text":"About 384,000 kilometres."}
data: {"type":"done","text":"…","ms":1840}
```

`sentence` events are the point: they arrive as complete, speakable units, so
text-to-speech can start on the first one.

## WS /v1/ws

```
ws://host:8787/v1/ws?key=<api key>&conversation=glasses-1&agent=glasses
```

Browsers cannot set headers on a handshake, hence `?key=`. Everything else may
use `Authorization` instead. The server pings every 25s and drops a socket that
stops answering.

Client → server:

```json
{"type":"ask","id":"1","prompt":"…","conversation":"g1","agent":"glasses","image":"data:…"}
{"type":"cancel","id":"1"}
{"type":"reset","conversation":"g1"}
{"type":"ping","id":"p"}
```

Server → client:

```json
{"type":"ready","agents":["default","glasses"],"default_agent":"default"}
{"type":"delta","id":"1","text":"About "}
{"type":"sentence","id":"1","text":"About 384,000 kilometres."}
{"type":"done","id":"1","text":"…","ms":1840}
{"type":"error","id":"1","code":"rate_limited_rpm","message":"…","retry_after":12}
```

One question at a time per socket: a second `ask` while one is running is
answered with `code: "busy"`. Open a second socket for real parallelism.

## GET /v1/usage

How much of the plan is gone, and what the gateway is doing. Not rate limited.

## GET /v1/models · GET /v1/agents

Model list in OpenAI's shape, and the richer agent list.

## DELETE /v1/sessions/{id} · POST /v1/sessions/{id}/reset

Ends a conversation. The next call with that id starts fresh. This is what a
`/reset` command in a bot should call.

## GET /v1/sessions

Admin only. Every known conversation, whether its process is alive, and turn
counts.

## GET /healthz · /readyz · /metrics

`/healthz` is a liveness ping. `/readyz` also checks the CLI is installed and
authenticated (cached for 30s). `/metrics` is Prometheus text — admin key
required unless `PUBLIC_METRICS=1`.

---

## Error codes worth handling

| Status | `code` | Meaning |
|---|---|---|
| 400 | `invalid_request_error` | Malformed body, bad image, prompt too long. |
| 401 | `authentication_error` | Missing or wrong API key. |
| 403 | `agent_forbidden` | Key is not allowed to use that agent. |
| 404 | `unknown_agent` | No such agent profile. |
| 409 | `conversation_busy` | That conversation already has a turn running. |
| 429 | `rate_limit_exceeded` | Gateway's own per-key limit. `Retry-After` set. |
| 429 | `plan_window_guard` | Claude plan window nearly spent. `Retry-After` set. |
| 429 | `upstream_rate_limited` | Anthropic refused the turn. |
| 503 | `queue_full` / `queue_timeout` | Too many callers. Back off and retry. |
| 504 | `turn_timeout` | The turn exceeded `TURN_TIMEOUT_MS`. |
| 502 | `not_authenticated` | The CLI is not logged in — run `claude setup-token`. |

Every 429 and 503 carries `Retry-After` in seconds. Honour it.
