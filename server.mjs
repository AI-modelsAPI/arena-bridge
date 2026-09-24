// arena-bridge hub: one URL + one token exposing tools on this machine, on proxied MCP servers,
// and on remote devices (Mac / Android Termux / Linux) that dial in via WebSocket.
// HTTP (Bearer token required except /health):
//   GET  /health                GET /tools            GET /devices
//   POST /call   {tool,args}    POST /exec {command,cwd,timeout_sec,stdin}   (add "device":"mac" to target a device)
//   GET|PUT|DELETE /files/<path>            local files, raw bytes
//   GET|PUT|DELETE /files/@<device>/<path>  device files, raw bytes (<=8MB)
//   GET  /prompt  /client.py  /device-agent.mjs  /builtins.mjs  /install-device.sh   helpers
//   ALL  /mcp        standard MCP Streamable HTTP (stateless, JSON responses)
// WebSocket: /device?name=<device> (per-device credential sent via subprotocol header)
import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createBuiltins } from './builtins.mjs';
import { buildPrompt } from './make-prompt.mjs';
import { createPolicy } from './policy.mjs';

process.umask(0o077); // files created by the bridge must not be group/world readable
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const cfgFile = ['config.json', 'config.example.json'].map(f => path.join(ROOT, f)).find(f => fs.existsSync(f));
const config = JSON.parse(await fsp.readFile(cfgFile, 'utf8'));
const TOKEN = process.env.BRIDGE_TOKEN || config.token;
if (!TOKEN || TOKEN === 'CHANGE_ME' || !/^[0-9a-f]{48,}$/.test(TOKEN)) throw new Error('BRIDGE_TOKEN must be random and at least 32 characters');
if (process.env.UNLOCK_PASSWORD || config.unlockPassword) throw new Error('plaintext UNLOCK_PASSWORD is no longer supported; migrate to UNLOCK_PASSWORD_HASH');
const DEVICE_TOKENS = new Map(Object.entries(JSON.parse(process.env.DEVICE_TOKENS_JSON || '{}')));
for (const [name, value] of DEVICE_TOKENS) { if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name) || typeof value !== 'string' || !/^[0-9a-f]{48,}$/.test(value) || value === TOKEN) throw new Error('invalid DEVICE_TOKENS_JSON entry'); }
const PORT = Number(process.env.PORT || config.port || 3777);
const BIND = process.env.BIND || '127.0.0.1';
const HOSTNAME = process.env.BRIDGE_HOST || config.hostname;
const LOCAL = (process.env.LOCAL_NAME || config.localName || 'hub').toLowerCase();
const HOME = os.homedir();
const DEVICE_CALL_TIMEOUT = Number(process.env.DEVICE_CALL_TIMEOUT_SEC || 1800) * 1000;
const log = (...a) => console.log(new Date().toISOString(), ...a);

const local = createBuiltins({ defaultTimeoutSec: Number(process.env.DEFAULT_TIMEOUT_SEC || config.defaultTimeoutSec || 90), maxTimeoutSec: Number(process.env.MAX_TIMEOUT_SEC || 95), maxOutputChars: config.maxOutputChars });
const { textResult } = local;
const policy = createPolicy({ file: process.env.POLICY_FILE || path.join(ROOT, 'policy.json'), passwordHash: process.env.UNLOCK_PASSWORD_HASH, disabled: process.env.DISABLE_POLICY === '1', log });
if (!policy.enabled) log('WARNING: directory policy explicitly disabled via DISABLE_POLICY=1');
const homeOf = t => t === LOCAL ? HOME : (devices.get(t)?.info.home || '/');
const homes = () => Object.fromEntries([[LOCAL, HOME], ...[...devices.values()].map(d => [d.name, d.info.home || '/'])]);
const META_TOOLS = [
  { name: 'unlock', description: 'Unlock protected directories on all machines for a limited time. Ask the USER for the password; never guess it.', inputSchema: { type: 'object', properties: { password: { type: 'string' } }, required: ['password'] } },
  { name: 'lock', description: 'Re-lock protected directories immediately.', inputSchema: { type: 'object', properties: {} } },
  { name: 'policy', description: 'Show the authorized directories per machine and whether the hub is currently unlocked.', inputSchema: { type: 'object', properties: {} } },
];

