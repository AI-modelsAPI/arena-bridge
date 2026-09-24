#!/bin/bash
# One-shot server install. Run on the server inside this directory:  sudo bash deploy-vps.sh
# - installs Docker if missing, opens 80/443 (ufw), builds & starts the hub
# - if nginx already owns :80/:443 -> reuses it (nginx/install.sh); otherwise starts the bundled Caddy (auto-HTTPS)
set -e
cd "$(dirname "$0")"
[[ -f .env ]] || { umask 077; cp .env.example .env; echo "created .env - configure BRIDGE_HOST / BRIDGE_TOKEN / UNLOCK_PASSWORD_HASH / DEVICE_TOKENS_JSON, then re-run"; exit 1; }
source .env
[[ -n "$BRIDGE_HOST" && -n "$BRIDGE_TOKEN" && -n "$DEVICE_TOKENS_JSON" ]] || { echo "set BRIDGE_HOST, BRIDGE_TOKEN and DEVICE_TOKENS_JSON in .env"; exit 1; }
[[ -n "$UNLOCK_PASSWORD_HASH" || "$DISABLE_POLICY" == 1 ]] || { echo "set UNLOCK_PASSWORD_HASH (or explicitly DISABLE_POLICY=1 for test-only deployment)"; exit 1; }
[[ -z "$UNLOCK_PASSWORD" ]] || { echo "plaintext UNLOCK_PASSWORD is no longer supported"; exit 1; }
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi
if ss -tln 2>/dev/null | grep -qE ":(80|443) " && command -v nginx >/dev/null; then
  echo "== nginx detected on :80/:443 -> reusing it"
  docker compose up -d --build
  bash nginx/install.sh
else
  echo "== starting hub + Caddy (auto HTTPS)"
  docker compose --profile caddy up -d --build
fi
for i in $(seq 1 60); do curl -sf "https://$BRIDGE_HOST/health" >/dev/null 2>&1 && break; sleep 3; done
curl -s "https://$BRIDGE_HOST/health" && echo || { echo "HTTPS not up yet: docker compose logs caddy / nginx -t"; exit 1; }
echo; echo "== Ready. To print the secret short prompt on your own terminal:"
echo "  docker compose exec -T bridge node make-prompt.mjs --short	env file and its generated device installers contain credentials; keep them private."
echo "See README.zh-CN.md for named device installer URLs and migration steps."
