# arena-bridge（安全加固版）

将 VPS、Mac/Linux 与 Android Termux 作为远程工具接入 AI Agent。**仅适用于你拥有且授权的设备。**Bridge token 具有极高权限：请视为远程 shell 凭据，不要公开，不要发给不可信的模型或人。

> **与旧版不兼容，先完成迁移再升级线上容器。**原有 `UNLOCK_PASSWORD` 明文配置、设备共用的 `BRIDGE_TOKEN`、`GET /exec`/`GET /call` 均已停用。仅 `git pull` 后直接重启会导致 hub 无法启动或设备离线。此改动不会自动部署到你的 VPS/手机。

## 架构及权限

Agent 使用 `Authorization: Bearer <BRIDGE_TOKEN>` 请求 hub 的 `/mcp`、`/call`、`/exec`、`/files`。每台设备用自己的凭据主动连接 `/device?name=mac`，hub 通过 WebSocket 子协议认证，不再把凭据放在 URL。设备凭据**不能**调用 Agent 的 shell、文件或 MCP API。

默认锁定状态：读取授权目录内的非敏感文件、列目录、查看系统信息可以使用；读取敏感文件、搜索文件内容、递归删除、执行 shell、读写交互进程、管理进程、自升级和第三方 MCP 工具需要先解锁。所有文件操作只允许策略中指定的目录，并检查符号链接解析后的路径。解锁默认有效 15 分钟；**解锁期间允许任意执行，不是沙箱**，长任务可能在重新上锁后仍继续运行。策略是防误操作的第二道防线，而非针对恶意 Agent 的完整 OS 安全边界；真正隔离应使用独立账户/容器及只挂载必要文件。第三方 desktop-commander 不再默认启用。

## 全新安装

1. 准备 Linux VPS、域名、Docker；本地（例如 Mac）需要 Node.js >=22 来生成密码哈希。
2. `cp .env.example .env`，用 `openssl rand -hex 24` 生成一个 **BRIDGE_TOKEN** 和每台设备**不同的** 48 位十六进制凭据，按 `.env.example` 填写 `BRIDGE_HOST`、`DEVICE_TOKENS_JSON`。不要复用设备 token。
3. **只在可信终端**生成密码哈希，不要把密码放进命令行参数、环境文件或 Git：

   ```bash
   read -rsp '解锁密码（至少16字符）: ' PW; echo
   printf '%s' "$PW" | node scripts/hash-password.mjs
   unset PW
   ```

   将输出放入 `.env` 的 `UNLOCK_PASSWORD_HASH='scrypt$...$...'`（整个值用单引号包围），**删除旧的 `UNLOCK_PASSWORD`**。`chmod 600 .env`；配置文件不要提交。
4. `sudo bash deploy-vps.sh`。如果升级已有数据卷导致非 root 用户不能写 `/data`，应在运维窗口以 root 对旧 volume 的属主改为 UID/GID 1000，先备份、再重启；不要直接把目录 chmod 777。
5. 在 Mac / Termux 中重新安装对应设备，以下命令的 Bridge token 只用于**获取安装脚本**，设备实际存储的是单独的 device token：

   ```bash
   # Mac/Linux（需 Node.js >=22）：先把 BRIDGE_TOKEN 仅放入当前终端的变量
   curl -fsS -H "Authorization: Bearer $BRIDGE_TOKEN" 'https://bridge.example.com/install-device.sh?name=mac' | sh -s mac '我的电脑'
   # Android 的 Termux：使用 F-Droid/GitHub 版，先执行 pkg install -y nodejs-lts curl
   curl -fsS -H "Authorization: Bearer $BRIDGE_TOKEN" 'https://bridge.example.com/install-device.sh?name=android' | sh -s android '我的手机'
   ```

   把 `bridge.example.com` 换成真实域名。运行远程脚本前可以先下载并审查；脚本**包含该设备的 token**，不要把它转发或提交。建议用 `set -o pipefail` 确保下载失败不会被管道掩盖。Android 若需访问共享存储，执行 `termux-setup-storage`；安装 Termux:Boot 并关闭系统电池优化，避免后台被杀。设备安装目录为 `~/.arena-device/`，日志在 `~/.arena-device/agent.log`。旧版设备需重新执行安装步骤。
6. `docker compose exec -T bridge node make-prompt.mjs --short` 获取短提示词（包含**主 Bridge token**）；只发到你信任的会话，不要上传到公开仓库。hub 的 `/health` 对外仅返回 `{ "ok": true }`；用带 Bearer 头的 `/devices` 查看在线设备。

## 旧版迁移顺序（重要）

- 先备份 `.env`、`policy.json` 和 `/data`，在**测试环境**生成并验证密码哈希和两台设备专用 token。
- 安排短暂维护窗口。更新服务器代码后填入 `UNLOCK_PASSWORD_HASH` 和 `DEVICE_TOKENS_JSON`，删掉 `UNLOCK_PASSWORD`、旧 `ALLOW_GET_EXEC`；检查旧数据卷 UID 1000 的可写权限，再构建启动。需要明确无密码的测试环境才可手动配置 `DISABLE_POLICY=1`（生产不建议）。
- 在每台设备上使用**新的安装 URL**重新安装客户端；旧客户端无法连新版 hub。查看设备日志 `online as "mac"` / `online as "android"`。设备端的 `~/.arena-device/env` 应保持 `0600`，目录 `0700`。
- 检查 `GET /devices`、锁定时拒绝执行、解锁后执行测试（仅测试环境）、重新上锁，以及审计日志。确认正常后轮换任何怀疑已泄露的旧 token。

## API / 安全说明

- `/mcp`、`POST /call`、`POST /exec`、`/files` 都必须用主 Bearer token；设备 token 仅能访问自己的状态和客户端脚本。
- 密码解锁用 `POST /unlock` JSON 请求体；不要把密码或 token 放在 URL。副作用 GET（`GET /exec`、`GET /call`）已经移除。
- 二进制文件单次上限约 8 MB（请求大小 16 MB），大文件请在可信环境采用外部传输方案；当前没有分块上传协议。代理可能另有体积、超时限制。
- 目录策略并非抵御已解锁后恶意进程或文件系统竞态的硬隔离。不要挂载宿主 `/var/run/docker.sock`。审计日志只记录工具名、目标、允许/拒绝及耗时，不记录命令参数；保护日志文件权限。
- 缺少有效 `UNLOCK_PASSWORD_HASH` 时 hub 拒绝启动；明确设置 `DISABLE_POLICY=1` 才会关闭防误操作策略。`DEVICE_TOKENS_JSON` 未登记的设备无法上线。

测试：`npm ci && npm test`；生产推荐 Node 22。旧版 Mac-as-hub 的 `setup.sh` / `install-service.sh` 未迁移到新凭据配置，不应继续作为生产部署路径；本版按 VPS Docker 流程测试。项目使用 MIT 许可证。

安全边界与剩余风险详见 [SECURITY.md](SECURITY.md)。
