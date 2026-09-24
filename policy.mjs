// Defense-in-depth policy. Arbitrary execution is NEVER allowed while locked.
// Filesystem confinement also needs OS-level separation to resist a malicious agent.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const EXECUTION = new Set(['bash', 'start_process', 'write_process', 'kill_process', 'self_update', 'read_process_output', 'list_processes', 'delete_path']);
const SCOPED_WRITES = new Set(['write_file', 'edit_file', 'write_file_base64']);
const SCOPED_READS = new Set(['read_file', 'read_file_base64', 'list_dir']);
const SECRET_PATTERNS = [
  /(^|\/)audit\.log$/, /(^|\/)\.arena-device(\/|$)/, /(^|\/)\.ssh(\/|$)/, /(^|\/)\.gnupg(\/|$)/, /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.config\/gcloud(\/|$)/, /(^|\/)\.env($|\.[^/]*$)/,
  /(^|\/)\.netrc$/, /(^|\/)\.npmrc$/, /(^|\/)\.git-credentials$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)(shadow|master\.key)$/,
];
const isSecret = p => SECRET_PATTERNS.some(re => re.test(p));

export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 16) throw new Error('unlock password must contain at least 16 characters');
  const salt = randomBytes(32);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex')}`;
}
function verifyHash(password, encoded) {
  const m = /^scrypt\$([0-9a-f]{64})\$([0-9a-f]{64})$/.exec(encoded || '');
  if (!m) throw new Error('invalid UNLOCK_PASSWORD_HASH; expected scrypt$<64 hex salt>$<64 hex digest>');
  const actual = scryptSync(String(password || ''), Buffer.from(m[1], 'hex'), 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(actual, Buffer.from(m[2], 'hex'));
}

export const normalizePath = (value, home) => {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('invalid path');
  let p = value.replace(/^\$HOME(?=\/|$)/, '~');
  if (!p || p === '~') return path.posix.normalize(home);
  if (p.startsWith('~/')) return path.posix.resolve(home, p.slice(2));
  return path.posix.resolve(home, p);
};
const inside = (p, dirs) => dirs.some(d => p === d || p.startsWith(d.endsWith('/') ? d : d + '/'));

// Resolve even a yet-to-be-created target, including a dangling symlink in the path.
// This is defense in depth, not atomic confinement against races; use OS isolation for that.
export async function canonicalPath(value) {
  let current = value, tail = [], hops = 0;
  for (;;) {
    if (++hops > 128) throw new Error('path resolution exceeded maximum depth');
    try {
      return path.posix.resolve(await fsp.realpath(current), ...tail.reverse());
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const st = await fsp.lstat(current).catch(err => { if (err.code === 'ENOENT') return null; throw err; });
      if (st?.isSymbolicLink()) {
        current = path.posix.resolve(path.posix.dirname(current), await fsp.readlink(current));
        continue;
      }
      const parent = path.posix.dirname(current);
      if (parent === current) throw e;
      tail.push(path.posix.basename(current));
      current = parent;
    }
  }
}

// Also run this check on the device itself: the hub cannot resolve symlinks on a remote filesystem.
export async function checkToolAccess({ tool, args = {}, home, allowedDirs, unlocked = false, canonical = true }) {
  if (unlocked) return null;
  const denied = reason => `PROTECTED: ${reason}; request unlock for this operation`;
  const name = tool.includes('__') ? tool.slice(tool.indexOf('__') + 2) : tool;
  // Third-party MCP tools are not safely classified by name or arbitrary schemas.
  if (tool.startsWith('dc__')) return denied('proxied MCP tools require unlock');
  if (EXECUTION.has(name) || name === 'search_files') return denied(`${name} requires unlock`);
  if (name === 'sysinfo') return null;
  if (!SCOPED_READS.has(name) && !SCOPED_WRITES.has(name)) return denied(`unknown tool ${name}`);
  const p = args.path ?? (name === 'list_dir' ? '~' : undefined);
  if (typeof p !== 'string') return denied('a valid path is required');
  try {
    const requested = normalizePath(p, home);
    const resolved = canonical ? await canonicalPath(requested) : requested;
    const dirs = canonical ? await Promise.all(allowedDirs.map(canonicalPath)) : allowedDirs;
    if (!inside(resolved, dirs)) return denied(`${resolved} is outside authorized directories`);
    if (name !== 'list_dir' && (isSecret(requested) || isSecret(resolved))) return denied(`${resolved} looks like a credential`);
    return null;
  } catch (e) { return denied(`cannot verify path: ${e.message}`); }
}

export function createPolicy({ file, passwordHash, disabled = false, log = console.log }) {
  if (!disabled) verifyHash('', passwordHash); // validate at startup; fail closed
  let settings = { unlockMinutes: 15, targets: { '*': { allow: ['~'] } } };
  if (file) {
    try { settings = { ...settings, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
    catch (e) { throw new Error(`policy file missing or invalid: ${e.message}`); }
  }
  if (!Number.isInteger(settings.unlockMinutes) || settings.unlockMinutes < 1 || settings.unlockMinutes > 60) throw new Error('unlockMinutes must be between 1 and 60');
  let unlockedUntil = 0, failures = 0, lockoutUntil = 0;
  const isUnlocked = () => !disabled && Date.now() < unlockedUntil;
  const allowedFor = (target, home) => {
    const t = settings.targets?.[target] || settings.targets?.['*'];
    if (!t || !Array.isArray(t.allow) || !t.allow.length) throw new Error(`no allowed directories configured for ${target}`);
    return t.allow.map(p => normalizePath(p, home));
  };
  const check = (target, tool, args, home, { canonical = true } = {}) =>
    disabled ? Promise.resolve(null) : checkToolAccess({ tool, args, home, allowedDirs: allowedFor(target, home), unlocked: isUnlocked(), canonical });
  const unlock = pw => {
    if (disabled) return { ok: false, error: 'directory policy explicitly disabled' };
    if (Date.now() < lockoutUntil) return { ok: false, error: `too many failures, retry in ${Math.ceil((lockoutUntil - Date.now()) / 1000)}s` };
    if (!verifyHash(pw, passwordHash)) {
      failures++;
      if (failures >= 5) { lockoutUntil = Date.now() + 60_000; failures = 0; }
      log('unlock: wrong password');
      return { ok: false, error: 'wrong password' };
    }
    failures = 0; unlockedUntil = Date.now() + settings.unlockMinutes * 60_000;
    log(`unlocked for ${settings.unlockMinutes} min`);
    return { ok: true, unlockedUntil: new Date(unlockedUntil).toISOString(), minutes: settings.unlockMinutes };
  };
  const lock = () => { unlockedUntil = 0; log('locked'); return { ok: true, unlocked: false }; };
  const status = homes => ({ enabled: !disabled, unlocked: isUnlocked(), unlockedUntil: isUnlocked() ? new Date(unlockedUntil).toISOString() : null, unlockMinutes: settings.unlockMinutes,
    targets: Object.fromEntries(Object.entries(homes).map(([t, home]) => [t, allowedFor(t, home)])) });
  return { enabled: !disabled, check, unlock, lock, status, allowedFor, isUnlocked };
}