// ---------- proxied stdio MCP servers ----------
const proxies = new Map(); // `${name}__${tool}` -> {client, tool}
async function connectProxies() {
  for (const [name, spec] of Object.entries(config.mcpServers || {})) {
    try {
      const sub = v => String(v).replaceAll('${BRIDGE_DIR}', ROOT).replaceAll('${HOME}', HOME);
      const transport = new StdioClientTransport({ command: sub(spec.command), args: (spec.args || []).map(sub), env: { ...process.env, ...(spec.env || {}) }, cwd: spec.cwd ? local.expand(spec.cwd) : HOME, stderr: 'pipe' });
      transport.stderr?.on('data', d => process.stderr.write(`[${name}] ${d}`));
      const client = new Client({ name: 'arena-bridge', version: '0.2.0' });
      await client.connect(transport, { timeout: 180_000 });
      const { tools } = await client.listTools();
      for (const t of tools) proxies.set(`${name}__${t.name}`, { client, tool: t });
      log(`mcp server "${name}": ${tools.length} tools`);
    } catch (e) { log(`mcp server "${name}" failed to start: ${e.message}`); }
  }
}

// ---------- remote devices ----------
const devices = new Map(); // name -> {name, ws, tools, info, pending, connectedAt}
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
function onDeviceSocket(ws, name) {
  let dev = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'hello') {
      const old = devices.get(name);
      if (old) { log(`device "${name}" reconnected, replacing old socket`); try { old.ws.terminate(); } catch {} }
      dev = { name, ws, tools: msg.tools || [], info: msg.info || {}, pending: new Map(), connectedAt: new Date().toISOString() };
      devices.set(name, dev);
      log(`device "${name}" online: ${dev.tools.length} tools (${dev.info.platform} ${dev.info.hostname})`);
      ws.send(JSON.stringify({ type: 'welcome', name }));
    } else if (msg.type === 'result' && dev) {
      const p = dev.pending.get(msg.id);
      if (p) { dev.pending.delete(msg.id); clearTimeout(p.timer); p.resolve(msg.result); }
    }
  });
  ws.on('close', () => {
    if (dev && devices.get(name) === dev) { devices.delete(name); log(`device "${name}" offline`); }
    for (const p of dev?.pending.values() || []) { clearTimeout(p.timer); p.resolve(textResult('device disconnected during call', true)); }
  });
  ws.on('error', e => log(`device "${name}" socket error: ${e.message}`));
}
function callDevice(dev, tool, args) {
  return new Promise(resolve => {
    const id = randomUUID();
    const timer = setTimeout(() => { dev.pending.delete(id); resolve(textResult(`device call timed out after ${DEVICE_CALL_TIMEOUT / 1000}s`, true)); }, DEVICE_CALL_TIMEOUT);
    dev.pending.set(id, { resolve, timer });
    dev.ws.send(JSON.stringify({ type: 'call', id, tool, args, policy: { enabled: policy.enabled, unlocked: policy.isUnlocked(), allowedDirs: policy.allowedFor(dev.name, dev.info.home || '/') } }), err => { if (err) { dev.pending.delete(id); clearTimeout(timer); resolve(textResult(`send failed: ${err.message}`, true)); } });
  });
}
setInterval(() => { for (const d of devices.values()) { if (!d.ws.isAlive) { log(`device "${d.name}" ping timeout`); d.ws.terminate(); continue; } d.ws.isAlive = false; d.ws.ping(); d.ws.send(JSON.stringify({ type: 'heartbeat' })); } }, Number(process.env.BRIDGE_HEARTBEAT_MS || 30_000)).unref();

