# Smart glasses

What the gateway does for a wearable, and how to drive it.

## Why not just call the API directly

Three things a head-mounted assistant needs that a plain chat endpoint does not
give you:

1. **Time to first sound.** With `prewarm` there is no process start-up on the
   first question, and `sentence` events let text-to-speech begin on sentence
   one while the model writes sentence two.
2. **One connection.** On a mobile link a TLS handshake per question is real
   latency, and carrier NAT kills idle sockets. `/v1/ws` is one long-lived
   connection with server-side pings.
3. **Interruption.** When the wearer starts talking again, the assistant must
   stop mid-word. `{"type":"cancel"}` does that.

## Clients here

| File | Needs | Use when |
|---|---|---|
| `ask_sse.py` | stdlib only | Simple push-to-talk, or a very small board. |
| `ws_client.py` | `pip install websockets` | Always-on assistant with interruption. |

```bash
export CCA_URL=http://192.168.1.10:8787
export CCA_KEY=cca_your_key
export CCA_AGENT=glasses
export CCA_CONVERSATION=glasses-1

python3 ask_sse.py "how far is the moon"
python3 ask_sse.py --image frame.jpg "what am I looking at"
python3 ws_client.py
```

Replace `speak()` in either file with your synthesiser (piper, espeak-ng, the
platform TTS). That is the only integration point.

## The wiring

```
mic ─▶ VAD/wake word ─▶ speech-to-text ─▶ claude-code-api ─▶ sentences ─▶ TTS ─▶ speaker
                                              ▲
camera ──────── JPEG frame, base64 ───────────┘
```

Speech-to-text stays on your side: the gateway takes text and images. Whisper
(`whisper.cpp` on-device, or a small server) and Vosk both work.

## Keep the conversation id stable

```json
{ "type": "ask", "id": "7", "prompt": "and how long would that take by car",
  "conversation": "glasses-1" }
```

One id per pair of glasses. Claude keeps the history, so a follow-up like "and
by car?" works, only the new sentence goes over the air, and prompt caching
keeps the plan window from draining.

Start a new topic with `{"type":"reset"}`.

## Camera frames

Send `image` as a `data:` URL, or bare base64 with `image_media_type`. Keep
frames small: 640×480 JPEG at quality 60 is around 30 KB, enough for the model
to read signs and identify objects, and it uploads in a fraction of a second on
a weak link. `MAX_IMAGES_PER_REQUEST` (default 4) caps a single request.

## Agent profile

`config/agents.json` ships a `glasses` profile tuned for speech: at most two
sentences, no markdown or emoji, numbers written the way they are pronounced,
answer first. `"prewarm": 1` keeps a process hot; `"max_reply_chars": 700` is
the hard backstop if the model gets carried away.

Adjust the prompt — it is the single biggest lever on how the assistant feels.

## A realistic latency budget

| Stage | Typical |
|---|---|
| Wake word + capture | 300–800 ms |
| Speech-to-text (on-device) | 200–600 ms |
| Gateway → first `sentence` | 700–1500 ms |
| TTS → first sound | 100–300 ms |

Roughly 1.5–3 s from "stopped speaking" to "starts answering". The sentence
streaming is what keeps the last stage from waiting on the whole reply.

## Battery and radio notes

* Reuse the WebSocket. Reconnecting is the expensive part.
* The gateway pings; do not add your own keepalive on top (`ping_interval=None`
  in the `websockets` client).
* Send `cancel` the moment the wearer speaks — a cancelled turn stops consuming
  the plan window too.
