#!/usr/bin/env python3
"""
Smart-glasses client over WebSocket.

Better than SSE for a wearable: one connection for the whole session (no TLS
handshake per question), server-side pings that keep carrier NAT from dropping
it, and a cancel message so the assistant shuts up the moment the wearer starts
talking again.

    pip install websockets
    export CCA_URL=ws://192.168.1.10:8787 CCA_KEY=cca_xxx
    python3 ws_client.py
"""
import asyncio
import base64
import json
import os
import sys

try:
    import websockets
except ImportError:  # pragma: no cover - guidance, not logic
    sys.exit("pip install websockets")

URL = os.environ.get("CCA_URL", "ws://127.0.0.1:8787").rstrip("/")
KEY = os.environ.get("CCA_KEY", "")
AGENT = os.environ.get("CCA_AGENT", "glasses")
CONVERSATION = os.environ.get("CCA_CONVERSATION", "glasses-1")


def speak(sentence: str) -> None:
    """Hand off to TTS here (piper, espeak-ng, the platform synthesiser…)."""
    print(f"  🔊 {sentence}", flush=True)


class Glasses:
    def __init__(self, ws):
        self.ws = ws
        self._counter = 0

    async def ask(self, prompt: str, image_path: str | None = None) -> str:
        self._counter += 1
        request_id = str(self._counter)
        message = {"type": "ask", "id": request_id, "prompt": prompt, "agent": AGENT}
        if image_path:
            with open(image_path, "rb") as fh:
                message["image"] = base64.b64encode(fh.read()).decode("ascii")
            message["image_media_type"] = "image/jpeg"

        await self.ws.send(json.dumps(message))

        answer = ""
        async for raw in self.ws:
            event = json.loads(raw)
            if event.get("id") not in (request_id, None, ""):
                continue
            kind = event.get("type")
            if kind == "sentence" and event.get("text"):
                speak(event["text"])
            elif kind == "done":
                answer = event.get("text", "")
                break
            elif kind == "error":
                raise RuntimeError(f"{event.get('code')}: {event.get('message')}")
        return answer

    async def cancel(self) -> None:
        """Call this from your wake-word/VAD path when the wearer interrupts."""
        await self.ws.send(json.dumps({"type": "cancel"}))

    async def reset(self) -> None:
        await self.ws.send(json.dumps({"type": "reset"}))


async def main() -> None:
    if not KEY:
        sys.exit("set CCA_KEY")

    url = f"{URL}/v1/ws?key={KEY}&conversation={CONVERSATION}&agent={AGENT}"
    # ping_interval=None: the gateway already pings, and a wearable should not
    # spend radio time on redundant keepalives.
    async with websockets.connect(url, ping_interval=None, max_size=16 * 1024 * 1024) as ws:
        ready = json.loads(await ws.recv())
        print(f"connected · agents: {', '.join(ready.get('agents', []))}")

        glasses = Glasses(ws)
        print("type a question (or 'reset', or Ctrl-D to quit)\n")
        loop = asyncio.get_running_loop()
        while True:
            try:
                line = await loop.run_in_executor(None, input, "> ")
            except EOFError:
                return
            line = line.strip()
            if not line:
                continue
            if line == "reset":
                await glasses.reset()
                print("  (conversation cleared)")
                continue
            try:
                await glasses.ask(line)
            except RuntimeError as err:
                print(f"  error: {err}", file=sys.stderr)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
