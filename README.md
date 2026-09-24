# arena-bridge (security-hardened)

Expose tools on **your own, authorized** VPS, Mac/Linux and Android Termux devices to a web AI agent through one hub. The main `BRIDGE_TOKEN` is effectively a remote-shell credential: never publish it or send it to untrusted services.

> **Breaking migration from v0.2:** plaintext `UNLOCK_PASSWORD`, shared device/agent tokens, and state-changing `GET /exec`/`GET /call` are no longer supported. Do not redeploy production by just pulling `main`: configure a password hash and per-device credentials and reinstall device agents first.

## Permission model

The AI client authenticates with `Authorization: Bearer <BRIDGE_TOKEN>`. Each device authenticates separately to the WebSocket endpoint using its own token in a subprotocol header, not in the URL. Device credentials cannot call AI-facing shell/file/MCP endpoints.

While locked: non-sensitive file reads and directory listings inside authorized directories, plus system info, are available. Credential reads, content searches, recursive deletes, arbitrary shell execution, process sessions, process control, self-update and third-party MCP tools require unlock. All scoped file operations are checked against canonical (symlink-resolved) authorized directories. The unlock defaults to 15 minutes. **The policy is defense in depth, not a security sandbox:** an unlocked process can access everything its OS user can access and can outlive an unlock. Use OS/container isolation for untrusted agents. Desktop Commander is no longer installed/enabled by default.

## New installation

1. Provide a VPS/domain and Docker. Use Node.js >=22 on a trusted machine to generate the password hash.
2. Copy `.env.example` to `.env`. Generate `BRIDGE_TOKEN` and **different** tokens for each registered device with `openssl rand -hex 24`; fill `BRIDGE_HOST` and `DEVICE_TOKENS_JSON`.
3. On a trusted Bash terminal, create a hash without putting the password in argv or a tracked file:

   ```bash
   read -rsp 'Unlock password (16+ chars): ' PW; echo
   printf '%s' "$PW" | node scripts/hash-password.mjs
   unset PW
   ```

   Put the output into `.env` as `UNLOCK_PASSWORD_HASH='scrypt$...$...'`. Delete the old `UNLOCK_PASSWORD` line. Run `chmod 600 .env`.
4. Deploy with `sudo bash deploy-vps.sh`. The container now runs as UID 1000 rather than root; existing `/data` volumes may require an administrator to change their ownership to UID/GID 1000 before startup. Back up the volume before migration; do not use world-writable permissions as a workaround.
5. Reinstall every device with the new **named** installer URL, replacing the example host. A main token authorizes installer retrieval, but only the scoped device token is stored locally:

   ```bash
   # Mac/Linux: Node >=22, BRIDGE_TOKEN already set in your private shell
   curl -fsS -H "Authorization: Bearer $BRIDGE_TOKEN" 'https://bridge.example.com/install-device.sh?name=mac' | sh -s mac 'My laptop'
   # Android Termux: install nodejs-lts and curl first
   curl -fsS -H "Authorization: Bearer $BRIDGE_TOKEN" 'https://bridge.example.com/install-device.sh?name=android' | sh -s android 'My phone'
   ```

   Review downloaded scripts if you prefer; the generated installer **contains that device's secret**. Use `set -o pipefail` if piping through a Bash shell. Android shared storage needs `termux-setup-storage`. Install Termux:Boot, disable battery optimization, and use a wake lock to keep the agent online. Agent files are under `~/.arena-device/`.
6. `docker compose exec -T bridge node make-prompt.mjs --short` prints the short AI prompt. It contains the main token: share only with a trusted session. Public `/health` returns only `{ "ok": true }`; authenticated `/devices` provides live details.

## Migration checklist

Back up `.env`, `policy.json` and `/data`; plan downtime and stage the new hash and distinct device tokens before rebuilding the server. Remove the old plaintext `UNLOCK_PASSWORD` and obsolete `ALLOW_GET_EXEC`. Make sure the existing data volume is writable by UID 1000. Reinstall both Mac and Android agents with the named installer URL; older device agents cannot connect. Check `/devices`, locked refusal, unlock/lock and the audit log in a test environment. Rotate old credentials where appropriate. For an intentionally unprotected *test* deployment only, set `DISABLE_POLICY=1` explicitly; production should not disable the policy.

## Interface and limits

- Main-token endpoints: `/mcp`, `POST /call`, `POST /exec`, `/files`, `/devices`, `/prompt`. Device tokens are limited to device status and client code retrieval.
- Unlock using JSON `POST /unlock`, never via a password-bearing URL. Side-effecting GET routes have been removed.
- Single binary files are limited to about 8 MB; request limits are 16 MB. Large files need a different transport; chunked uploads are not implemented.
- The authorization policy does not prevent malicious code after unlock or filesystem races. Never mount a host Docker socket into the bridge. Audit logs record action metadata, not raw commands or inputs.
- The hub fails closed without a valid `UNLOCK_PASSWORD_HASH` unless `DISABLE_POLICY=1` is explicit. Unregistered devices cannot join.

Run `npm ci && npm test` (Node 22 recommended). The legacy Mac-as-hub setup/service scripts have not been migrated to the new credential format and are not a supported production deployment path for this release. The VPS Docker path is tested. MIT licensed.

Security boundaries and residual risks: [SECURITY.md](SECURITY.md).
