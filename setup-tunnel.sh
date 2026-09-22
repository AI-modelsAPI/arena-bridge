#!/bin/zsh
# Creates a Cloudflare Named Tunnel "arena-bridge" -> localhost:PORT and routes HOST to it.
# Requires the domain to be on Cloudflare DNS. Run once.
set -e
cd "$(dirname "$0")"
HOST=$(node -p "require('./config.json').hostname")
PORT=$(node -p "require('./config.json').port||3777")
NAME=arena-bridge
command -v cloudflared >/dev/null || brew install cloudflared
[[ -f ~/.cloudflared/cert.pem ]] || cloudflared tunnel login   # opens browser, pick the zone
cloudflared tunnel list | awk '{print $2}' | grep -qx "$NAME" || cloudflared tunnel create "$NAME"
UUID=$(cloudflared tunnel list | awk -v n="$NAME" '$2==n{print $1}')
mkdir -p ~/.cloudflared
cat > ~/.cloudflared/config.yml <<YML
tunnel: $UUID
credentials-file: $HOME/.cloudflared/$UUID.json
ingress:
  - hostname: $HOST
    service: http://localhost:$PORT
  - service: http_status:404
YML
cloudflared tunnel route dns -f "$NAME" "$HOST"
echo "tunnel $NAME ($UUID) -> $HOST -> localhost:$PORT"
echo "Installing cloudflared as a system service (needs sudo)..."
sudo cloudflared service uninstall 2>/dev/null || true
sudo cloudflared service install
echo "done. test: curl -s https://$HOST/health"
