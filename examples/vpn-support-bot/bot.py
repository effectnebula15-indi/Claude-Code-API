#!/usr/bin/env python3
"""
Telegram first-line support bot for a VPN service, backed by claude-code-api.

Standard library only: no python-telegram-bot, no aiohttp, nothing to keep
updated on a small VPS. It long-polls Telegram, forwards each message to the
gateway's `vpn-support` agent, and hands the conversation to a human when the
model asks for it.

    export TELEGRAM_TOKEN=123456:ABC...
    export CCA_URL=http://127.0.0.1:8787
    export CCA_KEY=cca_xxx
    export ADMIN_CHAT_ID=-1001234567890   # optional: where escalations land
    python3 bot.py

Design notes worth keeping if you rewrite this:

  * One conversation id per Telegram chat, so the model remembers the ticket
    without the bot storing or replaying any history itself.
  * The gateway is the rate limiter. The bot only has to render 429s politely.
  * `[[ESCALATE]]` is a marker the system prompt tells the model to emit. The
    bot strips it before the customer sees anything.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN", "")
CCA_URL = os.environ.get("CCA_URL", "http://127.0.0.1:8787").rstrip("/")
CCA_KEY = os.environ.get("CCA_KEY", "")
CCA_AGENT = os.environ.get("CCA_AGENT", "vpn-support")
ADMIN_CHAT_ID = os.environ.get("ADMIN_CHAT_ID", "")
TELEGRAM_API = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}"

ESCALATE_MARKER = "[[ESCALATE]]"
BUSY_REPLY = "Сейчас много обращений — отвечу через пару минут, не уходите."
ERROR_REPLY = "Что-то пошло не так на нашей стороне. Уже смотрю, попробуйте ещё раз через минуту."
RESET_REPLY = "Начал новый диалог. Опишите вопрос заново."


def http_json(url: str, payload: dict | None = None, headers: dict | None = None, timeout: float = 90.0) -> dict:
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(url, data=data, headers=headers or {})
    if data is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            parsed = {"error": body[:400]}
        parsed["_status"] = err.code
        return parsed


def telegram(method: str, **params) -> dict:
    return http_json(f"{TELEGRAM_API}/{method}", params)


def send_message(chat_id, text: str, reply_to: int | None = None) -> None:
    # Telegram rejects anything over 4096 characters.
    for i in range(0, len(text), 4000):
        telegram(
            "sendMessage",
            chat_id=chat_id,
            text=text[i : i + 4000],
            reply_to_message_id=reply_to if i == 0 else None,
            disable_web_page_preview=True,
        )


def ask_gateway(chat_id: int, prompt: str) -> tuple[str, bool]:
    """Returns (reply, needs_human)."""
    result = http_json(
        f"{CCA_URL}/v1/ask",
        {
            "prompt": prompt,
            "agent": CCA_AGENT,
            # One warm conversation per customer chat.
            "conversation": f"tg-{chat_id}",
        },
        {"Authorization": f"Bearer {CCA_KEY}"},
    )

    status = result.get("_status")
    if status == 429:
        return BUSY_REPLY, False
    if status:
        print(f"gateway error {status}: {result.get('error')}", file=sys.stderr)
        return ERROR_REPLY, True

    text = (result.get("text") or "").strip()
    needs_human = ESCALATE_MARKER in text
    text = text.replace(ESCALATE_MARKER, "").strip()
    # Belt and braces: the prompt forbids it, but never let a card number or a
    # one-time code get echoed back into the chat.
    text = re.sub(r"\b(?:\d[ -]?){13,19}\b", "[скрыто]", text)
    return text or ERROR_REPLY, needs_human


def escalate(chat_id: int, user: dict, question: str, answer: str) -> None:
    if not ADMIN_CHAT_ID:
        return
    handle = user.get("username")
    who = f"@{handle}" if handle else f"{user.get('first_name', '')} (id {user.get('id')})"
    send_message(
        ADMIN_CHAT_ID,
        f"🚨 Нужен человек\nЧат: {chat_id}\nКлиент: {who}\n\nВопрос:\n{question[:800]}\n\nОтвет бота:\n{answer[:800]}",
    )


def reset_conversation(chat_id: int) -> None:
    request = urllib.request.Request(
        f"{CCA_URL}/v1/sessions/{urllib.parse.quote(f'tg-{chat_id}')}",
        method="DELETE",
        headers={"Authorization": f"Bearer {CCA_KEY}"},
    )
    try:
        urllib.request.urlopen(request, timeout=15).read()
    except urllib.error.HTTPError:
        pass  # 404 just means there was nothing to clear.


def handle_update(update: dict) -> None:
    message = update.get("message") or update.get("edited_message")
    if not message:
        return
    chat_id = message["chat"]["id"]
    text = (message.get("text") or message.get("caption") or "").strip()
    if not text:
        send_message(chat_id, "Пока понимаю только текст. Опишите вопрос словами.")
        return

    if text.startswith("/start"):
        send_message(chat_id, "Здравствуйте! Опишите проблему — помогу разобраться.")
        return
    if text.startswith("/reset"):
        reset_conversation(chat_id)
        send_message(chat_id, RESET_REPLY)
        return
    if text.startswith("/human") or text.startswith("/operator"):
        send_message(chat_id, "Передал вопрос человеку — он ответит здесь.")
        escalate(chat_id, message.get("from", {}), text, "(запрошено клиентом)")
        return

    telegram("sendChatAction", chat_id=chat_id, action="typing")
    reply, needs_human = ask_gateway(chat_id, text)
    send_message(chat_id, reply, reply_to=message.get("message_id"))
    if needs_human:
        escalate(chat_id, message.get("from", {}), text, reply)


def main() -> int:
    if not TELEGRAM_TOKEN or not CCA_KEY:
        print("set TELEGRAM_TOKEN and CCA_KEY", file=sys.stderr)
        return 2

    print(f"bot up · gateway {CCA_URL} · agent {CCA_AGENT}")
    offset = 0
    backoff = 1.0
    while True:
        try:
            # Long polling: one held request instead of a busy loop.
            result = http_json(
                f"{TELEGRAM_API}/getUpdates?" + urllib.parse.urlencode({"timeout": 50, "offset": offset}),
                timeout=70,
            )
            if not result.get("ok"):
                raise RuntimeError(result.get("description", "getUpdates failed"))
            backoff = 1.0
            for update in result.get("result", []):
                offset = update["update_id"] + 1
                try:
                    handle_update(update)
                except Exception as err:  # one bad message must not kill the bot
                    print(f"update {update.get('update_id')} failed: {err}", file=sys.stderr)
        except KeyboardInterrupt:
            return 0
        except Exception as err:
            print(f"poll failed: {err}; retrying in {backoff:.0f}s", file=sys.stderr)
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)


if __name__ == "__main__":
    raise SystemExit(main())
