#!/bin/bash
# Usage (on the server, as root):  bash nginx/install.sh            # reads BRIDGE_HOST / BRIDGE_PORT from ../.env
# Installs the :80 site, obtains a Let's Encrypt cert via certbot --nginx, then enables :443.
set -e
cd "$(dirname "$0")/.."; source .env
HOST=${BRIDGE_HOST:?BRIDGE_HOST missing in .env}; PORT=${BRIDGE_PORT:-3777}
command -v certbot >/dev/null || { apt-get update && apt-get install -y certbot python3-certbot-nginx; }
mkdir -p /var/www/html
render() { sed "s/__HOST__/$HOST/g; s/__PORT__/$PORT/g" nginx/site.conf.template; }
if [[ ! -f /etc/letsencrypt/live/$HOST/fullchain.pem ]]; then
  render | sed '/#SSL-BLOCK-BELOW/,$d' > /etc/nginx/sites-available/$HOST
  ln -sf /etc/nginx/sites-available/$HOST /etc/nginx/sites-enabled/$HOST
  nginx -t && systemctl reload nginx
  certbot certonly --nginx -d "$HOST" --non-interactive --agree-tos --register-unsafely-without-email
fi
render > /etc/nginx/sites-available/$HOST
ln -sf /etc/nginx/sites-available/$HOST /etc/nginx/sites-enabled/$HOST
nginx -t && systemctl reload nginx && echo "nginx site $HOST -> 127.0.0.1:$PORT enabled with TLS"
