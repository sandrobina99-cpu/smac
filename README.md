# smac — 跨平台主机端：文件同步 · 多设备剪贴板 · 远程终端 · 无头 Agent

`smac` 是一个可部署在任意 Windows / macOS / Linux 电脑上的通用主机控制台。**全新安装默认不包含任何 SSH 连接配置、密钥或第三方组网 ID**，任何机器解压即可作为主机使用，支持通过自己的 **局域网 / Tailscale / ZeroTier** 组建 SSH 连接。

## 核心能力

- **零预置通用主机**：首次启动完全空白（`devices.json` 为空、ZeroTier 组号留空），所有连接、密钥和组网配置均只保存在当前主机的 `~/.smac/` 与 `~/.ssh/` 下，绝不内置他人配置。
- **三通道自动优选 SSH**：每台远程设备可同时填写 **局域网地址 + Tailscale IP + ZeroTier IP**，连接时严格按 **局域网 → Tailscale → ZeroTier** 优先级自动探测与切换。
- **双向文件夹同步**：本机文件夹与任意已添加的远程设备（Windows / macOS / Linux）双向同步，冲突自动保留两份，删除进回收站（`.smac-trash`）。
- **多设备剪贴板同步**：可在控制台自由勾选 **1 台或多台** 远程设备（支持 Windows / macOS / Linux），在「本机 ⇄ 所选全部设备」之间双向同步文本与图片。
- **一键生成本机专属客机包**：主机端点击「下载客机端安装包」会动态生成 `smac-guest-setup.zip`，自动内嵌**当前主机**新生成的 SSH 公钥、配对令牌、局域网/Tailscale 地址以及你自行配置的 ZeroTier 组号（可选）。支持 Windows 与 macOS/Linux 客机。
- **远程 SSH 终端 & 无头远程 Agent**：内置浏览器多标签 xterm 终端；支持远程静默安装并无头调用客机的 DeepSeek Harness / Hermes / Codex / Claude Code / Gemini·Antigravity / OpenCode，不弹窗不打扰客机使用。

---

## 快速开始

### 1. 启动主机控制台

- **Windows 主机端 (`smac-host-windows.zip`)**：
  1. 解压到任意目录；
  2. 双击 **`一键启动主机控制台.cmd`**（或在 PowerShell 执行 `.\smac.ps1 web`）；
  3. 浏览器自动打开 `http://127.0.0.1:8788/`（端口被占用会自动顺延）。

- **macOS / Linux 主机端 (`smac-host-macos.zip`)**：
  1. 解压到任意目录；
  2. macOS 双击 **`一键启动主机控制台.command`**（首次若提示未验证开发者，右键 → 打开），Linux 执行 `./smac.sh web`；
  3. 浏览器自动打开 `http://127.0.0.1:8788/`。

> 环境要求：主机需已安装 Node.js（18+）。发行包已内置纯 JS 依赖（`ssh2`、`ws`、xterm、KaTeX），无需额外编译或联网即可直接启动；若 `web/node_modules` 缺失，启动脚本也会自动运行 `npm install --omit=optional`。

### 2. 添加远程设备（局域网 / Tailscale / ZeroTier）

进入控制台顶部 **「远程设备 · 客机」**：

- **方式 A：手动添加 SSH 设备**
  点击 **「添加设备」**，填写：
  - **主机地址**：局域网 IP（如 `192.168.1.20`）或公网域名；
  - **Tailscale / 备用地址（可选）**：如 `100.x.x.x`；
  - **ZeroTier IP（可选）**：如 `10.x.x.x`；
  - **认证方式**：本机 SSH 私钥（如 `~/.ssh/id_ed25519`）或登录密码。
  保存后即可点击「测试」、「SSH 终端」、添加同步目录、勾选剪贴板同步或启动远程 Agent。

- **方式 B：用自己的 ZeroTier 组网（可选）**
  在「远程设备 · 客机」页顶部的 **ZeroTier 外网穿透** 栏输入你自己在 [my.zerotier.com](https://my.zerotier.com/) 创建的 **16 位 ZeroTier 组号**，点击 **「保存并入组」**。之后导出的客机安装包会自动内置该组号，或可在已连接设备卡片上点「同组 ZeroTier」远程入组。

- **方式 C：一键生成客机端安装包自动配对**
  点击 **「下载客机端安装包」**，把动态生成的 `smac-guest-setup.zip` 发给客机解压：
  - Windows 客机双击 `一键安装客机端.cmd`；
  - macOS 客机双击 `一键安装客机端(Mac).command`；
  - Linux 客机执行 `bash ./install-guest.sh`。
  安装完成后客机自动开启 SSH、写入本机公钥并按 局域网 → Tailscale → ZeroTier 顺序回连注册；若跨网段未自动回连，复制窗口输出的 `SMAC-GUEST://...` 配对码在主机控制台粘贴即可一键接入。

---

## 剪贴板同步（多设备可选）

在「文件中枢」右侧 **「剪贴板同步」** 面板：

1. 在 **「同步设备」** 区域勾选任意 1 台或多台已添加设备（支持 Windows / macOS / Linux）；
2. 点击 **「立即同步一次」** 或 **「启动」** 后台守护（默认每 2 秒检查一次）；
3. 任意一台勾选设备（含本机）复制新文本或截图后，会自动同步到本机及所有其他已勾选的在线设备；部分设备离线时不影响其他设备同步。

---

## 命令行参考

### Windows (`smac.ps1`)
```powershell
.\smac.ps1 web                         # 启动网页控制台
.\smac.ps1 web stop                    # 停止网页控制台
.\smac.ps1 send "D:\文件.pdf" --device <设备名>
.\smac.ps1 sync add "D:\项目" "~/Documents/项目" --device <设备名>
.\smac.ps1 sync now                    # 立即同步全部
.\smac.ps1 sync start | stop | status  # 后台同步守护
.\smac.ps1 config                      # 查看当前配置
```

### macOS / Linux (`smac.sh`)
```bash
./smac.sh web                          # 启动网页控制台
./smac.sh web stop                     # 停止网页控制台
./smac.sh sync now                     # 立即同步全部
./smac.sh sync start | stop            # 后台同步守护
./smac.sh status                       # 查看运行状态
```

---

## 本地数据与安全边界

- 所有运行时配置保存在当前用户的 `~/.smac/`（`config.json`、`devices.json`、`guest-pairing.json`、`agent-credentials.json`），与程序安装目录完全分离。
- 控制台 HTTP 与 WebSocket 终端服务仅监听 `127.0.0.1`，不向局域网/公网暴露。
- 主机指纹首次连接自动记录（TOFU），后续指纹变动会阻断连接，需人工确认并在设备编辑中重置。
