# arena-bridge

让你授权的网页 AI Agent 通过标准 MCP / HTTP 操作你自己的 VPS、Mac/Linux 和 Android Termux。**Bridge token 等同于远程控制凭据，仅发给可信会话。**

```
AI Agent ── HTTPS ──► VPS hub ──► 容器工作区
                            ◄── Mac / Termux 设备主动连入（无需设备公网 IP）
```

## 从零部署：clone 后直接运行

需要：**Linux VPS、指向该 VPS 的域名、sudo 权限、Python 3 和 curl**。脚本会在获得确认后安装 Docker；已有 nginx 就复用，否则通过 Caddy 自动申请 HTTPS。域名的 DNS A/AAAA 记录和 80/443 端口须提前可用。请只在自己的机器上操作。

```bash
git clone https://github.com/AI-modelsAPI/arena-bridge.git
cd arena-bridge
sudo bash deploy-vps.sh
```

第一次运行会交互式询问：公网域名、解锁密码（至少 16 字符，需确认）。默认登记 `mac,android` 两个设备名；如需不同设备，**第一次运行前**可以手动初始化配置：

```bash
python3 scripts/init-config.py --host bridge.example.com --devices laptop,phone
sudo bash deploy-vps.sh
```

初始化器自动生成高熵主 token、每台设备独立 token 和 scrypt 密码哈希，写入权限为 `0600` 的 `.env`，不会在控制台打印密钥；已有 `.env` 绝不会被覆盖。若你采用已有配置，请先手动确保 `.env` 权限为 `0600`。公网 `/health` 只报告 `{ "ok": true }`；详细设备状态需要主 token 才能查。

### 连接设备

在 VPS 的**私人终端**运行以下命令获取**仅用于该设备**的安装命令（命令本身包含设备密钥，不要公开）：

```bash
sudo bash show-setup.sh mac
sudo bash show-setup.sh android
```

把输出复制到对应设备的终端执行。Mac/Linux 需 Node.js ≥22；Android 使用 F-Droid/GitHub 版 Termux，先运行 `pkg install -y nodejs-lts curl`；要访问共享存储还需 `termux-setup-storage`。建议安装 Termux:Boot、解除电池优化。生成的设备安装器包含该设备的 token，安装脚本会以 `0600` 保存并在成功后删除；先审阅脚本再运行也可以。设备端文件保存在 `~/.arena-device/`。

在 VPS 获取发给**可信 Agent** 的短提示词：

```bash
sudo bash show-setup.sh --prompt
```

**短提示词包含主 token**，不要上传到仓库或发给不可信的模型。MCP 客户端也可连接 `https://你的域名/mcp`，使用 `Authorization: Bearer <主 token>`。Agent 可通过带鉴权的 `/devices` 检查设备在线状态。

## 权限与限制

- 锁定时只允许读取**授权目录内**的非敏感文件、列目录及获取系统信息。搜索内容、删除、执行命令、交互进程、读取凭据和第三方 MCP 工具均需解锁；解锁默认 15 分钟。目录策略见 `policy.json`。
- 每台设备使用独立密钥，不能调用主 API。设备 WebSocket 不把 token 放进 URL。第三方 Desktop Commander 默认不安装、不启用。
- 文件与请求限额：二进制单次约 8 MB，HTTP/WS 请求 16 MB；目前没有分块上传。副作用 GET `/exec`、`/call` 已移除，改用 POST / MCP。
- 该策略是**防误操作措施，不是恶意代码沙箱**。解锁后执行的长驻进程可以在重新上锁后继续运行；安全边界及剩余风险详见 [SECURITY.md](SECURITY.md)。不要挂载宿主 Docker socket。
- 凭据存放在 VPS 的 `.env` 与设备的 `~/.arena-device/env`，不要提交、截图或粘贴到公共渠道。只在可信的本地终端运行 `show-setup.sh`。

## 已部署旧版？先迁移，不要直接重启

本版不兼容旧版的明文 `UNLOCK_PASSWORD`、共用 Bridge/device token 和旧设备客户端。**`git pull` 后直接重启会导致服务无法启动或设备离线。**先备份 `.env`、`policy.json`、Docker `/data` 卷，在维护窗口生成新的 `UNLOCK_PASSWORD_HASH` 与 `DEVICE_TOKENS_JSON`，删除明文配置，再重新安装 Mac/Termux 客户端。旧卷可能需要把 `/data` 属主改为容器内 UID 1000。可参照 `.env.example` 手动迁移，遇到不确定情况请先在测试服务器演练。这里的三行快速部署命令针对**全新安装**，不自动改写现有配置。

项目测试：`npm ci && npm test`（Node 22）。旧版 Mac-as-hub 服务脚本未迁移到新的凭据配置，生产推荐上述 VPS Docker 流程。MIT License。
