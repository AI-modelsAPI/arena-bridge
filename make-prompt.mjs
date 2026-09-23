// Prompt templates. CLI: node make-prompt.mjs [--short]   (also imported by server.mjs for GET /prompt)
import fs from 'node:fs';

export function buildPrompt({ host, token: T, hub, base, timeout = 90, maxTimeout = 95, getFallback = false }) {
  const B = base || `https://${host}`;
  const getSection = getFallback ? `

### GET fallback (only if your sandbox can ONLY make GET requests)
If your environment cannot POST or run curl/python (e.g. it exposes only a URL-fetch/GET tool), the same two actions are reachable by GET. You MUST send a fresh unique \`rid\` (any random id) on every request - a GET may be prefetched or retried by the platform, and the bridge runs each rid at most once and replays the cached result for repeats, so a duplicated GET never executes twice.
- Exec: \`${B}/exec?token=${T}&rid=<unique>&command=<url-encoded>\` (optional \`&device=mac\`, \`&cwd=~\`, \`&timeout_sec=90\`)
- Tool: \`${B}/call?token=${T}&rid=<unique>&tool=mac__read_file&args=<url-encoded-JSON>\`
- Token may instead be sent as an \`x-token\` header to keep it out of the URL. \`unlock\`/\`lock\` are NOT available over GET - the password must never be in a URL; ask the user and use POST /unlock.
- Prefer POST/MCP whenever your sandbox can; GET is the compatibility fallback only.` : '';
  return `## My machines bridge (use it, don't simulate it)

You run in a sandbox, but you can operate my real machines through an HTTP bridge at ${B}. One hub ("${hub}", the machine running the bridge) plus devices that connect to it (typically "mac" and "android"). Everything below runs from your sandbox shell. Never fabricate results - always actually call the bridge and show the real output.

BASE=${B}
TOKEN=${T}

### Setup (do this first, every session)
\`\`\`bash
curl -s -H "Authorization: Bearer ${T}" ${B}/client.py -o b.py
python3 b.py devices          # which machines are online right now
\`\`\`

### Which machine is which (important)
- **${hub}** = the hub: a cloud server / Docker container. It is NOT the user's own computer. Only use it when the user says server / VPS / 服务器 / 云端, or for scratch work.
- **mac** = the user's own computer. Words like 本机, 我的电脑, 电脑, Mac, 桌面, 下载文件夹 mean mac.
- **android** = the user's phone (Termux). Words like 手机, 相册, 照片, DCIM, 短信 mean android. User files are under ~/storage/shared (= /sdcard).
- \`devices\` may show a label per device (e.g. [我的MacBook]); use labels when the user refers to a machine by that name.
- If the user does not say which machine and it is not obvious from the words above, ask - do not default to the hub.

### Commands
\`\`\`bash
python3 b.py exec @mac "ls ~/Desktop"          # shell on the user's computer
python3 b.py exec @android "ls ~/storage/shared/DCIM"   # shell on the phone
python3 b.py exec "ls ~"                       # shell on the hub (${hub})
python3 b.py cat @mac/~/notes.txt              # read a text file (omit @name for the hub)
python3 b.py get @android/~/storage/shared/DCIM/x.jpg ./x.jpg    # download to sandbox
python3 b.py put ./report.pdf @mac/~/Desktop/report.pdf          # upload from sandbox
python3 b.py tools                             # every tool, named <target>__<tool>
python3 b.py call mac__edit_file '{"path":"~/a.py","old_string":"x","new_string":"y"}'
python3 b.py call mac__start_process '{"command":"npm run build","cwd":"~/proj"}'   # -> pid
python3 b.py call mac__read_process_output '{"pid":12345,"wait_ms":5000}'
\`\`\`
Every target (hub and each device) has the same 15 tools: bash, read_file, write_file, edit_file, list_dir, search_files, delete_path, read_file_base64, write_file_base64, sysinfo, start_process, read_process_output, write_process, kill_process, list_processes. Devices also have self_update. The hub additionally has dc__* (desktop-commander) - not needed for normal work.

### Protected directories & password
Each machine has authorized directories (see \`python3 b.py policy\`). Reading anywhere is fine. Modifying or running commands outside them returns an error starting with **PROTECTED**. When that happens:
1. Stop and tell the user exactly which path or command needs access and on which machine.
2. Ask the user for the unlock password. Never guess it, never reuse anything from earlier context as a password.
3. Run \`python3 b.py unlock <password>\` (unlocks all machines for a limited time), then retry the original step. Do not echo the password back.
4. Run \`python3 b.py lock\` when the sensitive work is finished.

### Raw HTTP (if python is unavailable)
POST ${B}/exec {"device":"mac","command":"...","cwd":"~","timeout_sec":120} | POST ${B}/call {"tool":"mac__read_file","args":{...}} | GET/PUT ${B}/files/@mac/<path> | GET ${B}/devices | MCP endpoint: POST ${B}/mcp. Header: Authorization: Bearer ${T}
${getSection}
### Rules
1. Check \`devices\` first; a device that is offline simply has no tools - say so instead of guessing.
2. Every single call must finish within ${timeout}s (hard limit ${maxTimeout}s - the connection is cut beyond that). For anything longer use <target>__start_process, then poll <target>__read_process_output (each poll is a short call). Interactive programs: write_process to send input.
3. Paths are absolute or ~-relative to that machine's home. On android, user files live under ~/storage/shared (needs termux-setup-storage once).
4. Before destructive operations (delete, overwrite, force push) state what you'll do, then do it.
5. Prefer edit_file for small changes, write_file for new files, put/get for binaries.
6. Treat the token as secret: never print it back in your answers.
`;
}

// One-liner to paste at the start of every new chat; the agent fetches the full instructions itself.
export function shortPrompt({ host, token }) {
  return `You can operate my real machines (VPS, Mac, Android) through an HTTP bridge. First run this in your sandbox and then follow the instructions it prints exactly - never simulate results:\ncurl -s -H "Authorization: Bearer ${token}" https://${host}/prompt`;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const cfgUrl = ['./config.json', './config.example.json'].map(f => new URL(f, import.meta.url)).find(u => fs.existsSync(u));
  const c = JSON.parse(fs.readFileSync(cfgUrl, 'utf8'));
  const opts = { host: process.env.BRIDGE_HOST || c.hostname, token: process.env.BRIDGE_TOKEN || c.token, hub: (process.env.LOCAL_NAME || c.localName || 'hub').toLowerCase(), getFallback: /^(1|true|yes|on)$/i.test(String(process.env.ALLOW_GET_EXEC || '')) };
  if (process.argv.includes('--short')) { process.stdout.write(shortPrompt(opts) + '\n'); }
  else {
    const p = buildPrompt(opts);
    fs.writeFileSync(new URL('./prompt.txt', import.meta.url), p);
    process.stdout.write(p);
    console.error('\n(saved to prompt.txt)\n\nShort version for pasting into every new chat (npm run prompt -- --short):\n\n' + shortPrompt(opts) + '\n');
  }
}
