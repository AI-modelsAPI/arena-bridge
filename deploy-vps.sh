#!/usr/bin/env bash
# Complete first-time VPS setup: create private credentials, build the hub and enable HTTPS.
# Run in a cloned repository: sudo bash deploy-vps.sh
set -euo pipefail
cd "$(dirname "$0")"
if (( EUID != 0 )); then echo 'Run as root: sudo bash deploy-vps.sh' >&2; exit 1; fi
command -v python3 >/dev/null || { echo 'Python 3 is required for first-time secure configuration.' >&2; exit 1; }
command -v curl >/dev/null || { echo 'curl is required.' >&2; exit 1; }
if [[ ! -f .env ]]; then
  echo '== First-time setup: the domain must already point to this VPS.'
  python3 scripts/init-config.py --output .env
fi
# This is an administrator-controlled root-only file; never source downloaded/untrusted env files.
[[ $(stat -c '%a' .env) == 600 ]] || { echo 'Protect .env first: chmod 600 .env' >&2; exit 1; }
set -a
source .env
set +a
[[ -z ${UNLOCK_PASSWORD:-} ]] || { echo 'Legacy plaintext UNLOCK_PASSWORD is unsupported; see README migration instructions.' >&2; exit 1; }
python3 - <<'PY'
import json, os, re, sys
host = os.environ.get('BRIDGE_HOST', '')
main = os.environ.get('BRIDGE_TOKEN', '')
encoded = os.environ.get('UNLOCK_PASSWORD_HASH', '')
try: keys = json.loads(os.environ.get('DEVICE_TOKENS_JSON', '{}'))
except ValueError: sys.exit('DEVICE_TOKENS_JSON must be valid JSON')
if not re.fullmatch(r'(?:[a-z0-9-]+\.)+[a-z0-9-]+', host): sys.exit('Set a valid BRIDGE_HOST in .env')
if not re.fullmatch(r'[0-9a-f]{48,}', main): sys.exit('BRIDGE_TOKEN must be a random hex token of at least 48 digits')
if not re.fullmatch(r'scrypt\$[0-9a-f]{64}\$[0-9a-f]{64}', encoded) and os.environ.get('DISABLE_POLICY') != '1':
    sys.exit('UNLOCK_PASSWORD_HASH missing or invalid; run scripts/init-config.py for fresh installs')
if not isinstance(keys, dict) or not keys: sys.exit('DEVICE_TOKENS_JSON must contain at least one named device')
for name, key in keys.items():
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,31}', name) or name in ('vps', 'hub') or not re.fullmatch(r'[0-9a-f]{48,}', str(key)) or key == main:
        sys.exit('Invalid device name/key in DEVICE_TOKENS_JSON')
if len(set(keys.values())) != len(keys): sys.exit('Each device must have a distinct key')
print('Configuration validated:', host, '; registered devices:', ', '.join(keys))
PY
if ! command -v docker >/dev/null; then
  echo 'Docker is missing. The official get.docker.com installer will be downloaded and run.'
  read -rp 'Continue? [y/N] ' YES
  [[ "$YES" == [yY] ]] || { echo 'Install Docker manually, then rerun.'; exit 1; }
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null || { echo 'The Docker Compose plugin is required.' >&2; exit 1; }
if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi
PORTS_IN_USE=0
if command -v ss >/dev/null && ss -tln 2>/dev/null | grep -qE ':(80|443) '; then PORTS_IN_USE=1; fi
if (( PORTS_IN_USE )) && command -v nginx >/dev/null && pgrep -x nginx >/dev/null 2>&1; then
  echo '== nginx owns 80/443; building bridge and configuring nginx HTTPS.'
  docker compose up -d --build
  bash nginx/install.sh
elif (( PORTS_IN_USE )) && ! docker compose --profile caddy ps --status running -q caddy | grep -q .; then
  echo 'Ports 80/443 are already used by a non-nginx service; configure a reverse proxy or free these ports.' >&2
  exit 1
else
  echo '== Starting bridge and Caddy (automatic HTTPS).'
  docker compose --profile caddy up -d --build
fi
UP=0
for _ in $(seq 1 60); do
  if curl -fsS --max-time 8 "https://$BRIDGE_HOST/health" 2>/dev/null | grep -q '"ok":true'; then UP=1; break; fi
  sleep 3
done
if (( UP == 0 )); then
  echo "HTTPS is not ready. Check DNS, ports 80/443 and: docker compose logs --tail=100 bridge caddy" >&2
  exit 1
fi
echo '== Hub is online. Secrets are NOT printed automatically.'
echo 'To print a device-scoped install command on this private terminal:'
python3 - <<'PY'
import json,os
for name in json.loads(os.environ['DEVICE_TOKENS_JSON']): print('  sudo bash show-setup.sh ' + name)
PY
echo 'To print the short Agent prompt (contains the powerful MAIN token):'
echo '  sudo bash show-setup.sh --prompt'
echo 'Keep .env, installer commands and prompts private. See README.zh-CN.md.'
