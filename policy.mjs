// Directory policy + password unlock. Enforced centrally on the hub for every target (hub, proxied MCP, devices).
// - Read-only tools are always allowed.
// - Mutating tools (write/edit/delete/bash/start_process/...) touching a path outside the target's allowed
//   directories return a PROTECTED error until the hub is unlocked with the password (time-limited).
// - bash/start_process checks are heuristic: cwd + every path-looking token in the command; ".." always counts as outside.
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';

// Truly read-only tools: always allowed (subject to the sensitive-file guard below).
const READ_ONLY = new Set(['read_file', 'list_dir', 'search_files', 'read_file_base64', 'sysinfo', 'list_processes', 'read_process_output',
  'get_config', 'read_multiple_files', 'get_file_info', 'list_sessions',
  'get_usage_stats', 'get_recent_tool_calls', 'get_prompts', 'list_searches', 'get_more_search_results', 'stop_search', 'start_search', 'list_directory']);
// File-content readers whose target path must not be a credential/secret unless unlocked.
const READ_FILE_TOOLS = new Set(['read_file', 'read_file_base64', 'read_multiple_files']);
// State changers that carry no path to scope (kill_process / self_update): gated wholesale until unlocked.
// NOTE: write_process (stdin to a running session) is intentionally left allowed for interactive debugging.
const SENSITIVE_META = new Set(['kill_process', 'self_update']);
// Credential/secret path patterns, tested against resolved absolute paths.
const SENSITIVE_RE = [
  /(^|\/)\.ssh(\/|$)/, /(^|\/)\.gnupg(\/|$)/, /(^|\/)\.aws(\/|$)/, /(^|\/)\.config\/gcloud(\/|$)/,
  /(^|\/)\.env($|\.[^/]*$)/, /(^|\/)\.netrc$/, /(^|\/)\.npmrc$/, /(^|\/)\.git-credentials$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, /\.(pem|key|p12|pfx|keystore|jks)$/i, /(^|\/)(shadow|master\.key)$/,
];
const isSensitive = p => SENSITIVE_RE.some(re => re.test(String(p)));
// Credential-read protection is ON by default; set SENSITIVE_READ_OPEN=1 to allow reading secrets without unlock.
const SENSITIVE_READ_OPEN = /^(1|true|yes|on)$/i.test(String(process.env.SENSITIVE_READ_OPEN || ''));

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
    const unlockHint = `Tell the user exactly which path/command needs access and ask for the unlock password, then run: python3 b.py unlock <password>  (unlocks everything for ${policy.unlockMinutes} min). Never guess the password; do not retry before unlocking.`;
    // Credential/secret reads require unlock even though reading is otherwise free (blocks token-leak exfiltration).
    if (!SENSITIVE_READ_OPEN && READ_FILE_TOOLS.has(base)) {
      const secret = pathsOf(base, args, home).find(isSensitive);
      if (secret) return `PROTECTED: ${secret} looks like a credential/secret file on "${target}"; reading it requires unlock. ${unlockHint}`;
    }
    if (READ_ONLY.has(base)) return null;
    // State-changing tools with no path to scope (kill_process / self_update): gate wholesale until unlocked.
    if (SENSITIVE_META.has(base)) return `PROTECTED: "${base}" changes machine state on "${target}" and requires unlock. ${unlockHint}`;
    const dirs = allowedFor(target, home);
    const bad = pathsOf(base, args, home).filter(p => !inside(p, dirs));
    if (!bad.length) return null;
    return `PROTECTED: ${bad[0] === '/..outside..' ? '".." in command' : bad[0]} is outside the authorized directories of "${target}" (allowed: ${dirs.join(', ')}). ` + unlockHint;
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
  const status = (homes) => ({ enabled, unlocked: isUnlocked(), unlockedUntil: isUnlocked() ? new Date(unlockedUntil).toISOString() : null, unlockMinutes: policy.unlockMinutes, sensitiveReadProtected: !SENSITIVE_READ_OPEN,
    targets: Object.fromEntries(Object.entries(homes).map(([t, home]) => [t, allowedFor(t, home)])) });
  const defaultCwd = (target, home) => (!enabled || isUnlocked()) ? undefined : (inside(home, allowedFor(target, home)) ? undefined : allowedFor(target, home)[0]);
  return { enabled, check, unlock, lock, status, defaultCwd };
}
