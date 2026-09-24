import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { WebSocket } from 'ws';
import { checkToolAccess, createPolicy, hashPassword } from '../policy.mjs';

const ROOT = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..');
const mainToken = 'a'.repeat(48), macToken = 'b'.repeat(48);

async function setupDir() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-policy-'));
  const allowed = path.join(root, 'allowed'), outside = path.join(root, 'outside');
  await fs.mkdir(allowed); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, '.env'), 'CANARY_ONLY=42\n');
  await fs.symlink(path.join(outside, '.env'), path.join(allowed, 'innocent.txt'));
  await fs.symlink(path.join(outside, 'new.txt'), path.join(allowed, 'dangling.txt'));
  const file = path.join(root, 'policy.json');
  await fs.writeFile(file, JSON.stringify({ unlockMinutes: 15, targets: { '*': { allow: [allowed] }, vps: { allow: [allowed] } } }));
  return { root, allowed, outside, file };
}

test('locked policy fails closed on execution and secret or escaping paths', async () => {
  const d = await setupDir();
  try {
    const pw = 'correct horse battery staple';
    const p = createPolicy({ file: d.file, passwordHash: hashPassword(pw), log() {} });
    const check = (tool, args) => p.check('vps', tool, args, d.root);
    assert.match(await check('vps__bash', { command: 'true', cwd: d.allowed, stdin: 'payload' }), /^PROTECTED:/);
    assert.match(await check('vps__write_process', { pid: 4, input: 'anything' }), /^PROTECTED:/);
    assert.match(await check('vps__search_files', { path: d.outside, pattern: 'CANARY' }), /^PROTECTED:/);
    assert.match(await check('vps__delete_path', { path: d.allowed }), /^PROTECTED:/);
    assert.match(await check('vps__read_file', { path: path.join(d.allowed, 'innocent.txt') }), /^PROTECTED:/);
    assert.match(await check('vps__write_file', { path: path.join(d.allowed, 'dangling.txt'), content: 'x' }), /^PROTECTED:/);
    assert.equal(await check('vps__write_file', { path: path.join(d.allowed, 'valid.txt'), content: 'x' }), null);
    assert.equal(p.unlock('incorrect').ok, false);
    assert.equal(p.unlock(pw).ok, true);
    assert.equal(await check('vps__bash', { command: 'true' }), null);
    p.lock();
    assert.match(await check('vps__bash', { command: 'true' }), /^PROTECTED:/);
    assert.match(await checkToolAccess({ tool: 'dc__interact_with_process', args: { pid: 3 }, home: d.root, allowedDirs: [d.allowed] }), /^PROTECTED:/);
  } finally { await fs.rm(d.root, { recursive: true, force: true }); }
});

