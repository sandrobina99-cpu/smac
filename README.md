# smac — 统一跨平台主机中枢 · 客机管理 · API 分发与配额网关

`smac` 将 **跨平台主机/客机文件同步、多设备剪贴板、远程终端、无头 Agent** 与 **自托管 API 分发配额网关（原 Sandrobina API Hub）** 完整融合为一套统一软件体系：

- **恒星（Star）主机管理端**：全局唯一管理员最高权限，统一掌控设备同步、远程终端、无头 Agent、账号管理、个人 API Key 分发、7×24h 滚动 Token 配额、模型权限 ACL 以及所有客机的账号归属。
- **卫星（Satellite）客机客户端**：使用管理员分配的账号密码登录，一站式查看个人 API Key / 7×24h 滚动额度 / 可用模型 / AI 对话测试 / CLI 一键配置，并支持 **主动连接主机 / 主动断联主机**；**一个账号下可同时绑定多台客机**，所有客机设备卡片均清晰标注所属账号。

---

## 仓库结构（Unified Monorepo）

```text
smac/
├── web/                  # smac 主机端独立窗口控制台（文件中枢 / 远程设备 / 远程 Agent / API 分发与账号）
├── guest/                # smac 客机端独立窗口控制台（账号登录 / API 额度 / 主动连断主机 / 环境检测）
├── agent/                # 远程无头 Agent 包装与环境探测脚本
├── macos/                # macOS 原生 Cocoa + WKWebView 独立窗口封装、恒星/卫星图标与 DMG 构建脚本
├── packages/shared/      # 共享 TypeScript 类型（用户、配额、模型、客机归属、主机绑定）与格式化工具
├── apps/gateway/         # Node 24 + node:sqlite + Express 5 自托管 API 分发与账号设备归属网关
├── apps/admin-desktop/   # Electron + React + Vite smac 管理端桌面应用（恒星图标）
├── apps/client-desktop/  # Electron + React + Vite smac 客户端桌面应用（卫星图标）
└── package-editions.ps1  # Windows / macOS 一键纯净发行包与独立窗口启动器打包脚本
```

---

## 核心架构特性

### 1. 唯一管理员最高权限 & 1 账号 → 多台客机
- 网关 SQLite 数据库内置 `enforce_single_admin` 触发器，强制保障**管理员账号唯一**，以主机管理端为最高管理权限。
- `guest_devices` 表支持 **1 个账号绑定多台客机**（Windows / macOS / Linux），每台客机在主机端「远程设备 · 客机」及管理端「客机设备归属」面板均标注 **所属账号**。
- 管理员可在主机端一键将任意客机绑定或改绑至目标账号，或撤销接入；普通账号不可劫持他人已绑定的客机（返回 HTTP `403`）。

### 2. API Key 分发、7×24h 严格滚动配额与模型权限
- **7×24h（168 小时）严格滚动窗口**：按 `weighted_tokens = Math.ceil(total_tokens * multiplier)` 实时扣费并自动回滚释放，耗尽返回 HTTP `429`（`weekly_quota_exceeded`）与 `X-Quota-*` / `Retry-After` 响应头。
- **精细模型 ACL**：支持默认全开（黑名单剔除）或严格白名单模式，同时过滤 `/v1/models` 的标准 `data[]` 与 Codex `models[]`，未授权模型拦截返回 `404` / `403`。
- **实时 SSE 推送**：`/api/client/stream` 实时同步配额变化、Key 轮换、模型权限与客机绑定状态。
- **AI 对话测试 & 本地 CLI 一键接入**：客户端内置流式对话测试台（支持按模型动态切换 `reasoning_effort`）及 Codex CLI / Claude Code / OpenCode / Hermes / Factory Droid / Aider / Qwen Code 写前备份与一键配置。

### 3. 跨平台文件同步、拖拽直传、多设备剪贴板与远程终端
- **三通道自动优选 SSH**：局域网 → Tailscale → ZeroTier 自动探测切换。
- **双向文件夹同步 & 拖拽直传桌面**：支持拖拽任意文件、图片、压缩包、文件夹直传目标设备桌面；同步目录双向防重并支持任意客机自动识别工作区。
- **多设备剪贴板 & 无头远程 Agent**：支持自由勾选多台客机同步文本/图片，并内置浏览器多标签 xterm SSH 终端与远程无头 Agent 调度。

---

## 快速开发与构建

### 环境要求
- Node.js **24+**（网关使用内置 `node:sqlite`）

### 安装、构建与测试（Monorepo）
```bash
npm install
npm run build
npm test
npx tsc --noEmit -p apps/gateway/tsconfig.json
npx tsc --noEmit -p apps/admin-desktop/tsconfig.json
npx tsc --noEmit -p apps/client-desktop/tsconfig.json
npx tsc --noEmit -p apps/admin-desktop/tsconfig.electron.json
npx tsc --noEmit -p apps/client-desktop/tsconfig.electron.json
```

### 启动本地主机控制台 / 客机控制台
- **Windows**：双击 `smac-host.exe`（或桌面「smac 主机控制台」快捷方式）/ `guest\smac-guest.exe`（或「smac 客机控制台」）；重新打包发行版运行 `.\package-editions.ps1`。
- **macOS**：运行 `bash macos/build-mac-apps.sh` 生成 `/Applications/smac 主机控制台.app`、`/Applications/smac 客机控制台.app` 与可拖拽安装镜像 `dist/smac-host-macos.dmg`、`dist/smac-guest-macos.dmg`。
- **Electron 桌面端打包**：`npm run pack:admin:mac` / `pack:admin:win` / `pack:client:mac` / `pack:client:win`（亦支持 GitHub Actions 自动双端构建）。

---

## 安全边界
- 严禁提交 `.env`、`hub.db`、`.master.key`、SSH 私钥、管理员密码或任何真实上游/分发 API 密钥。
- 主机端和客机端运行时数据完全隔离保存在当前用户的 `~/.smac/` 与 `~/.smac-guest/` 目录，控制台本地监听 `127.0.0.1`。
- 网关密钥使用 AES-256-GCM 加密，密码使用 `scrypt`，会话 Token 采用带 `token_version` 校验的 HMAC-SHA256。
