#!/usr/bin/env bash
#
# Connect a Claude subscription to this gateway.
#
# `claude setup-token` opens a browser login and prints a long-lived token.
# That token is what lets the headless gateway use your plan.
set -euo pipefail

cd "$(dirname "$0")/.."

info() { printf '  %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

if command -v claude >/dev/null 2>&1; then
  RUNNER=(claude setup-token)
elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  info "no local 'claude' CLI — running setup-token inside the container"
  RUNNER=(docker compose run --rm --no-deps -it --entrypoint claude api setup-token)
else
  die "install the CLI first: npm i -g @anthropic-ai/claude-code"
fi

echo
info "A browser login will start. Sign in with the account that has your Claude plan."
echo

# The token is the last sk-ant-oat… looking string the command prints.
output="$("${RUNNER[@]}" 2>&1 | tee /dev/tty)"
token="$(printf '%s' "$output" | grep -oE 'sk-ant-oat[A-Za-z0-9_.-]+' | tail -1 || true)"

[ -n "$token" ] || die "could not find a token in the output — copy it manually into .env as CLAUDE_CODE_OAUTH_TOKEN"

[ -f .env ] || cp .env.example .env
tmp="$(mktemp)"
if grep -q '^CLAUDE_CODE_OAUTH_TOKEN=' .env; then
  # Use a literal-safe replacement: the token can contain characters sed treats
  # as delimiters.
  awk -v tok="$token" '/^CLAUDE_CODE_OAUTH_TOKEN=/ { print "CLAUDE_CODE_OAUTH_TOKEN=" tok; next } { print }' .env > "$tmp"
else
  cp .env "$tmp"
  printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$token" >> "$tmp"
fi
mv "$tmp" .env
chmod 600 .env

echo
ok "token written to .env"
info "restart the gateway to pick it up:  docker compose up -d"
