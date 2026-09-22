#!/bin/zsh
# Usage: ./setup.sh bridge.yourdomain.com
# Creates config.json with a random token and your hostname, installs deps.
set -e
cd "$(dirname "$0")"
HOST=${1:?usage: ./setup.sh <hostname>}
if [[ -f config.json ]]; then
  echo "config.json exists; only updating hostname"
  node -e "const f='config.json',c=require('./'+f);c.hostname=process.argv[1];require('fs').writeFileSync(f,JSON.stringify(c,null,2)+'\n')" "$HOST"
else
  TOKEN=$(openssl rand -hex 24)
  node -e "const c=require('./config.example.json');c.token=process.argv[1];c.hostname=process.argv[2];require('fs').writeFileSync('config.json',JSON.stringify(c,null,2)+'\n')" "$TOKEN" "$HOST"
  echo "config.json created (token: $TOKEN)"
fi
[[ -d node_modules ]] || npm install
echo "next: ./setup-tunnel.sh   then   ./install-service.sh   then   npm run prompt"