test('plaintext password and missing hash must fail at startup', () => {
  assert.throws(() => createPolicy({}), /UNLOCK_PASSWORD_HASH/);
  assert.throws(() => hashPassword('short'), /at least 16/);
});

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('HTTP auth, device scope and no URL credentials', { timeout: 20000 }, async () => {
  const d = await setupDir(), port = await freePort();
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT,
    env: { ...process.env, HOME: d.root, BIND: '127.0.0.1', PORT: String(port), LOCAL_NAME: 'vps',
      BRIDGE_TOKEN: mainToken, DEVICE_TOKENS_JSON: JSON.stringify({ mac: macToken }),
      UNLOCK_PASSWORD_HASH: hashPassword('correct horse battery staple'), POLICY_FILE: d.file,
      AUDIT_LOG: path.join(d.root, 'audit.log'), BRIDGE_HOST: 'example.invalid', BRIDGE_HEARTBEAT_MS: '100' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let agent;
  let log = ''; child.stderr.on('data', b => { log += b; }); child.stdout.on('data', b => { log += b; });
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null) throw new Error(`server exited: ${log}`);
      try { const r = await fetch(base + '/health'); if (r.ok) { up = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(up, `server did not start: ${log}`);
    const auth = token => ({ Authorization: `Bearer ${token}` });
    assert.deepEqual(await (await fetch(base + '/health')).json(), { ok: true });
    assert.equal((await fetch(base + '/devices', { headers: auth(macToken) })).status, 401);
    assert.equal((await fetch(base + '/devices', { headers: auth(mainToken) })).status, 200);
    assert.equal((await fetch(base + '/devices?token=' + mainToken)).status, 401);
    const status = await (await fetch(base + '/device-status?name=mac', { headers: auth(macToken) })).json();
    assert.equal(status.online, false);
    assert.equal((await fetch(base + '/device-status?name=android', { headers: auth(macToken) })).status, 401);
    const script = await (await fetch(base + '/install-device.sh?name=mac', { headers: auth(mainToken) })).text();
    assert.ok(script.includes(macToken)); assert.ok(!script.includes(mainToken));
    assert.equal(spawnSync('sh', ['-n'], {input:script}).status, 0, 'generated installer must parse as POSIX shell');
    const client = await (await fetch(base + '/client.py', {headers:auth(mainToken)})).text();
    assert.equal(spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], {input:client}).status, 0, 'generated helper must parse as Python');
    const denied = await fetch(base + '/exec', { method: 'POST', headers: { ...auth(mainToken), 'Content-Type': 'application/json' }, body: JSON.stringify({command:'true'}) });
    assert.equal(denied.status, 400); assert.match(JSON.stringify(await denied.json()), /PROTECTED/);
    const password = 'correct horse battery staple';
    const unlocked = await fetch(base + '/unlock', { method:'POST', headers:{...auth(mainToken), 'Content-Type':'application/json'}, body:JSON.stringify({password}) });
    assert.equal(unlocked.status, 200);
    const envTest = await fetch(base + '/exec', { method: 'POST', headers: { ...auth(mainToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({command:'node -e "console.log(JSON.stringify({hash:process.env.UNLOCK_PASSWORD_HASH||null,token:process.env.BRIDGE_TOKEN||null}))"'}) });
    assert.equal(envTest.status, 200);
    assert.deepEqual(JSON.parse((await envTest.json()).stdout.trim()), {hash:null,token:null});
    const auditLog = await fs.readFile(path.join(d.root, 'audit.log'), 'utf8');
    assert.ok(!auditLog.includes(password) && !auditLog.includes(mainToken));
    await fetch(base + '/lock', {method:'POST', headers:auth(mainToken)});
    assert.equal((await fetch(base + '/exec?rid=123&command=true', { headers: auth(mainToken) })).status, 404);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/device?name=mac`, ['arena-device-v1', `auth.${mainToken}`]);
    const outcome = await new Promise(resolve => { ws.on('open', () => resolve('opened')); ws.on('error', () => resolve('denied')); });
    assert.equal(outcome, 'denied'); ws.terminate();
    agent = spawn(process.execPath, ['device-agent.mjs'], { cwd: ROOT, env: { ...process.env,
      HOME: d.root, HUB_URL: base, BRIDGE_TOKEN: macToken, DEVICE_NAME: 'mac', DEVICE_WATCHDOG_MS: '500' }, stdio: ['ignore', 'pipe', 'pipe'] });
    agent.stdout.on('data', b => { log += b; }); agent.stderr.on('data', b => { log += b; });
    let online = false;
    for (let i = 0; i < 100; i++) {
      if (agent.exitCode !== null) throw new Error(`device exited: ${log}`);
      const state = await (await fetch(base + '/device-status?name=mac', { headers: auth(macToken) })).json();
      if (state.online) { online = true; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(online, `device did not connect: ${log}`);
    const connectedAt = (await (await fetch(base + '/devices', { headers: auth(mainToken) })).json()).devices[0].connectedAt;
    await new Promise(resolve => setTimeout(resolve, 1300));
    assert.equal((await (await fetch(base + '/devices', { headers: auth(mainToken) })).json()).devices[0].connectedAt, connectedAt, `idle device unexpectedly reconnected: ${log}`);
    const call = async (tool, args) => (await (await fetch(base + '/call', { method: 'POST', headers: { ...auth(mainToken), 'Content-Type': 'application/json' }, body: JSON.stringify({tool, args}) })).json());
    const secretViaSymlink = await call('mac__read_file', {path:path.join(d.allowed,'innocent.txt')});
    assert.equal(secretViaSymlink.ok, false); assert.match(secretViaSymlink.text, /PROTECTED/);
    const shell = await call('mac__bash', {command:'true'});
    assert.equal(shell.ok, false); assert.match(shell.text, /PROTECTED/);

  } finally {
    if (agent) { agent.kill('SIGTERM'); await new Promise(resolve => agent.once('exit', resolve)); }
    child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve));
    await fs.rm(d.root, { recursive: true, force: true });
  }
});
