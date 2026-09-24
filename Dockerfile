# arena-bridge: agent-operable workspace container.
# The agent gets a shell + files inside this container; /data is the persistent workspace ($HOME).
# Override in China etc.: --build-arg BASE=docker.m.daocloud.io/library/node:22-bookworm
ARG BASE=node:22-bookworm
FROM ${BASE}

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash zsh git curl wget jq ripgrep unzip zip openssh-client ca-certificates \
      python3 python3-pip python3-venv build-essential sqlite3 less vim-tiny procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.mjs builtins.mjs device-agent.mjs make-prompt.mjs policy.mjs policy.json config.example.json ./

# Workspace lives in /data (mounted volume). HOME points there so "~" paths land on the volume.
ENV HOME=/data BIND=0.0.0.0 PORT=3777 BRIDGE_SHELL=/bin/bash LOCAL_NAME=vps \
    DEFAULT_TIMEOUT_SEC=300 MAX_TIMEOUT_SEC=1800
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
VOLUME ["/data"]
EXPOSE 3777
HEALTHCHECK --interval=30s --timeout=5s CMD curl -sf http://127.0.0.1:3777/health || exit 1
CMD ["node", "/app/server.mjs"]
