#!/bin/bash
# One-shot server install. Run on the server inside this directory:  sudo bash deploy-vps.sh
# - installs Docker if missing, opens 80/443 (ufw), builds & starts the hub
# - if nginx already owns :80/:443 -> reuses it (nginx/install.sh); otherwise starts the bundled Caddy (auto-HTTPS)
set -e
cd "$(dirname "$0")"
[[ -f .env ]] || { cp .env.example .env; echo "created .env - edit BRIDGE_HOST / BRIDGE_TOKEN / UNLOCK_PASSWORD, then re-run"; exit 1; }
source .env
[[ -n "$BRIDGE_HOST" && -n "$BRIDGE_TOKEN" ]] || { echo "set BRIDGE_HOST and BRIDGE_TOKEN in .env"; exit 1; }
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
echo; echo "== Paste this at the start of every new chat:"; docker compose exec -T bridge node make-prompt.mjs --short
echo; echo "== Attach devices:"
echo "  Mac/Linux: curl -s -H \"Authorization: Bearer $BRIDGE_TOKEN\" https://$BRIDGE_HOST/install-device.sh | sh -s mac \"My laptop\""
echo "  Android:   pkg install -y nodejs-lts curl && termux-setup-storage && curl -s -H \"Authorization: Bearer $BRIDGE_TOKEN\" https://$BRIDGE_HOST/install-device.sh | sh -s android \"My phone\""
