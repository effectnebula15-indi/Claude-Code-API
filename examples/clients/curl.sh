#!/usr/bin/env bash
# Every endpoint, as curl. Set CCA_URL and CCA_KEY first.
set -euo pipefail
URL="${CCA_URL:-http://127.0.0.1:8787}"
KEY="${CCA_KEY:?set CCA_KEY}"
AUTH=(-H "Authorization: Bearer $KEY" -H 'Content-Type: application/json')

echo '--- health (no key needed) ---'
curl -s "$URL/healthz"; echo

echo '--- agents ---'
curl -s "${AUTH[@]}" "$URL/v1/agents"; echo

echo '--- simple ask ---'
curl -s "${AUTH[@]}" "$URL/v1/ask" -d '{"prompt":"Say hi in one sentence"}'; echo

echo '--- ask, streamed sentence by sentence ---'
curl -sN "${AUTH[@]}" "$URL/v1/ask" \
  -d '{"prompt":"Describe the sea in two sentences.","stream":true}'

echo '--- OpenAI-compatible ---'
curl -s "${AUTH[@]}" "$URL/v1/chat/completions" \
  -d '{"model":"default","messages":[{"role":"user","content":"2+2?"}]}'; echo

echo '--- OpenAI-compatible, streaming ---'
curl -sN "${AUTH[@]}" "$URL/v1/chat/completions" \
  -d '{"model":"default","messages":[{"role":"user","content":"Count to three."}],"stream":true}'

echo '--- Anthropic-compatible ---'
curl -s "${AUTH[@]}" "$URL/v1/messages" \
  -d '{"model":"default","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}'; echo

echo '--- stateful conversation ---'
curl -s "${AUTH[@]}" -H 'X-Conversation-Id: curl-demo' "$URL/v1/ask" \
  -d '{"prompt":"Remember the number 42."}'; echo
curl -s "${AUTH[@]}" -H 'X-Conversation-Id: curl-demo' "$URL/v1/ask" \
  -d '{"prompt":"What number did I ask you to remember?"}'; echo
curl -s "${AUTH[@]}" -X DELETE "$URL/v1/sessions/curl-demo"; echo

echo '--- image (1x1 png) ---'
curl -s "${AUTH[@]}" "$URL/v1/ask" -d '{
  "prompt":"What colour is this pixel?",
  "image":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
}'; echo

echo '--- plan usage ---'
curl -s "${AUTH[@]}" "$URL/v1/usage"; echo
