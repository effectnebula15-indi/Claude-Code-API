#!/usr/bin/env bash
#
# claude-code-api installer.
#
#   curl -fsSL https://raw.githubusercontent.com/effectnebula15-indi/Claude-Code-API/main/install.sh | bash
#
# or, from a checkout:
#
#   ./install.sh
#
# Sets up a running gateway with generated API keys. It never overwrites an
# existing .env, and it never starts anything without telling you first.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/effectnebula15-indi/Claude-Code-API.git}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/claude-code-api}"
MODE="${MODE:-auto}"          # auto | docker | node
START="${START:-1}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }

have() { command -v "$1" >/dev/null 2>&1; }

random_key() {
  if have openssl; then
    printf 'cca_%s' "$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=\n')"
  elif have node; then
    node -e "process.stdout.write('cca_'+require('node:crypto').randomBytes(24).toString('base64url'))"
  else
    printf 'cca_%s' "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
}

# --- locate or fetch the source -------------------------------------------
if [ -f "src/server.js" ] && [ -f "package.json" ]; then
  INSTALL_DIR="$(pwd)"
  info "using the checkout in $INSTALL_DIR"
else
  have git || die "git is required to fetch the source (or run this script from a checkout)"
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "updating existing checkout in $INSTALL_DIR"
    git -C "$INSTALL_DIR" pull --ff-only
  else
    info "cloning into $INSTALL_DIR"
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
  fi
  cd "$INSTALL_DIR"
fi

# --- choose a runtime ------------------------------------------------------
if [ "$MODE" = "auto" ]; then
  if have docker && docker compose version >/dev/null 2>&1; then MODE=docker
  elif have node; then MODE=node
  else die "need either Docker (with the compose plugin) or Node.js 20.10+"; fi
fi

if [ "$MODE" = "node" ]; then
  have node || die "Node.js 20.10+ is required for MODE=node"
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$node_major" -ge 20 ] || die "Node.js 20.10+ required, found $(node -v)"
  have claude || warn "the 'claude' CLI is not on PATH — install it with: npm i -g @anthropic-ai/claude-code"
fi
ok "install mode: $MODE"

# --- configuration ---------------------------------------------------------
if [ -f .env ]; then
  ok ".env already exists — leaving it untouched"
else
  cp .env.example .env
  GLASSES_KEY="$(random_key)"
  BOT_KEY="$(random_key)"
  ADMIN_KEY="$(random_key)"
  # BSD and GNU sed disagree about -i, so write through a temp file.
  tmp="$(mktemp)"
  sed -e "s|^API_KEYS=.*|API_KEYS=glasses:${GLASSES_KEY},vpnbot:${BOT_KEY}|" \
      -e "s|^ADMIN_KEY=.*|ADMIN_KEY=${ADMIN_KEY}|" .env > "$tmp"
  mv "$tmp" .env
  chmod 600 .env
  ok "generated .env with fresh API keys"
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ ! -f "$HOME/.claude/.credentials.json" ]; then
  echo
  bold "One thing left: connect your Claude subscription."
  info "Run this (here, or on any machine where you use Claude Code):"
  echo
  info "    claude setup-token"
  echo
  info "It prints a long-lived token. Put it in .env as:"
  info "    CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-..."
  echo
  info "Then re-run this script, or: docker compose up -d"
  echo
  if [ "${REQUIRE_TOKEN:-1}" = "1" ]; then
    warn "stopping here so the gateway does not start unauthenticated"
    exit 0
  fi
fi

# --- start -----------------------------------------------------------------
if [ "$START" != "1" ]; then
  ok "setup complete (START=0, not starting)"
  exit 0
fi

if [ "$MODE" = "docker" ]; then
  info "building and starting containers…"
  docker compose up -d --build
else
  info "starting with node…"
  mkdir -p data
  if have systemctl && [ "$(id -u)" = "0" ]; then
    sed -e "s|@INSTALL_DIR@|$INSTALL_DIR|g" \
        -e "s|@USER@|${SUDO_USER:-root}|g" \
        deploy/claude-code-api.service > /etc/systemd/system/claude-code-api.service
    systemctl daemon-reload
    systemctl enable --now claude-code-api
    ok "installed and started the systemd unit 'claude-code-api'"
  else
    info "no systemd (or not root) — start it yourself with:"
    info "    cd $INSTALL_DIR && node src/server.js"
    exit 0
  fi
fi

# --- verify ----------------------------------------------------------------
PORT="${PORT:-8787}"
info "waiting for the gateway to answer on port $PORT…"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    echo
    ok "claude-code-api is up on http://127.0.0.1:${PORT}"
    echo
    bold "Try it:"
    first_key="$(printf '%s' "${API_KEYS%%,*}" | cut -d: -f2-)"
    echo
    echo "  curl http://127.0.0.1:${PORT}/v1/ask \\"
    echo "    -H 'Authorization: Bearer ${first_key}' \\"
    echo "    -H 'Content-Type: application/json' \\"
    echo "    -d '{\"prompt\":\"Say hello in one sentence\"}'"
    echo
    echo "  Your keys are in .env — keep that file private."
    exit 0
  fi
  sleep 2
done

warn "the gateway did not become healthy in time"
if [ "$MODE" = "docker" ]; then info "check the logs with: docker compose logs --tail=50"; fi
exit 1
