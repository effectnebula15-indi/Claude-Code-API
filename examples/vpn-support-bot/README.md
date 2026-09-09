# VPN support bot

First-line support in Telegram, answered by the `vpn-support` agent.

## Run it

```bash
export TELEGRAM_TOKEN=123456:ABC…          # from @BotFather
export CCA_URL=http://127.0.0.1:8787
export CCA_KEY=cca_your_key
export ADMIN_CHAT_ID=-1001234567890        # optional: where escalations go
python3 bot.py
```

Standard library only — nothing to install or keep patched on a small VPS.

## Before you point customers at it

Fill in `config/prompts/vpn-support.md`. Every `{{PLACEHOLDER}}` is a fact the
model does not have: protocols, apps, locations, prices, where a customer finds
their config. Until they are replaced the prompt tells the model to treat them
as unknown and escalate — which is safe, and also useless. Facts you do not
write down are facts the bot cannot give.

Then read the prompt as if you were a customer. It is the product.

## How it behaves

| Situation | Result |
|---|---|
| Ordinary question | Answered from the prompt, in the customer's language. |
| Refund, compromise, legal, abuse | `[[ESCALATE]]` → forwarded to `ADMIN_CHAT_ID`. |
| `/human` | Escalated immediately. |
| `/reset` | Conversation cleared (`DELETE /v1/sessions/tg-<chat>`). |
| Gateway returns 429 | "There are a lot of requests right now…" — no retry storm. |
| Gateway returns 5xx | Apology, and the case is escalated. |

One conversation id per chat (`tg-<chat_id>`), so the bot stores no history
itself and a ticket keeps its context across messages.

## Suggested rails

Give the bot its own API key, scoped and capped:

```json
{ "keys": [
  { "name": "vpnbot", "key": "cca_…", "agents": ["vpn-support", "vpn-triage"],
    "rpm": 20, "daily": 2000 }
] }
```

Point `API_KEYS_FILE` at that file. Now a bug in the bot cannot spend your whole
plan window, and it cannot reach any other agent.

## Cheap triage

The `vpn-triage` agent runs on `haiku` and returns JSON:

```json
{"category":"connection","severity":"normal","language":"ru","needs_human":false,
 "summary":"Customer connects but has no internet on iOS"}
```

Useful for routing to the right human, tagging a helpdesk ticket, or deciding
whether the expensive agent should answer at all. Classifying with `haiku` and
answering with `sonnet` costs a fraction of answering everything with `sonnet`.

## Things worth adding

* **Business hours.** Outside them, say when a human will reply.
* **A handover flag.** Once escalated, stop auto-answering that chat until an
  operator releases it — nothing annoys a waiting customer more than a bot
  talking over the human.
* **Log the escalations.** They are the list of things missing from your prompt.
* **Show the plan window.** `/v1/usage` on a dashboard tells you when the bot is
  about to start refusing.

## Other channels

The gateway is plain HTTP, so the same pattern works for a web widget, email, a
helpdesk webhook or a Matrix bridge. The only per-channel work is rendering: one
conversation id per ticket, `[[ESCALATE]]` for handover.
