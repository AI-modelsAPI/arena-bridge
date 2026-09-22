# arena-bridge

Give a web-based AI agent (arena.ai Agent Mode, or any MCP client such as Claude Desktop / Cursor) hands on **your real machines**: a VPS, your Mac/Linux box and your Android phone — through **one URL and one token**, with a **password gate** for anything outside the directories you authorize.

```
arena.ai / Claude ──► https://bridge.example.com  (hub: Docker on a VPS, standard MCP endpoint /mcp)
   sandbox curl                 │
                                ├── vps__*      the hub container itself
                                ├── mac__*      ◄── your computer   (device agent dials OUT, no port forwarding)
                                └── android__*  ◄── your phone      (Termux)
```

* Same 15 tools on every machine: `bash`, `read_file`, `write_file`, `edit_file`, `list_dir`, `search_files`, `delete_path`, binary `get`/`put`, `sysinfo`, and process sessions (`start_process` / `read_process_output` / `write_process` / `kill_process`) for long-running or interactive jobs.
* Reads are always allowed; **writes/commands outside the authorized directories return `PROTECTED`** until the agent asks *you* for the unlock password (time-limited unlock).
* Devices reconnect automatically and can self-update from the hub.
* Nothing to install in the browser or on the phone you chat from. Works from mobile.

## Requirements

| Where | Needs |
|---|---|
| Server (hub) | Linux VPS with a public IP, a DNS `A` record for your hostname. Docker is installed by the script if missing. |
| Your computer | Node.js ≥ 22 (`brew install node` / your package manager) |
| Android | [Termux](https://github.com/termux/termux-app/releases) (F-Droid/GitHub build, not Play Store) |

## Install

**1. Server**

```bash
git clone https://github.com/AI-modelsAPI/arena-bridge && cd arena-bridge
cp .env.example .env            # set BRIDGE_HOST, BRIDGE_TOKEN (openssl rand -hex 24), UNLOCK_PASSWORD
sudo bash deploy-vps.sh         # Docker + HTTPS (bundled Caddy, or reuses an existing nginx) + prints the prompt line
```
Edit `policy.json` to choose which directories each machine may be modified in without a password (`docker compose restart` after changes).

**2. Devices** — run on each machine you want the agent to control (commands are printed by step 1):

```bash
# Mac / Linux
curl -s -H "Authorization: Bearer <token>" https://bridge.example.com/install-device.sh | sh -s mac "My laptop"
# Android (inside Termux)
pkg install -y nodejs-lts curl && termux-setup-storage && \
curl -s -H "Authorization: Bearer <token>" https://bridge.example.com/install-device.sh | sh -s android "My phone"
```
Installs to `~/.arena-device/`, auto-starts (launchd / systemd / Termux:Boot). On Android keep Termux's wake lock on and exclude it from battery optimisation.

**3. Use**

Paste the one-liner from step 1 at the start of a new chat (`docker compose exec bridge node make-prompt.mjs --short` prints it again). The agent fetches the full instructions from `GET /prompt` and runs `python3 b.py devices` to see what is online. For MCP clients use `https://bridge.example.com/mcp` with the bearer token.

## HTTP API (Bearer token)

| | |
|---|---|
| `GET /health` (no auth) · `GET /devices` · `GET /tools` · `GET /policy` | status |
| `POST /exec {"device":"mac","command":"…","cwd":"~","timeout_sec":90}` | run a command (omit `device` for the hub) |
| `POST /call {"tool":"mac__edit_file","args":{…}}` | any tool |
| `GET / PUT / DELETE /files/@mac/<path>` | raw bytes (omit `@name/` for the hub) |
| `POST /unlock {"password":"…"}` · `POST /lock` | password gate |
| `POST /mcp` | MCP Streamable HTTP (stateless) |
| `GET /prompt` · `/client.py` · `/install-device.sh` | helpers with the URL/token baked in |

## Security notes

* The token is a shell on every attached machine; treat it like a root password. Rotate: edit `.env`, `docker compose up -d`, re-run the device install lines.
* The directory policy is enforced on the hub. Path tools are checked exactly; `bash`/`start_process` are checked heuristically (cwd + paths in the command, `..` always counts as outside). It is a guard rail against an agent wandering, not a sandbox against a hostile one.
* Behind Cloudflare's proxy single requests are cut at 100 s and uploads at 100 MB; the prompt teaches the agent to use process sessions for long jobs. Direct (Caddy) deployments have no such limit.

## Alternative: hub on your Mac

No VPS? Run the hub on the Mac itself and expose it with a Cloudflare Tunnel: `./setup.sh bridge.example.com && ./setup-tunnel.sh && ./install-service.sh`.

## Files

`server.mjs` hub · `builtins.mjs` tools shared by hub and devices · `device-agent.mjs` device side · `policy.mjs` / `policy.json` password gate · `make-prompt.mjs` agent instructions · `docker-compose.yml` / `Dockerfile` / `Caddyfile` · `nginx/` reuse an existing nginx · `deploy-vps.sh` one-shot server install

MIT — see [LICENSE](LICENSE). 中文说明见 [README.zh-CN.md](README.zh-CN.md).
