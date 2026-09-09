#!/usr/bin/env python3
"""
The gateway from the official OpenAI SDK. Only base_url and api_key change.

    pip install openai
    export CCA_URL=http://127.0.0.1:8787 CCA_KEY=cca_xxx
    python3 openai_sdk.py
"""
import os

from openai import OpenAI

client = OpenAI(
    base_url=os.environ.get("CCA_URL", "http://127.0.0.1:8787").rstrip("/") + "/v1",
    api_key=os.environ["CCA_KEY"],
)

# `model` names an agent profile from config/agents.json.
answer = client.chat.completions.create(
    model="default",
    messages=[{"role": "user", "content": "Name three uses for a paperclip."}],
)
print(answer.choices[0].message.content)
print(f"\ntokens: {answer.usage.prompt_tokens} in / {answer.usage.completion_tokens} out")

print("\n--- streaming ---")
stream = client.chat.completions.create(
    model="default",
    messages=[{"role": "user", "content": "Count to five."}],
    stream=True,
    # Keeps the conversation warm server-side. Requires
    # CONVERSATION_FROM_USER_FIELD=1 on the gateway; otherwise send the
    # X-Conversation-Id header via extra_headers.
    user="demo-conversation",
)
for chunk in stream:
    piece = chunk.choices[0].delta.content
    if piece:
        print(piece, end="", flush=True)
print()

print("\n--- stateful via header ---")
for question in ["My favourite colour is green.", "What is my favourite colour?"]:
    reply = client.chat.completions.create(
        model="default",
        messages=[{"role": "user", "content": question}],
        extra_headers={"X-Conversation-Id": "demo-1"},
    )
    print(f"> {question}\n< {reply.choices[0].message.content}\n")
