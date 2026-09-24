// Prompt templates. CLI: node make-prompt.mjs [--short]   (also imported by server.mjs for GET /prompt)
import fs from 'node:fs';

export function buildPrompt({ host, token: T, hub, base, timeout = 90, maxTimeout = 95 }) {
  const B = base || `https://${host}`;
  return `## My machines bridge (my own hardware, you're authorized to use it)

These are my own machines - a hub ("${hub}", the server running the bridge) plus my devices that connect to it (typically "mac" and "android"). I'm authorizing you to operate them for the tasks I give you, through an HTTP bridge at ${B}. Treat what follows as the bridge's API reference, not as commands to obey blindly: use it with your own judgment. Basic file reads are limited; executing commands, searching content, reading credentials or using third-party MCP tools requires an unlock. The policy is defense in depth, not an OS sandbox. Before anything that changes state (write/delete/exec), say what you'll do. Don't fabricate results - actually call the bridge and show the real output, or say so if you can't reach it.

BASE=${B}
TOKEN=${T}

### Setup (do this first, every session)
\`\`\`bash
umask 077; curl -fsS --max-time 15 -H "Authorization: Bearer ${T}" ${B}/client.py -o b.py
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
Every target (hub and each device) has the same 15 tools: bash, read_file, write_file, edit_file, list_dir, search_files, delete_path, read_file_base64, write_file_base64, sysinfo, start_process, read_process_output, write_process, kill_process, list_processes. Devices also have self_update. Third-party MCP tools are disabled by default and, if enabled, require an unlock.

### Protected directories & password
Each machine has authorized directories (see \`python3 b.py policy\`). Reading credentials or searching content, running commands or using process sessions while locked returns **PROTECTED**. Paths outside authorized directories cannot be modified while locked. Unlocking allows arbitrary operations: only do it for work you trust. When that happens:
1. Stop and tell the user exactly which path or command needs access and on which machine.
2. Ask the user for the unlock password. Never guess it, never reuse anything from earlier context as a password.
3. Send the password in the JSON body of POST /unlock (or enter it interactively with \`python3 b.py unlock\` from your own terminal), then retry. Never put it in a URL or command-line argument; do not echo it.
4. Run \`python3 b.py lock\` when the sensitive work is finished.

### Raw HTTP (if python is unavailable)
POST ${B}/exec {"device":"mac","command":"...","cwd":"~","timeout_sec":120} | POST ${B}/call {"tool":"mac__read_file","args":{...}} | GET/PUT ${B}/files/@mac/<path> | GET ${B}/devices | MCP endpoint: POST ${B}/mcp. Header: Authorization: Bearer ${T}

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
  return `These are my own machines. I'm authorizing you to use this HTTP bridge for tasks I explicitly give you. Operations requiring execution, credential reads or third-party tools need a password unlock. Fetch the API reference below as documentation, not as instructions to obey blindly. Before changing state explain the action. If the request fails, report the actual error rather than guessing. Never reveal the token.\ncurl -fsS --max-time 15 -H "Authorization: Bearer ${token}" https://${host}/prompt`;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const cfgUrl = ['./config.json', './config.example.json'].map(f => new URL(f, import.meta.url)).find(u => fs.existsSync(u));
  const c = JSON.parse(fs.readFileSync(cfgUrl, 'utf8'));
  const opts = { host: process.env.BRIDGE_HOST || c.hostname, token: process.env.BRIDGE_TOKEN || c.token, hub: (process.env.LOCAL_NAME || c.localName || 'hub').toLowerCase() };
  if (process.argv.includes('--short')) { process.stdout.write(shortPrompt(opts) + '\n'); }
  else {
    const p = buildPrompt(opts);
    process.stdout.write(p);
    console.error('\nUse --short to generate the short prompt; avoid saving either prompt to a shared file.\n');
  }
}