// ---------- unified tool registry ----------
function allTools() {
  const mine = local.listTools().map(t => ({ ...t, name: `${LOCAL}__${t.name}`, description: `[${LOCAL}] ${t.description}` }));
  const prox = [...proxies.entries()].map(([name, { tool }]) => ({ name, description: `[${LOCAL}/mcp] ${tool.description || ''}`, inputSchema: tool.inputSchema }));
  const dev = [...devices.values()].flatMap(d => d.tools.map(t => ({ ...t, name: `${d.name}__${t.name}`, description: `[${d.name}] ${t.description || ''}` })));
  return [...META_TOOLS, ...mine, ...prox, ...dev];
}
async function callTool(name, args = {}) {
  const t0 = Date.now();
  let res;
  if (name === 'unlock') { const result = policy.unlock(args.password); audit({ target: LOCAL, tool: 'unlock', ok: result.ok }); return local.jsonResult(result); }
  if (name === 'lock') { const result = policy.lock(); audit({ target: LOCAL, tool: 'lock', ok: true }); return local.jsonResult(result); }
  if (name === 'policy') return local.jsonResult(policy.status(homes()));
  const i = name.indexOf('__');
  const prefix = i > 0 ? name.slice(0, i) : null, rest = i > 0 ? name.slice(i + 2) : name;
  const target = prefix && devices.has(prefix) ? prefix : LOCAL;
  const denied = proxies.has(name) && policy.enabled && !policy.isUnlocked()
    ? 'PROTECTED: proxied MCP tools require unlock'
    : await policy.check(target, name, args, homeOf(target), { canonical: target === LOCAL });
  if (denied) { log(`call ${name} -> PROTECTED`); audit({ target, tool: name, ok: false, decision: 'denied' }); return textResult(denied, true); }
  if (prefix === LOCAL && local.tools[rest]) res = await local.callTool(rest, args);
  else if (!prefix && local.tools[name]) res = await local.callTool(name, args); // bare name = hub machine, for convenience
  else if (proxies.has(name)) {
    const { client, tool } = proxies.get(name);
    res = await client.callTool({ name: tool.name, arguments: args }).catch(e => textResult(`error: ${e.message}`, true));
  } else if (prefix && devices.has(prefix)) res = await callDevice(devices.get(prefix), rest, args);
  else if (prefix && !devices.has(prefix) && !local.tools[name]) res = textResult(`unknown tool or device offline: ${name}. Online devices: ${[...devices.keys()].join(', ') || '(none)'}; hub is "${LOCAL}"`, true);
  else res = textResult(`unknown tool: ${name}`, true);
  log(`call ${name} -> ${res.isError ? 'ERR' : 'ok'} ${Date.now() - t0}ms`);
  const auditName = name === 'unlock' || name === 'lock' ? name : rest;
  if (MUTATING.has(auditName) || proxies.has(name)) audit({ target, tool: name, ok: !res.isError, ms: Date.now() - t0 });
  return res;
}
const flatten = res => ({ ok: !res.isError, isError: !!res.isError, text: (res.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n'), content: res.content });

// ---------- audit log for state-changing calls ----------
// Appends one JSON line per mutating call (write/edit/delete/exec/unlock/lock/kill/self_update/binary write).
// Never record raw arguments. Path: AUDIT_LOG or <HOME>/audit.log; off if AUDIT_LOG=off.
const MUTATING = new Set(['bash', 'start_process', 'write_process', 'kill_process', 'write_file', 'edit_file', 'delete_path', 'write_file_base64', 'self_update', 'unlock', 'lock']);
const AUDIT_PATH = process.env.AUDIT_LOG === 'off' ? null : (process.env.AUDIT_LOG || path.join(HOME, 'audit.log'));
if (AUDIT_PATH) {
  fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true, mode: 0o700 });
  fs.closeSync(fs.openSync(AUDIT_PATH, 'a', 0o600));
  fs.chmodSync(AUDIT_PATH, 0o600); // refuse to start if an existing log is not writable
}
function audit(entry) {
  if (!AUDIT_PATH) return;
  try { fs.appendFileSync(AUDIT_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); } catch (e) { log(`audit write failed: ${e.message}`); }
}
// No raw command, stdin, input, password, or file contents are ever logged.

// ---------- HTTP ----------
const app = express();
app.set('trust proxy', true); app.disable('x-powered-by');
// Avoid leaking URLs in Referer headers (credentials are never accepted in URLs).
app.use((_req, res, next) => { res.set('Referrer-Policy', 'no-referrer'); next(); });
app.get('/health', (_req, res) => res.json({ ok: true }));
app.use((req, res, next) => {
  const h = req.get('authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (t === TOKEN) return next();
  const device = [...DEVICE_TOKENS].find(([, key]) => key === t)?.[0];
  if (device && req.method === 'GET' && ['/device-agent.mjs', '/builtins.mjs', '/policy.mjs'].includes(req.path)) return next();
  if (device && req.method === 'GET' && req.path === '/device-status' && req.query.name === device) return next();
  log(`401 ${req.method} ${req.path} from ${req.ip}`); return res.status(401).json({ error: 'unauthorized' });
});
app.get('/tools', (_req, res) => res.json(allTools()));
app.get('/policy', (_req, res) => res.json(policy.status(homes())));
app.post('/unlock', express.json({ limit: '4kb' }), (req, res) => { const r = policy.unlock(req.body?.password); audit({ target: LOCAL, tool: 'unlock', ok: !!r.ok }); res.status(r.ok ? 200 : 401).json(r); });
app.post('/lock', (_req, res) => { const r = policy.lock(); audit({ target: LOCAL, tool: 'lock', ok: true }); res.json(r); });
app.get('/device-status', (req, res) => res.json({ online: devices.has(req.query.name), name: req.query.name }));
app.get('/devices', (_req, res) => res.json({ hub: { name: LOCAL, platform: os.platform(), hostname: os.hostname(), home: HOME, tools: local.listTools().length + proxies.size },
  devices: [...devices.values()].map(d => ({ name: d.name, ...d.info, tools: d.tools.length, connectedAt: d.connectedAt })) }));
app.post('/call', express.json({ limit: '16mb' }), async (req, res) => {
  const { tool, args } = req.body || {};
  if (!tool) return res.status(400).json({ error: 'tool required' });
  res.json(flatten(await callTool(tool, args || {})));
});
app.post('/exec', express.json({ limit: '1mb' }), async (req, res) => {
  const { command, cwd, timeout_sec, stdin, device } = req.body || {};
  if (!command) return res.status(400).json({ error: 'command required' });
  const target = device || LOCAL;
  log(`exec@${target}`);
  const r = await callTool(`${target}__bash`, { command, cwd, timeout_sec, stdin });
  if (r.isError) return res.status(400).json({ error: flatten(r).text });
  try { res.json(JSON.parse(flatten(r).text)); } catch { res.json(flatten(r)); }
});

app.use('/files', express.raw({ type: () => true, limit: '16mb' }), async (req, res) => {
  const raw = decodeURIComponent(req.path.replace(/^\//, ''));
  const m = raw.match(/^@([^/]+)\/(.*)$/);
  const target = m ? m[1] : LOCAL, p = m ? m[2] : raw;
  try {
    if (req.method === 'GET') {
      const r = await callTool(`${target}__read_file_base64`, { path: p });
      if (r.isError) return res.status(404).json({ error: flatten(r).text });
      const buf = Buffer.from(r.content[0].text, 'base64');
      res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Content-Length', buf.length); res.end(buf);
    } else if (req.method === 'PUT' || req.method === 'POST') {
      if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'binary request body required' });
      const r = await callTool(`${target}__write_file_base64`, { path: p, data: req.body.toString('base64') });
      res.status(r.isError ? 500 : 200).json({ ok: !r.isError, target, path: p, bytes: req.body.length, text: flatten(r).text });
    } else if (req.method === 'DELETE') {
      const r = await callTool(`${target}__delete_path`, { path: p });
      res.status(r.isError ? 500 : 200).json({ ok: !r.isError, text: flatten(r).text });
    } else res.status(405).end();
  } catch (e) { res.status(500).json({ error: e.message }); }
});
const base = req => process.env.PUBLIC_URL || (HOSTNAME && !/example\.com$/.test(HOSTNAME) ? `https://${HOSTNAME}` : `${req.protocol}://${req.get('host')}`);
app.get('/client.py', (req, res) => res.type('text/x-python').send(clientPy(base(req))));
app.get('/prompt', (req, res) => res.type('text/markdown').send(buildPrompt({ base: base(req), token: TOKEN, hub: LOCAL, timeout: local.DEFAULT_TIMEOUT, maxTimeout: local.MAX_TIMEOUT })));
app.get('/install-device.sh', (req, res) => {
  const name = req.query.name;
  if (typeof name !== 'string' || !DEVICE_TOKENS.has(name)) return res.status(400).json({ error: 'use ?name=<registered-device>' });
  res.set('Cache-Control', 'no-store').type('text/x-shellscript').send(installSh(base(req), name, DEVICE_TOKENS.get(name)));
});
app.get('/device-agent.mjs', (_req, res) => res.type('text/javascript').sendFile(path.join(ROOT, 'device-agent.mjs')));
app.get('/builtins.mjs', (_req, res) => res.type('text/javascript').sendFile(path.join(ROOT, 'builtins.mjs')));
app.get('/policy.mjs', (_req, res) => res.type('text/javascript').sendFile(path.join(ROOT, 'policy.mjs')));
app.all('/mcp', express.json({ limit: '16mb' }), async (req, res) => {
  const server = new Server({ name: 'arena-bridge', version: '0.2.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools() }));
  server.setRequestHandler(CallToolRequestSchema, async r => callTool(r.params.name, r.params.arguments || {}));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

function clientPy(base) {
  return `#!/usr/bin/env python3
# arena-bridge helper.  Targets: "${LOCAL}" is the hub machine; devices are named (see: python3 b.py devices).
#   python3 b.py devices                              online devices and their tools
#   python3 b.py exec "ls ~"                          run on the hub
#   python3 b.py exec @mac "ls ~"                     run on device "mac"
#   python3 b.py cat @mac/~/notes.txt                 print text file (hub: omit @name)
#   python3 b.py get @android/~/storage/dcim/x.jpg ./x.jpg      download
#   python3 b.py put ./x.jpg @mac/~/Desktop/x.jpg     upload
#   python3 b.py tools                                all tools (prefixed <target>__)
#   python3 b.py policy | unlock (interactive) | lock    protected-directory policy
#   python3 b.py call mac__edit_file '{"path":"~/a.py","old_string":"x","new_string":"y"}'
import json, sys, urllib.request, urllib.parse, urllib.error
BASE = ${JSON.stringify(base)}; TOKEN = ${JSON.stringify(TOKEN)}; HUB = ${JSON.stringify(LOCAL)}
def req(method, p, data=None, raw=False):
    r = urllib.request.Request(BASE + p, method=method, data=data, headers={"Authorization": "Bearer " + TOKEN, "User-Agent": "arena-bridge-client/1.0 (+python)", "Accept": "*/*", "Content-Type": "application/octet-stream" if raw else "application/json"})
    with urllib.request.urlopen(r, timeout=1800) as resp: return resp.read()
def split(t):  # "@dev/path" -> (dev, path); "path" -> (HUB, path)
    if t.startswith("@"):
        d, _, p = t[1:].partition("/"); return d, p
    return HUB, t
def fpath(t):
    d, p = split(t); return "/files/" + ("@" + d + "/" if d != HUB else "") + urllib.parse.quote(p)
def main(a):
    if not a: print(open(__file__).read().split("import json")[0]); return
    cmd, rest = a[0], a[1:]
    if cmd == "unlock":
        if rest: print("do not supply the password in argv; use interactive input", file=sys.stderr); sys.exit(2)
        import getpass
        pw = getpass.getpass("Unlock password: ") if sys.stdin.isatty() else sys.stdin.readline().rstrip("\\n")
        try: print(req("POST", "/unlock", json.dumps({"password": pw}).encode()).decode())
        except urllib.error.HTTPError as e: print(e.read().decode()); sys.exit(1)
    elif cmd == "lock": print(req("POST", "/lock").decode())
    elif cmd == "policy": print(req("GET", "/policy").decode())
    elif cmd == "devices":
        d = json.loads(req("GET", "/devices")); print("hub:", d["hub"]["name"], d["hub"]["platform"], d["hub"]["hostname"], "-", d["hub"]["tools"], "tools")
        for x in d["devices"]: print("device:", x["name"], ("[" + x["label"] + "]") if x.get("label") else "", x.get("platform"), x.get("hostname"), "home=" + str(x.get("home")), "-", x["tools"], "tools")
    elif cmd == "exec":
        dev = HUB
        if rest and rest[0].startswith("@"): dev, rest = rest[0][1:], rest[1:]
        out = json.loads(req("POST", "/exec", json.dumps({"device": dev, "command": rest[0], "timeout_sec": int(rest[1]) if len(rest) > 1 else None}).encode()))
        if "error" in out: print(out["error"], file=sys.stderr); sys.exit(1)
        sys.stdout.write(out.get("stdout", "")); sys.stderr.write(out.get("stderr", ""))
        if out.get("timedOut"): sys.stderr.write("\\n[timed out]\\n")
        sys.exit(out.get("code") or 0)
    elif cmd == "tools":
        for t in json.loads(req("GET", "/tools")): print(f"{t['name']}: {t.get('description','')[:110]}")
    elif cmd == "call":
        out = json.loads(req("POST", "/call", json.dumps({"tool": rest[0], "args": json.loads(rest[1]) if len(rest) > 1 else {}}).encode()))
        print(out["text"]); sys.exit(0 if out["ok"] else 1)
    elif cmd == "cat":
        d, p = split(rest[0]); out = json.loads(req("POST", "/call", json.dumps({"tool": d + "__read_file", "args": {"path": p}}).encode())); print(out["text"]); sys.exit(0 if out["ok"] else 1)
    elif cmd == "get":
        open(rest[1] if len(rest) > 1 else rest[0].split("/")[-1], "wb").write(req("GET", fpath(rest[0])))
    elif cmd == "put":
        print(req("PUT", fpath(rest[1]), open(rest[0], "rb").read(), raw=True).decode())
    else: print("unknown command", cmd); sys.exit(2)
main(sys.argv[1:])
`;
}

function installSh(base, deviceName, deviceToken) {
  return `#!/bin/sh
# Installs the arena-bridge device agent on this machine (macOS / Termux / Linux) and starts it.
# Usage: sh install-device.sh <device-name> [label]     e.g.  sh install-device.sh mac "我的MacBook"
set -e
NAME=${JSON.stringify(deviceName)}
LABEL=\${2:-\${1:-}}
HUB_URL=${JSON.stringify(base)}
TOKEN=${JSON.stringify(deviceToken)}
umask 077
DIR="$HOME/.arena-device"; mkdir -p "$DIR"
command -v node >/dev/null || { echo "node not found. macOS: brew install node ; Termux: pkg install nodejs-lts"; exit 1; }
for f in device-agent.mjs builtins.mjs policy.mjs; do curl -fsS -H "Authorization: Bearer $TOKEN" "$HUB_URL/$f" -o "$DIR/$f"; done
cat > "$DIR/env" <<ENV
HUB_URL="$HUB_URL"
BRIDGE_TOKEN="$TOKEN"
DEVICE_NAME="$NAME"
DEFAULT_TIMEOUT_SEC=${local.DEFAULT_TIMEOUT}
MAX_TIMEOUT_SEC=${local.MAX_TIMEOUT}
DEVICE_LABEL="$LABEL"
MANAGED=0
ENV
chmod 600 "$DIR/env"
NODE=$(command -v node)
cat > "$DIR/run.sh" <<RUN
#!/bin/sh
set -a; . "$DIR/env"; set +a
exec "$NODE" "$DIR/device-agent.mjs"
RUN
chmod +x "$DIR/run.sh"
if [ "$(uname)" = Darwin ]; then
  sed -i.bak 's/^MANAGED=.*/MANAGED=1/' "$DIR/env" && rm -f "$DIR/env.bak"
  P="$HOME/Library/LaunchAgents/com.arena-device.plist"; mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  cat > "$P" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.arena-device</string>
  <key>ProgramArguments</key><array><string>$DIR/run.sh</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/arena-device.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/arena-device.log</string>
</dict></plist>
PL
  launchctl bootout gui/$(id -u) "$P" 2>/dev/null || true
  launchctl bootstrap gui/$(id -u) "$P"
  echo "macOS: installed as LaunchAgent com.arena-device (log: ~/Library/Logs/arena-device.log)"
elif [ -n "$TERMUX_VERSION" ] || [ -d /data/data/com.termux ]; then
  mkdir -p "$HOME/.termux/boot"
  printf '#!/data/data/com.termux/files/usr/bin/sh\\ntermux-wake-lock\\nnohup %s > %s/agent.log 2>&1 &\\n' "$DIR/run.sh" "$DIR" > "$HOME/.termux/boot/arena-device.sh"
  chmod +x "$HOME/.termux/boot/arena-device.sh"
  command -v termux-wake-lock >/dev/null && termux-wake-lock || true
  pkill -f device-agent.mjs 2>/dev/null || true
  nohup "$DIR/run.sh" > "$DIR/agent.log" 2>&1 &
  echo "Termux: started (log: $DIR/agent.log). Auto-start on boot needs the Termux:Boot app. Run termux-setup-storage once to expose /sdcard as ~/storage."
elif command -v systemctl >/dev/null; then
  sed -i 's/^MANAGED=.*/MANAGED=1/' "$DIR/env"
  mkdir -p "$HOME/.config/systemd/user"
  printf '[Unit]\\nDescription=arena-bridge device agent\\nAfter=network-online.target\\n[Service]\\nExecStart=%s\\nRestart=always\\nRestartSec=5\\n[Install]\\nWantedBy=default.target\\n' "$DIR/run.sh" > "$HOME/.config/systemd/user/arena-device.service"
  systemctl --user daemon-reload && systemctl --user enable --now arena-device && echo "Linux: systemd user service arena-device enabled"
else
  nohup "$DIR/run.sh" > "$DIR/agent.log" 2>&1 & echo "started in background (log: $DIR/agent.log)"
fi
sleep 3; curl -fsS -H "Authorization: Bearer $TOKEN" "$HUB_URL/device-status?name=$NAME" | grep -q '"online":true' && echo "device $NAME is online at the hub" || echo "not visible at hub yet - check the log"
`;
}

const httpServer = app.listen(PORT, BIND, () => log(`arena-bridge hub "${LOCAL}" listening on http://${BIND}:${PORT} shell=${local.SHELL} home=${HOME}`));
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, handleProtocols: protocols => protocols.has('arena-device-v1') ? 'arena-device-v1' : false });
httpServer.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://x');
  const name = (u.searchParams.get('name') || '').toLowerCase();
  const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map(x => x.trim());
  const deviceToken = protocols.find(x => x.startsWith('auth.'))?.slice(5);
  if (u.pathname !== '/device' || !NAME_RE.test(name) || name === LOCAL || !DEVICE_TOKENS.has(name) || deviceToken !== DEVICE_TOKENS.get(name) || !protocols.includes('arena-device-v1')) {
    log(`ws reject ${u.pathname} name=${name} from ${req.socket.remoteAddress}`);
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, ws => onDeviceSocket(ws, name));
});
connectProxies().then(() => log(`ready: ${allTools().length} tools`));
