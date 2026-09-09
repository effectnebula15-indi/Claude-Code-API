#!/usr/bin/env python3
"""
Smart-glasses client over SSE. Standard library only — nothing to pip install,
which matters on a Raspberry Pi Zero or a phone-tethered companion board.

It streams the answer sentence by sentence, so speech synthesis can start
talking while the model is still writing.

    export CCA_URL=http://192.168.1.10:8787
    export CCA_KEY=cca_xxx
    python3 ask_sse.py "how long until my bus arrives"
    python3 ask_sse.py --image frame.jpg "what am I looking at"
"""
import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request

URL = os.environ.get("CCA_URL", "http://127.0.0.1:8787").rstrip("/")
KEY = os.environ.get("CCA_KEY", "")
AGENT = os.environ.get("CCA_AGENT", "glasses")
# A stable id keeps the conversation warm on the server: follow-up questions
# skip both the process start-up and re-sending the history.
CONVERSATION = os.environ.get("CCA_CONVERSATION", "glasses-1")


def speak(sentence: str) -> None:
    """Replace this with your TTS. Printing keeps the example runnable."""
    print(sentence, flush=True)


def ask(prompt: str, image_path: str | None = None, timeout: float = 120.0) -> str:
    payload = {
        "prompt": prompt,
        "agent": AGENT,
        "conversation": CONVERSATION,
        "stream": True,
    }
    if image_path:
        with open(image_path, "rb") as fh:
            raw = base64.b64encode(fh.read()).decode("ascii")
        media = "image/png" if image_path.lower().endswith(".png") else "image/jpeg"
        payload["image"] = f"data:{media};base64,{raw}"

    req = urllib.request.Request(
        f"{URL}/v1/ask",
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {KEY}",
            "Accept": "text/event-stream",
        },
    )

    full = ""
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            for raw_line in resp:
                line = raw_line.decode("utf-8", "replace").rstrip("\n")
                # `: ping` heartbeats keep mobile NAT from dropping the socket.
                if not line.startswith("data:"):
                    continue
                event = json.loads(line[5:].strip())
                kind = event.get("type")
                if kind == "sentence" and event.get("text"):
                    speak(event["text"])
                elif kind == "done":
                    full = event.get("text", "")
                elif kind == "error":
                    raise RuntimeError(event.get("message", "gateway error"))
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", "replace")
        raise RuntimeError(f"HTTP {err.code}: {body}") from None
    return full


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", nargs="+")
    parser.add_argument("--image", help="JPEG/PNG frame from the glasses camera")
    args = parser.parse_args()

    if not KEY:
        print("set CCA_KEY to one of the gateway's API keys", file=sys.stderr)
        return 2

    try:
        ask(" ".join(args.prompt), args.image)
    except RuntimeError as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
