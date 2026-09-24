// Shared local tools, used by the hub (server.mjs) for its own machine and by device-agent.mjs on Mac/Termux/Linux.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export function createBuiltins(opts = {}) {
  const HOME = opts.home || process.env.HOME || os.homedir();
  const SHELL = opts.shell || process.env.BRIDGE_SHELL
    || ['/bin/zsh', '/bin/bash', '/bin/sh'].find(f => fs.existsSync(f))
    || process.env.SHELL || 'sh'; // Termux has no /bin; 'sh' resolves via PATH
  const MAX_OUT = opts.maxOutputChars || Number(process.env.MAX_OUTPUT_CHARS) || 200_000;
  const DEFAULT_TIMEOUT = opts.defaultTimeoutSec || Number(process.env.DEFAULT_TIMEOUT_SEC) || 90;
  const MAX_TIMEOUT = opts.maxTimeoutSec || Number(process.env.MAX_TIMEOUT_SEC) || 1800;
  const MAX_B64_BYTES = 8 * 1024 * 1024;
  // Never inherit bridge credentials or unlock configuration into user-controlled commands.
  const shellEnv = () => Object.fromEntries(
    ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL', 'TZ', 'PREFIX'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])
  );
  const childEnv = () => ({ ...shellEnv(), HOME, TERM: 'dumb' });

  const expand = p => {
    if (!p || p === '~') return HOME;
    if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
    return path.resolve(HOME, p); // relative paths resolve against HOME
  };
  const trunc = (s, n = MAX_OUT) => (s.length > n ? s.slice(0, n) + `\n...[truncated ${s.length - n} chars]` : s);
  const textResult = (text, isError = false) => ({ content: [{ type: 'text', text: String(text) }], isError });
  const jsonResult = obj => textResult(JSON.stringify(obj, null, 2));

  function runShell({ command, cwd, timeout_sec, stdin }) {
    const t = Math.min(Number(timeout_sec) || DEFAULT_TIMEOUT, MAX_TIMEOUT);
    return new Promise(resolve => {
      let out = '', err = '', timedOut = false, done = false, child;
      try {
        child = spawn(SHELL, ['-lc', command], { cwd: expand(cwd), env: childEnv(), detached: true });
      } catch (e) { return resolve({ code: -1, stdout: '', stderr: String(e), timedOut: false }); }
      const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, t * 1000);
      child.stdout.on('data', d => { if (out.length < MAX_OUT * 2) out += d; });
      child.stderr.on('data', d => { if (err.length < MAX_OUT * 2) err += d; });
      child.on('error', e => { if (!done) { done = true; clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: String(e), timedOut }); } });
      child.on('close', (code, signal) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, signal, timedOut, stdout: trunc(out), stderr: trunc(err) }); });
      if (stdin) child.stdin.end(stdin); else child.stdin.end();
    });
  }

  // ---- long-running process sessions (start / read / write / kill / list) ----
  const sessions = new Map(); // pid -> {child, command, buf, exited, code, signal, startedAt, waiters}
  const MAX_BUF = 500_000;
  function pushBuf(s, text) { s.buf += text; if (s.buf.length > MAX_BUF) s.buf = s.buf.slice(-MAX_BUF); for (const w of s.waiters.splice(0)) w(); }
  function waitOutput(s, ms) { return new Promise(r => { if (s.buf || s.exited) return r(); const t = setTimeout(() => { s.waiters = s.waiters.filter(x => x !== done); r(); }, ms); const done = () => { clearTimeout(t); r(); }; s.waiters.push(done); }); }
  function takeOutput(s) { const o = s.buf; s.buf = ''; return o; }

  const tools = {
    start_process: {
      description: 'Start a long-running or interactive process in its own shell session (returns pid). Output is collected until you read it with read_process_output; send stdin with write_process. Use this instead of bash for anything over the request timeout (servers, builds, REPLs, downloads).',
      inputSchema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, wait_ms: { type: 'number', description: 'how long to wait for initial output (default 2000)' } }, required: ['command'] },
      run: async ({ command, cwd, wait_ms = 2000 }) => {
        const child = spawn(SHELL, ['-lc', command], { cwd: expand(cwd), env: childEnv(), detached: true });
        const s = { child, command, buf: '', exited: false, code: null, signal: null, startedAt: new Date().toISOString(), waiters: [] };
        sessions.set(child.pid, s);
        child.stdout.on('data', d => pushBuf(s, d.toString()));
        child.stderr.on('data', d => pushBuf(s, d.toString()));
        child.on('error', e => pushBuf(s, `[spawn error] ${e.message}\n`));
        child.on('close', (code, signal) => { s.exited = true; s.code = code; s.signal = signal; pushBuf(s, ''); });
        await waitOutput(s, wait_ms);
        return jsonResult({ pid: child.pid, exited: s.exited, code: s.code, output: takeOutput(s) });
      },
    },
    read_process_output: {
      description: 'Read new output from a process started with start_process (waits up to wait_ms for more, default 5000). Returns exited/code when it has finished.',
      inputSchema: { type: 'object', properties: { pid: { type: 'number' }, wait_ms: { type: 'number' } }, required: ['pid'] },
      run: async ({ pid, wait_ms = 5000 }) => {
        const s = sessions.get(Number(pid)); if (!s) return textResult(`no such session pid ${pid}`, true);
        await waitOutput(s, Math.min(wait_ms, MAX_TIMEOUT * 1000));
        const r = { pid: Number(pid), exited: s.exited, code: s.code, signal: s.signal, output: takeOutput(s) };
        if (s.exited) sessions.delete(Number(pid));
        return jsonResult(r);
      },
    },
    write_process: {
      description: 'Write to the stdin of a running process session (a newline is appended unless raw=true).',
      inputSchema: { type: 'object', properties: { pid: { type: 'number' }, input: { type: 'string' }, raw: { type: 'boolean' } }, required: ['pid', 'input'] },
      run: async ({ pid, input, raw }) => {
        const s = sessions.get(Number(pid)); if (!s || s.exited) return textResult(`no running session pid ${pid}`, true);
        s.child.stdin.write(raw ? input : input + '\n'); await waitOutput(s, 1500);
        return jsonResult({ pid: Number(pid), output: takeOutput(s) });
      },
    },
    kill_process: {
      description: 'Kill a process session (whole process group) started with start_process, or any pid on this machine.',
      inputSchema: { type: 'object', properties: { pid: { type: 'number' }, signal: { type: 'string' } }, required: ['pid'] },
      run: async ({ pid, signal = 'SIGTERM' }) => {
        pid = Number(pid);
        try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch (e) { return textResult(`kill failed: ${e.message}`, true); } }
        return textResult(`sent ${signal} to ${pid}`);
      },
    },
    list_processes: {
      description: 'List process sessions started with start_process on this machine (pid, command, running/exited, pending output size).',
      inputSchema: { type: 'object', properties: {} },
      run: async () => jsonResult([...sessions.entries()].map(([pid, s]) => ({ pid, command: s.command.slice(0, 120), startedAt: s.startedAt, exited: s.exited, code: s.code, pendingOutput: s.buf.length }))),
    },
    bash: {
      description: `Run a shell command (${SHELL} -lc). cwd defaults to HOME (${HOME}); ~ is expanded. Default timeout ${DEFAULT_TIMEOUT}s, max ${MAX_TIMEOUT}s; for anything longer use start_process + read_process_output.`,
      inputSchema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, timeout_sec: { type: 'number' }, stdin: { type: 'string' } }, required: ['command'] },
      run: async a => jsonResult(await runShell(a)),
    },
    read_file: {
      description: 'Read a UTF-8 text file. Optional offset/limit are 1-based line numbers. For binary use read_file_base64 or GET /files.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['path'] },
      run: async ({ path: p, offset, limit }) => {
        let text = await fsp.readFile(expand(p), 'utf8');
        if (offset || limit) { const lines = text.split('\n'); const s = Math.max(0, (offset || 1) - 1); text = lines.slice(s, limit ? s + limit : undefined).join('\n'); }
        return textResult(trunc(text));
      },
    },
    write_file: {
      description: 'Write (overwrite or append) a UTF-8 text file, creating parent directories.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean' } }, required: ['path', 'content'] },
      run: async ({ path: p, content, append }) => {
        const f = expand(p); await fsp.mkdir(path.dirname(f), { recursive: true });
        await (append ? fsp.appendFile(f, content) : fsp.writeFile(f, content));
        return textResult(`wrote ${Buffer.byteLength(content)} bytes to ${f}`);
      },
    },
    edit_file: {
      description: 'Exact string replacement in a text file. Fails if old_string is missing, or ambiguous unless replace_all=true.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['path', 'old_string', 'new_string'] },
      run: async ({ path: p, old_string, new_string, replace_all }) => {
        const f = expand(p); const text = await fsp.readFile(f, 'utf8'); const n = text.split(old_string).length - 1;
        if (n === 0) return textResult('old_string not found', true);
        if (n > 1 && !replace_all) return textResult(`old_string found ${n} times; set replace_all=true`, true);
        await fsp.writeFile(f, replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, () => new_string));
        return textResult(`replaced ${replace_all ? n : 1} occurrence(s) in ${f}`);
      },
    },
    list_dir: {
      description: 'List a directory (non-recursive): name, type, size, mtime.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      run: async ({ path: p } = {}) => {
        const d = expand(p); const ents = await fsp.readdir(d, { withFileTypes: true });
        const rows = await Promise.all(ents.map(async e => { const st = await fsp.stat(path.join(d, e.name)).catch(() => null);
          return { name: e.name, type: e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'link' : 'file', size: st?.size, mtime: st?.mtime }; }));
        return jsonResult({ dir: d, entries: rows });
      },
    },
    search_files: {
      description: 'Recursive text search (grep -rnI). glob filters file names e.g. "*.py". Max 300 matches.',
      inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'] },
      run: async ({ pattern, path: p, glob }) => {
        const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
        const r = await runShell({ command: `grep -rnI --exclude-dir=node_modules --exclude-dir=.git ${glob ? `--include=${q(glob)}` : ''} -e ${q(pattern)} ${q(expand(p))} | head -300` });
        return textResult(r.stdout || '(no matches)');
      },
    },
    delete_path: {
      description: 'Delete a file or directory recursively.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      run: async ({ path: p }) => { const f = expand(p); await fsp.rm(f, { recursive: true, force: true }); return textResult(`deleted ${f}`); },
    },
    read_file_base64: {
      description: 'Read an authorized file (binary ok, <=8MB) as base64.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      run: async ({ path: p }) => {
        const f = expand(p); const st = await fsp.stat(f);
        if (st.size > MAX_B64_BYTES) return textResult(`file too large (${st.size} bytes)`, true);
        return { content: [{ type: 'text', text: (await fsp.readFile(f)).toString('base64') }], _binary: true, size: st.size };
      },
    },
    write_file_base64: {
      description: 'Write base64 data to a file (binary ok), creating parent directories.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, data: { type: 'string' } }, required: ['path', 'data'] },
      run: async ({ path: p, data }) => {
        const f = expand(p); await fsp.mkdir(path.dirname(f), { recursive: true });
        const buf = Buffer.from(data, 'base64');
        if (buf.length > MAX_B64_BYTES) return textResult(`file too large (${buf.length} bytes)`, true);
        await fsp.writeFile(f, buf);
        return textResult(`wrote ${buf.length} bytes to ${f}`);
      },
    },
    sysinfo: {
      description: 'Platform, hostname, home, shell, uptime, current time.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => jsonResult({ platform: os.platform(), release: os.release(), arch: os.arch(), hostname: os.hostname(), home: HOME, shell: SHELL, uptime: os.uptime(), now: new Date().toISOString(), node: process.version }),
    },
  };

  const listTools = () => Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema }));
  async function callTool(name, args = {}) {
    const t = tools[name]; if (!t) return textResult(`unknown tool: ${name}`, true);
    try { return await t.run(args || {}); } catch (e) { return textResult(`error: ${e.message}`, true); }
  }
  const addTool = (name, t) => { tools[name] = t; };
  return { tools, listTools, callTool, addTool, runShell, expand, textResult, jsonResult, HOME, SHELL, DEFAULT_TIMEOUT, MAX_TIMEOUT };
}
