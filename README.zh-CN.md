# arena-bridge

让网页版 AI（arena.ai Agent Mode，或 Claude Desktop / Cursor 等任何 MCP 客户端）通过**一个地址 + 一个 token** 操作你的真实机器：VPS、Mac/Linux、安卓手机；对授权目录之外的改动加一层**密码**。

```
arena.ai / Claude ──► https://bridge.example.com  (hub：VPS 上的 Docker，标准 MCP 端点 /mcp)
   沙箱 curl                    │
                                ├── vps__*      hub 容器自身
                                ├── mac__*      ◄── 你的电脑（设备端主动外连，无需公网 IP / 端口映射）
                                └── android__*  ◄── 你的手机（Termux）
```

* 每台机器同样的 15 个工具：`bash`、读/写/改/列/搜/删文件、二进制上传下载、`sysinfo`，以及进程会话（`start_process` / `read_process_output` / `write_process` / `kill_process`）跑长任务和交互程序。
* 读永远放行；**在授权目录之外写文件或执行命令会返回 `PROTECTED`**，agent 必须向你要密码，解锁有时限。
* 设备断线自动重连，可从 hub 自我升级。
* 聊天用的手机/浏览器什么都不用装。

## 环境要求

| 位置 | 需要 |
|---|---|
| 服务器（hub） | 有公网 IP 的 Linux VPS，域名 A 记录指向它。脚本会自动装 Docker。 |
| 电脑 | Node.js ≥ 22（`brew install node` 等） |
| 安卓 | [Termux](https://github.com/termux/termux-app/releases)（F-Droid/GitHub 版，不要用 Play 商店版） |

## 安装

**1. 服务器**

```bash
git clone https://github.com/AI-modelsAPI/arena-bridge && cd arena-bridge
cp .env.example .env            # 填 BRIDGE_HOST、BRIDGE_TOKEN（openssl rand -hex 24）、UNLOCK_PASSWORD
sudo bash deploy-vps.sh         # 装 Docker + HTTPS（自带 Caddy，或复用已有 nginx）+ 打印提示词
```
国内 VPS 拉不到 Docker Hub：打开 `.env` 里 `NODE_BASE` / `CADDY_IMAGE` 两行。授权目录在 `policy.json` 里改，改完 `docker compose restart`。

**2. 设备**（第 1 步结束时会打印好带 token 的命令）

```bash
# Mac / Linux
curl -s -H "Authorization: Bearer <token>" https://bridge.example.com/install-device.sh | sh -s mac "我的电脑"
# 安卓（Termux 里）
pkg install -y nodejs-lts curl && termux-setup-storage && \
curl -s -H "Authorization: Bearer <token>" https://bridge.example.com/install-device.sh | sh -s android "我的手机"
```
安装到 `~/.arena-device/`，自启（launchd / systemd / Termux:Boot）。安卓请在 Termux 通知里开 wakelock，并关掉电池优化。

**3. 使用**

每个新对话开头贴第 1 步打印的那一行（`docker compose exec bridge node make-prompt.mjs --short` 可再打印）。agent 会自己从 `GET /prompt` 拉完整说明，并用 `python3 b.py devices` 查看在线设备。MCP 客户端填 `https://bridge.example.com/mcp` + Bearer token。

## GET 兼容（可选，默认关）

有些网页版 AI 的沙箱只能发 **GET**（唯一的外联工具是 URL 抓取器），即便到你域名的 TLS 是通的。设 `ALLOW_GET_EXEC=1` 后，`GET /exec`、`GET /call` 会在 POST 之外同时开放：

```
GET /exec?token=…&rid=<唯一值>&command=<url编码>[&device=mac&cwd=~&timeout_sec=90]
GET /call?token=…&rid=<唯一值>&tool=mac__read_file&args=<url编码JSON>
```

每次请求必须带唯一 `rid`：GET 可能被平台预取或重试，桥对每个 `rid` 只执行一次、重复请求回放缓存结果——重复的 GET 绝不会执行两次。`HEAD` 被拒（405），查询串长度受限，响应 `no-store`，且 `unlock`/`lock` 不走 GET（密码绝不进 URL）。token 可改用 `x-token` 头传，避免出现在 URL 里。默认关闭；沙箱能用 POST/MCP 时优先用它。

## 密码层

`policy.json` 为每台机器列出授权目录。agent 遇到 `PROTECTED` 会告诉你它想改哪个路径、在哪台机器，并向你要密码；你把密码告诉它，它执行 `python3 b.py unlock <密码>`，默认解锁 15 分钟，`lock` 立即上锁。密码只存在服务器 `.env`，不出现在提示词里。

## 安全说明

* token 等于所有接入��器的 shell 权限。换 token：改 `.env` → `docker compose up -d` → 各设备重跑安装命令。
* 目录策略在 hub 上统一执行；路径类工具精确判断，`bash` / `start_process` 按 cwd 和命令里出现的路径启发式判断（出现 `..` 一律视为越界）。它防的是 agent 乱跑，不是对抗恶意 agent 的沙箱。
* 经 Cloudflare 代理时单次请求 100 秒、上传 100MB 上限；提示词已教 agent 用进程会话处理长任务。直连（Caddy）无此限制。

## 备选：hub 跑在 Mac 上

没有 VPS 时可以把 hub 跑在 Mac 上，用 Cloudflare Tunnel 暴露：`./setup.sh bridge.example.com && ./setup-tunnel.sh && ./install-service.sh`。

MIT 协议。
