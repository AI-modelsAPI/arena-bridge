#!/usr/bin/env node
// arena-bridge device agent: dials out to the hub and executes tools on this machine.
// Config via env (HUB_URL, BRIDGE_TOKEN, DEVICE_NAME) or args: node device-agent.mjs <hub-url> <token> <name>
// Works on macOS, Linux, Android Termux. Needs Node >= 22 (built-in WebSocket) or the `ws` package.
import os from 'node:os';
import { createBuiltins } from './builtins.mjs';
import { checkToolAccess } from './policy.mjs';

const HUB = (process.env.HUB_URL || process.argv[2] || '').replace(/\/+$/, '');
const TOKEN = process.env.BRIDGE_TOKEN || process.argv[3];
const NAME = (process.env.DEVICE_NAME || process.argv[4] || os.hostname().split('.')[0]).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32);
if (!HUB || !TOKEN) { console.error('usage: HUB_URL=https://host BRIDGE_TOKEN=... DEVICE_NAME=mac node device-agent.mjs'); process.exit(1); }
const log = (...a) => console.log(new Date().toISOString(), `[${NAME}]`, ...a);

const b = createBuiltins({ defaultTimeoutSec: Number(process.env.DEFAULT_TIMEOUT_SEC || 120), maxTimeoutSec: Number(process.env.MAX_TIMEOUT_SEC || 1800) });
const LABEL = process.env.DEVICE_LABEL || '';
const MANAGED = process.env.MANAGED === '1'; // launchd/systemd restarts us on exit
const WS = globalThis.WebSocket ?? (await import('ws')).WebSocket;

// self_update: re-download agent files from the hub and restart.
b.addTool('self_update', {
  description: 'Update this device agent to the hub\'s current version and restart it (the device goes offline for a few seconds).',
  inputSchema: { type: 'object', properties: {} },
  run: async () => {
    const fs = await import('node:fs/promises'); const path = await import('node:path'); const { spawn } = await import('node:child_process');
    const dir = path.dirname(new URL(import.meta.url).pathname);
    for (const f of ['builtins.mjs', 'policy.mjs', 'device-agent.mjs']) {
      const r = await fetch(`${HUB}/${f}`, { headers: { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'arena-bridge-device/1.0' } });
      if (!r.ok) return b.textResult(`download ${f} failed: ${r.status}`, true);
      await fs.writeFile(path.join(dir, f + '.new'), await r.text());
    }
    for (const f of ['builtins.mjs', 'policy.mjs', 'device-agent.mjs']) await fs.rename(path.join(dir, f + '.new'), path.join(dir, f));
    setTimeout(() => {
      if (!MANAGED) { const c = spawn(process.execPath, [path.join(dir, 'device-agent.mjs')], { detached: true, stdio: 'ignore', env: process.env }); c.unref(); }
      process.exit(0);
    }, 800);
    return b.textResult(`updated; restarting ${MANAGED ? '(supervised)' : '(self-spawned)'} - call devices again in ~5s`);
  },
});
const isTermux = !!process.env.TERMUX_VERSION || (process.env.PREFIX || '').includes('com.termux');
const info = { platform: isTermux ? 'android-termux' : os.platform(), hostname: os.hostname(), home: b.HOME, shell: b.SHELL, arch: os.arch(), node: process.version, label: LABEL, version: '0.3.0' };
const url = `${HUB.replace(/^http/, 'ws')}/device?name=${encodeURIComponent(NAME)}`;

let backoff = 1000, ws = null, connected = false, lastActivity = Date.now(), reconnectTimer = null;
function scheduleReconnect(reason) {
  if (reconnectTimer) return;
  connected = false;
  log(`${reason}; retry in ${backoff / 1000}s`);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, backoff);
  backoff = Math.min(backoff * 2, 30_000);
}
function connect() {
  log(`connecting to ${HUB} ...`);
  try { ws = new WS(url, ['arena-device-v1', `auth.${TOKEN}`]); } catch (e) { return scheduleReconnect(`connect failed: ${e.message}`); }
  const me = ws;
  me.onopen = () => { lastActivity = Date.now(); me.send(JSON.stringify({ type: 'hello', name: NAME, info, tools: b.listTools() })); };
  me.onmessage = async ev => {
    lastActivity = Date.now();
    let msg; try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
    if (msg.type === 'welcome') { connected = true; backoff = 1000; log(`online as "${msg.name}" (${info.platform}, home=${info.home}, shell=${info.shell})`); }
    else if (msg.type === 'call') {
      const t0 = Date.now();
      let denied = 'PROTECTED: missing hub policy';
      if (msg.policy && typeof msg.policy.unlocked === 'boolean' && Array.isArray(msg.policy.allowedDirs)) {
        denied = msg.policy.enabled === false ? null : await checkToolAccess({ tool: msg.tool, args: msg.args || {}, home: b.HOME, allowedDirs: msg.policy.allowedDirs, unlocked: msg.policy.unlocked });
      }
      const result = denied ? b.textResult(denied, true) : await b.callTool(msg.tool, msg.args || {});
      log(`${msg.tool} -> ${result.isError ? 'ERR' : 'ok'} ${Date.now() - t0}ms`);
      try { me.send(JSON.stringify({ type: 'result', id: msg.id, result })); } catch (e) { log(`send failed: ${e.message}`); }
    }
  };
  me.onerror = e => { if (ws === me) scheduleReconnect(`socket error: ${e.message || e.type || e}`); };
  me.onclose = ev => { if (ws === me) scheduleReconnect(`disconnected (${ev.code})`); };
}
// keepalive: never let the event loop drain; watchdog: if silent for 90s (hub pings every 30s), force a reconnect.
setInterval(() => {
  if (connected && Date.now() - lastActivity > Number(process.env.DEVICE_WATCHDOG_MS || 90_000)) { log('watchdog: no traffic for 90s, reconnecting'); try { ws?.close(); } catch {} scheduleReconnect('watchdog'); }
}, Math.min(15_000, Number(process.env.DEVICE_WATCHDOG_MS || 90_000) / 3));
connect();
process.on('SIGTERM', () => process.exit(0));
