#!/usr/bin/env bash
# Run on the hub: sudo bash show-setup.sh mac|android|--prompt
# Outputs a device-scoped credential only for the named installer.
set -euo pipefail
cd "$(dirname "$0")"
[[ -f .env ]] || { echo 'Missing .env. Run sudo bash deploy-vps.sh first.' >&2; exit 1; }
source .env
case "${1:-}" in
  --prompt)
    echo 'The following prompt contains your MAIN Bridge token. Share only with a trusted agent:' >&2
    docker compose exec -T bridge node make-prompt.mjs --short
    exit 0 ;;
  '') echo "Usage: sudo bash show-setup.sh <device-name>|--prompt" >&2; exit 2 ;;
esac
NAME=$1
[[ "$NAME" =~ ^[a-z0-9][a-z0-9_-]{0,31}$ ]] || { echo 'Invalid device name' >&2; exit 2; }
TOKEN=$(DEVICE_TOKENS_JSON="$DEVICE_TOKENS_JSON" python3 - "$NAME" <<'PY'
import json, os, sys
name = sys.argv[1]
try: value = json.loads(os.environ['DEVICE_TOKENS_JSON'])[name]
except (KeyError, ValueError, TypeError): sys.exit('device not registered in DEVICE_TOKENS_JSON')
print(value)
PY
)
# The device token is limited to the named device; it cannot call the main API.
URL="https://${BRIDGE_HOST}/install-device.sh?name=${NAME}"
FILE=$(printf '"$HOME/.arena-install-%s.sh"' "$NAME")
echo 'SECRET: the command below contains a device credential; use it only in that device terminal.' >&2
echo 'Review the download before executing if this device is sensitive.' >&2
printf 'umask 077; curl -fsS -H %q %q -o %s && sh %s %q && rm -f %s\n' \
  "Authorization: Bearer $TOKEN" "$URL" "$FILE" "$FILE" "$NAME" "$FILE"
