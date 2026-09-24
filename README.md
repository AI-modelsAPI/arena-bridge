# arena-bridge

Let a web AI agent operate **your own authorized** VPS, Mac/Linux and Android Termux devices over MCP / HTTP. **The main Bridge token is a remote-control credential. Give it only to trusted agents.**

```
AI agent ── HTTPS ──► VPS hub ──► container workspace
                             ◄── Mac / Termux agents dial out (no public device IP)
```

## Fresh install: clone and deploy

Requirements: a Linux VPS, a domain pointed to it, sudo, Python 3 and curl. The installer asks for approval before installing Docker. It reuses existing nginx if present, or runs Caddy for automatic HTTPS. Configure DNS and allow TCP ports 80/443 before starting.

```bash
git clone https://github.com/AI-modelsAPI/arena-bridge.git
cd arena-bridge
sudo bash deploy-vps.sh
```

On first run, enter your public domain and an unlock password of at least 16 characters. By default the installer registers `mac,android`; to use different names, initialize the config **before the first deploy**:

```bash
python3 scripts/init-config.py --host bridge.example.com --devices laptop,phone
sudo bash deploy-vps.sh
```

The initializer generates a random main token, separate device tokens and a salted scrypt password hash in a private `0600` `.env`. It never overwrites an existing `.env` or prints secrets. If you bring your own `.env`, ensure mode `0600`. Public `/health` returns only `{ "ok": true }`.

### Add your devices

On the VPS, in a **private terminal**, generate an installer command **scoped to each device**:

```bash
sudo bash show-setup.sh mac
sudo bash show-setup.sh android
```

Run each output command on that device. It contains the device's secret, so do not share it publicly. Mac/Linux requires Node.js >=22. For Android, use Termux from F-Droid/GitHub, first run `pkg install -y nodejs-lts curl`, then `termux-setup-storage` if you need shared files. Termux:Boot and disabling battery optimization help keep it online. The generated installer is saved with `0600` permissions and removed after success. Review downloaded scripts before executing if appropriate; device files live in `~/.arena-device/`.

On the VPS, generate the short prompt for a **trusted** web AI agent:

```bash
sudo bash show-setup.sh --prompt
```

This prompt contains the **main token**. Never commit or post it publicly. MCP clients can instead use `https://your-host/mcp` with a Bearer token. Authenticated `/devices` reports live connections.

## Permissions, limits and safety

- While locked, only non-sensitive file reads and directory listings **inside authorized directories**, plus system info, are allowed. Content search, deletes, arbitrary shell/process access, credential reads and third-party MCP tools require unlock (15 minutes by default). See `policy.json`.
- Every device has a separate credential that cannot use the main API. WebSocket device authentication does not put tokens in URLs. Desktop Commander is no longer installed or enabled by default.
- Binary files are limited to ~8 MiB per call; HTTP/WS requests are capped at 16 MiB. There is no chunked upload. Side-effecting `GET /exec` and `GET /call` have been removed: use POST/MCP.
- This policy is **a defense against accidents, not an adversarial OS sandbox**. Processes started while unlocked can continue after relocking. See [SECURITY.md](SECURITY.md) for remaining risks. Do not mount the host Docker socket.
- Protect the VPS `.env` and device `~/.arena-device/env`. Only print device install commands and AI prompts in trusted terminals.

## Already running the old version? Migrate first

This release is incompatible with plaintext `UNLOCK_PASSWORD`, shared client/device credentials and old device agents. **Do not merely `git pull` and restart**: the hub may refuse to start and devices will disconnect. Back up `.env`, `policy.json` and the Docker `/data` volume; generate `UNLOCK_PASSWORD_HASH` and `DEVICE_TOKENS_JSON`, remove the plaintext secret, and reinstall Mac/Termux agents during a maintenance window. An existing volume may need its owner changed to UID 1000. See `.env.example`, rehearse in staging, and keep a rollback copy. The three-command quickstart above is for **new deployments only** and never overwrites an existing configuration.

Run `npm ci && npm test` on Node 22. The legacy Mac-as-hub service scripts have not been migrated; use the VPS Docker deployment for production. MIT licensed.
