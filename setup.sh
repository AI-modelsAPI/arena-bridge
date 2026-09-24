#!/bin/zsh
# Usage: ./setup.sh bridge.yourdomain.com
# Creates config.json with a random token and your hostname, installs deps.
set -e
umask 077
cd "$(dirname "$0")"
HOST=${1:?usage: ./setup.sh <hostname>}
if [[ -f config.json ]]; then
  echo "config.json exists; only updating hostname"
  node -e "const f='config.json',c=require('./'+f);c.hostname=process.argv[1];require('fs').writeFileSync(f,JSON.stringify(c,null,2)+'\n')" "$HOST"
else
  TOKEN=$(openssl rand -hex 24)
  node -e "const c=require('./config.example.json');c.token=process.argv[1];c.hostname=process.argv[2];require('fs').writeFileSync('config.json',JSON.stringify(c,null,2)+'\n')" "$TOKEN" "$HOST"
  echo "config.json created with a private token (not printed)"
fi
[[ -d node_modules ]] || npm install
echo "NOTE: legacy Mac-hub service scripts are not migrated to per-device tokens and hashed-password env. Configure the VPS path in README before deployment."
