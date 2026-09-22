// Directory policy + password unlock. Enforced centrally on the hub for every target (hub, proxied MCP, devices).
// - Read-only tools are always allowed.
// - Mutating tools (write/edit/delete/bash/start_process/...) touching a path outside the target's allowed
//   directories return a PROTECTED error until the hub is unlocked with the password (time-limited).
// - bash/start_process checks are heuristic: cwd + every path-looking token in the command; ".." always counts as outside.
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const READ_ONLY = new Set(['read_file', 'list_dir', 'search_files', 'read_file_base64', 'sysinfo', 'list_processes', 'read_process_output',
  'write_process', 'kill_process', 'self_update', 'get_config', 'read_multiple_files', 'get_file_info', 'list_sessions', 'list_processes',
  'get_usage_stats', 'get_recent_tool_calls', 'get_prompts', 'list_searches', 'get_more_search_results', 'stop_search', 'start_search', 'list_directory']);

export function createPolicy({ file, password, log = console.log }) {
  const enabled = !!password;
  let policy = { unlockMinutes: 15, targets: { '*': { allow: ['~'] } } };
  try { if (file && fs.existsSync(file)) policy = { ...policy, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) { log(`policy.json invalid: ${e.message}`); }
  let unlockedUntil = 0, failures = 0, lockoutUntil = 0;

  const norm = (p, home) => {
    if (!p) return home;
    p = String(p).replace(/^\$HOME(?=\/|$)/, '~').replace(/^"|"$/g, '').replace(/^'|'$/g, '');
    if (p === '~') return home;
    if (p.startsWith('~/')) return path.posix.join(home, p.slice(2));
    if (!p.startsWith('/')) return path.posix.join(home, p);
    return path.posix.normalize(p);
  };
  const allowedFor = (target, home) => {
    const t = policy.targets?.[target] || policy.targets?.['*'] || { allow: ['~'] };
    return (t.allow || []).map(a => norm(a, home));
  };
  const inside = (p, dirs) => dirs.some(d => p === d || p.startsWith(d.endsWith('/') ? d : d + '/'));
  const isUnlocked = () => Date.now() < unlockedUntil;

  // Collect the paths a call would touch.
  function pathsOf(tool, args = {}, home) {
    const out = [];
    for (const k of ['path', 'cwd', 'source', 'destination', 'file_path', 'directory']) if (typeof args[k] === 'string') out.push(norm(args[k], home));
    if (Array.isArray(args.paths)) for (const p of args.paths) out.push(norm(p, home));
    if (tool === 'bash' || tool === 'start_process') {
      if (!args.cwd) out.push(home);
      const cmd = String(args.command || '');
      if (/(^|[\s/])\.\.(\/|\s|$)/.test(cmd)) out.push('/..outside..'); // any ".." escapes -> protected
      for (const m of cmd.matchAll(/(?:^|[\s=:'"(])((?:~|\$HOME|\/)[^\s'"()|;&<>]*)/g)) out.push(norm(m[1], home));
    }
    return out;
  }

  function check(target, tool, args, home) {
    if (!enabled || isUnlocked()) return null;
    const base = tool.includes('__') ? tool.slice(tool.indexOf('__') + 2) : tool;
    if (READ_ONLY.has(base)) return null;
    const dirs = allowedFor(target, home);
    const bad = pathsOf(base, args, home).filter(p => !inside(p, dirs));
    if (!bad.length) return null;
    return `PROTECTED: ${bad[0] === '/..outside..' ? '".." in command' : bad[0]} is outside the authorized directories of "${target}" (allowed: ${dirs.join(', ')}). ` +
      `Tell the user exactly which path/command needs access and ask for the unlock password, then run: python3 b.py unlock <password>  (unlocks everything for ${policy.unlockMinutes} min). Never guess the password; do not retry before unlocking.`;
  }

  function unlock(pw) {
    if (!enabled) return { ok: false, error: 'no UNLOCK_PASSWORD configured; policy disabled' };
    if (Date.now() < lockoutUntil) return { ok: false, error: `too many failures, retry in ${Math.ceil((lockoutUntil - Date.now()) / 1000)}s` };
    const a = Buffer.from(String(pw || '')), b = Buffer.from(password);
    if (a.length !== b.length || !timingSafeEqual(a, b)) { failures++; if (failures >= 5) { lockoutUntil = Date.now() + 60_000; failures = 0; } log('unlock: wrong password'); return { ok: false, error: 'wrong password' }; }
    failures = 0; unlockedUntil = Date.now() + policy.unlockMinutes * 60_000; log(`unlocked for ${policy.unlockMinutes} min`);
    return { ok: true, unlockedUntil: new Date(unlockedUntil).toISOString(), minutes: policy.unlockMinutes };
  }
  const lock = () => { unlockedUntil = 0; log('locked'); return { ok: true, unlocked: false }; };
  const status = (homes) => ({ enabled, unlocked: isUnlocked(), unlockedUntil: isUnlocked() ? new Date(unlockedUntil).toISOString() : null, unlockMinutes: policy.unlockMinutes,
    targets: Object.fromEntries(Object.entries(homes).map(([t, home]) => [t, allowedFor(t, home)])) });
  const defaultCwd = (target, home) => (!enabled || isUnlocked()) ? undefined : (inside(home, allowedFor(target, home)) ? undefined : allowedFor(target, home)[0]);
  return { enabled, check, unlock, lock, status, defaultCwd };
}
