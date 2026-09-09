# syntax=docker/dockerfile:1
#
# claude-code-api runs the real Claude Code CLI as a child process, so the image
# needs Node plus the CLI itself. There is no build step: the gateway is plain
# ESM with zero runtime dependencies.
FROM node:22-bookworm-slim

# Pin the CLI so an upstream release cannot change behaviour under a running
# deployment. Override at build time: --build-arg CLAUDE_CODE_VERSION=latest
ARG CLAUDE_CODE_VERSION=latest

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep tini curl \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY config ./config

# Claude keeps its credentials and session transcripts under $HOME/.claude, and
# the gateway keeps its conversation map under DATA_DIR. Both are volumes so a
# container rebuild does not log you out or lose in-flight conversations.
ENV HOME=/home/node \
    DATA_DIR=/data \
    WORKDIR=/data/work \
    HOST=0.0.0.0 \
    PORT=8787 \
    NODE_ENV=production

RUN mkdir -p /home/node/.claude /data/work \
 && chown -R node:node /home/node /data /app

USER node
EXPOSE 8787
VOLUME ["/home/node/.claude", "/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1

# tini reaps the CLI processes the gateway spawns, so a long-lived container
# does not accumulate zombies.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
