#!/bin/zsh
# Installs a launchd LaunchAgent so the bridge starts at login and restarts on crash.
set -e
cd "$(dirname "$0")"
DIR=$(pwd); NODE=$(command -v node); LABEL=com.arena-bridge
PLIST=~/Library/LaunchAgents/$LABEL.plist
mkdir -p ~/Library/LaunchAgents ~/Library/Logs
cat > "$PLIST" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/server.mjs</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname $NODE):/usr/local/bin:/usr/bin:/bin:$HOME/homebrew/bin</string><key>HOME</key><string>$HOME</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/arena-bridge.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/arena-bridge.log</string>
</dict></plist>
XML
launchctl bootout gui/$(id -u) "$PLIST" 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$PLIST"
sleep 2
curl -s localhost:$(node -p "require('./config.json').port||3777")/health && echo
echo "installed. logs: tail -f ~/Library/Logs/arena-bridge.log ; restart: launchctl kickstart -k gui/$(id -u)/$LABEL"
