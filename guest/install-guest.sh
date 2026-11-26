#!/usr/bin/env bash
# smac 客机端一键安装、远程登录检查、ZeroTier 自动入组、环境探测与主机连接脚本（macOS / Linux）
set -e

PUBLIC_KEY='__SMAC_PUBLIC_KEY__'
PAIR_TOKEN='__SMAC_PAIR_TOKEN__'
HOST_NAME='__SMAC_HOST_NAME__'
HOST_ENDPOINTS='__SMAC_HOST_ENDPOINTS__'
ZEROTIER_NETWORK='__SMAC_ZEROTIER_NETWORK__'
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OS_KERNEL="$(uname -s 2>/dev/null || echo Unknown)"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/sbin:$HOME/.hermes/node/bin:$HOME/.local/bin:$PATH"
for nvm_bin in "$HOME"/.nvm/versions/node/*/bin; do
  [ -d "$nvm_bin" ] && export PATH="$nvm_bin:$PATH"
done

echo "=========================================="
echo "  smac 客机端一键安装与主机自动连接"
echo "=========================================="
echo "计算机名：$(hostname)"
echo "当前用户：$(whoami)"
echo "操作系统：$OS_KERNEL"
if [ -n "$HOST_NAME" ] && [ "$HOST_NAME" != "__SMAC_HOST_NAME__" ]; then
  echo "目标主机：$HOST_NAME"
fi

echo ""
echo "== 1/5 检查远程登录 (SSH) 服务 =="
SSH_OPEN=0
if nc -z -G 1 127.0.0.1 22 >/dev/null 2>&1 || nc -z -w 1 127.0.0.1 22 >/dev/null 2>&1; then
  SSH_OPEN=1
fi
if [ "$SSH_OPEN" = "1" ]; then
  echo "[OK] 本机 SSH (22 端口) 已开启。"
else
  if [ "$OS_KERNEL" = "Darwin" ]; then
    echo "[!] 检测到 macOS「远程登录 (SSH)」尚未开启，主机端需要通过 SSH 连接本机。"
    if sudo -n systemsetup -setremotelogin on >/dev/null 2>&1; then
      sleep 1
      nc -z -G 1 127.0.0.1 22 >/dev/null 2>&1 && SSH_OPEN=1 || true
    fi
    if [ "$SSH_OPEN" != "1" ]; then
      echo "    正在打开「系统设置 → 通用 → 共享」，请将「远程登录」开关打开…"
      open "x-apple.systempreferences:com.apple.Sharing-Settings.extension" >/dev/null 2>&1 \
        || open "/System/Library/PreferencePanes/SharingPref.prefPane" >/dev/null 2>&1 || true
      echo "    打开「远程登录」后，脚本会自动检测；若暂时跳过请按回车继续。"
      for _ in $(seq 1 15); do
        if nc -z -G 1 127.0.0.1 22 >/dev/null 2>&1; then
          SSH_OPEN=1
          echo "[OK] 已检测到 macOS 远程登录 (SSH) 开启成功！"
          break
        fi
        sleep 1
      done
      if [ "$SSH_OPEN" != "1" ]; then
        echo "[提示] 若稍后才开启远程登录，本脚本写入的免密公钥仍会立即生效。"
      fi
    else
      echo "[OK] 已自动开启 macOS 远程登录 (SSH)。"
    fi
  else
    echo "[!] 未检测到本机 22 端口监听，请确保已安装并启动 openssh-server（如 sudo systemctl enable --now ssh）。"
  fi
fi

echo ""
echo "== 2/5 写入主机端 SSH 免密公钥 =="
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys"
if [[ "$PUBLIC_KEY" == ssh-* ]] && ! grep -Fqx "$PUBLIC_KEY" "$HOME/.ssh/authorized_keys" 2>/dev/null; then
  printf '%s\n' "$PUBLIC_KEY" >> "$HOME/.ssh/authorized_keys"
  echo "[OK] 主机端免密公钥已写入并生效。"
else
  echo "[OK] 主机端免密公钥已存在。"
fi

echo ""
echo "== 3/5 配置 ZeroTier 内网穿透组网 =="
INFO_OUT=""
NETS_OUT=""
find_zt() {
  for cand in /usr/local/bin/zerotier-cli /opt/homebrew/bin/zerotier-cli /usr/sbin/zerotier-cli /usr/bin/zerotier-cli /Applications/ZeroTier.app/Contents/MacOS/zerotier-cli; do
    if [ -x "$cand" ]; then echo "$cand"; return 0; fi
  done
  command -v zerotier-cli 2>/dev/null || true
}
if [[ "$ZEROTIER_NETWORK" =~ ^[0-9a-fA-F]{16}$ ]]; then
  ZT_NWID="$(echo "$ZEROTIER_NETWORK" | tr '[:upper:]' '[:lower:]')"
  ZT_BIN="$(find_zt)"
  if [ -z "$ZT_BIN" ] && [ "$OS_KERNEL" = "Darwin" ]; then
    echo "未检测到 ZeroTier One，正在自动安装以加入穿透组 $ZT_NWID …"
    if command -v brew >/dev/null 2>&1; then
      brew install --cask zerotier-one >/dev/null 2>&1 || true
      ZT_BIN="$(find_zt)"
    fi
    if [ -z "$ZT_BIN" ]; then
      PKG_TMP="/tmp/smac-ZeroTierOne.pkg"
      echo "正在下载官方 ZeroTier One macOS 安装包…"
      if curl -fsSL --max-time 60 "https://download.zerotier.com/dist/ZeroTier%20One.pkg" -o "$PKG_TMP"; then
        echo "请输入当前 Mac 开机密码以静默安装 ZeroTier One（也可 Ctrl+C 跳过改用图形安装）："
        if sudo installer -pkg "$PKG_TMP" -target / >/dev/null 2>&1; then
          sleep 2
        else
          echo "已打开官方 ZeroTier 安装向导，完成安装后回到本窗口继续…"
          open "$PKG_TMP" >/dev/null 2>&1 || true
          read -r -p "安装完成后请按回车继续（或直接回车跳过）..." _
        fi
        rm -f "$PKG_TMP" >/dev/null 2>&1 || true
        ZT_BIN="$(find_zt)"
      else
        echo "[提示] 下载 ZeroTier 失败（不影响局域网连接），可稍后手动从 https://www.zerotier.com/download/ 安装。"
      fi
    fi
  elif [ -z "$ZT_BIN" ] && [ "$OS_KERNEL" = "Linux" ]; then
    echo "未检测到 ZeroTier One，可运行 curl -s https://install.zerotier.com | sudo bash 安装后执行 zerotier-cli join $ZT_NWID。"
  fi

  if [ -n "$ZT_BIN" ]; then
    echo "正在加入 ZeroTier 穿透组：$ZT_NWID …"
    "$ZT_BIN" join "$ZT_NWID" >/dev/null 2>&1 || sudo -n "$ZT_BIN" join "$ZT_NWID" >/dev/null 2>&1 || true
    for _ in $(seq 1 7); do
      INFO_OUT="$("$ZT_BIN" info 2>&1 || sudo -n "$ZT_BIN" info 2>&1 || true)"
      NETS_OUT="$("$ZT_BIN" -j listnetworks 2>&1 || "$ZT_BIN" listnetworks 2>&1 || sudo -n "$ZT_BIN" -j listnetworks 2>&1 || true)"
      if echo "$NETS_OUT" | grep -qi "$ZT_NWID" && echo "$NETS_OUT" | grep -q '"status": *"OK"\| OK '; then
        break
      fi
      sleep 1
    done
  fi
else
  echo "[跳过] 主机端未配置 ZeroTier 组号，将使用局域网 / Tailscale 连接。"
fi

echo ""
echo "== 4/5 检测客机本地 CLI 与 Desktop 环境 =="
mkdir -p "$HOME/.smac-guest" "$HOME/.smac-agent"
if [ -f "$SCRIPT_DIR/guest-env.js" ]; then
  cp "$SCRIPT_DIR/guest-env.js" "$HOME/.smac-guest/guest-env.js"
  cp "$SCRIPT_DIR/guest-env.js" "$HOME/.smac-agent/guest-env.js"
fi
for gf in guest-server.js guest.html guest.css guest.js host-profile.seed.json; do
  if [ -f "$SCRIPT_DIR/$gf" ]; then
    cp "$SCRIPT_DIR/$gf" "$HOME/.smac-guest/$gf"
  fi
done

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ] && [ -x "$HOME/.hermes/node/bin/node" ]; then
  NODE_BIN="$HOME/.hermes/node/bin/node"
fi

echo ""
echo "== 5/5 与主机端建立连接 =="
if [ -n "$NODE_BIN" ] && [ -f "$HOME/.smac-guest/guest-env.js" ]; then
  SMAC_HOST_ENDPOINTS="$HOST_ENDPOINTS" SMAC_PAIR_TOKEN="$PAIR_TOKEN" SMAC_ZT_NWID="$ZEROTIER_NETWORK" SMAC_ZT_INFO="$INFO_OUT" SMAC_ZT_NETS="$NETS_OUT" "$NODE_BIN" -e '
    const fs = require("fs");
    const os = require("os");
    const env = require(process.env.HOME + "/.smac-guest/guest-env.js").detectAll();
    const clis = (env.cli || []).filter(x => x.installed).map(x => x.name);
    const desktops = (env.desktop || []).filter(x => x.installed).map(x => x.name);
    console.log("已检测 CLI 环境:", clis.join("、") || "无（主机端可一键远程安装）");
    console.log("已检测 Desktop 环境:", desktops.join("、") || "无（主机端可一键远程安装）");

    const nwid = String(process.env.SMAC_ZT_NWID || "").toLowerCase();
    let ztNode = "", ztStatus = "", ztIp = "";
    const im = /200\s+info\s+([0-9a-f]{10})/i.exec(process.env.SMAC_ZT_INFO || "");
    if (im) ztNode = im[1].toLowerCase();
    try {
      const arr = JSON.parse(process.env.SMAC_ZT_NETS || "[]");
      const hit = (arr || []).find(x => String(x.nwid || x.id || "").toLowerCase() === nwid);
      if (hit) {
        ztStatus = String(hit.status || "");
        for (const a of (hit.assignedAddresses || [])) {
          const ip = String(a).split("/")[0];
          if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) { ztIp = ip; break; }
        }
      }
    } catch {
      for (const line of String(process.env.SMAC_ZT_NETS || "").split(/\r?\n/)) {
        const m = /^200\s+listnetworks\s+([0-9a-f]{16})\s+(.*?)\s+[0-9a-f:]{17}\s+(\S+)\s+\S+\s+\S+\s+(.+)$/i.exec(line.trim());
        if (m && m[1].toLowerCase() === nwid) {
          ztStatus = m[3];
          for (const a of m[4].split(",")) {
            const ip = a.trim().split("/")[0];
            if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) { ztIp = ip; break; }
          }
        }
      }
    }
    if (ztNode) {
      if (ztStatus === "OK" && ztIp) {
        console.log("[OK] ZeroTier 已接入组 " + nwid + "，分配 IP：" + ztIp + "（节点：" + ztNode + "）");
      } else if (ztStatus === "ACCESS_DENIED") {
        console.log("[待授权] 本机 ZeroTier 节点 " + ztNode + " 已申请入组，请在 https://my.zerotier.com/network/" + nwid + " 勾选 Auth 授权！");
      } else {
        console.log("ZeroTier 节点：" + ztNode + "  状态：" + (ztStatus || "UNKNOWN"));
      }
    }

    const lanIp = (env.machine.lanIps || [])[0] || "";
    const tsIp = (env.machine.tailscaleIps || [])[0] || "";
    const primaryIp = lanIp || tsIp || ztIp || env.machine.primaryIp || "";
    const fallbackIp = (tsIp && tsIp !== primaryIp) ? tsIp : ((ztIp && ztIp !== primaryIp) ? ztIp : (env.machine.fallbackIp || ""));
    const payload = {
      name: os.hostname().replace(/\.local$/i, ""),
      hostname: os.hostname(),
      primaryIp,
      fallbackIp,
      sshPort: env.machine.sshPort || 22,
      user: env.machine.user,
      os: env.machine.osLabel,
      zerotierNetworkId: /^[0-9a-f]{16}$/.test(nwid) ? nwid : "",
      zerotierNodeId: ztNode,
      zerotierStatus: ztStatus,
      zerotierIp: ztIp,
      env
    };
    const json = JSON.stringify(payload);
    const code = "SMAC-GUEST://" + Buffer.from(json, "utf8").toString("base64");
    fs.writeFileSync(process.env.HOME + "/.smac-guest/pairing-code.txt", code, "utf8");

    (async () => {
      let connected = false;
      let eps = [];
      try { eps = JSON.parse(process.env.SMAC_HOST_ENDPOINTS || "[]"); } catch {}
      for (const ep of eps) {
        try {
          const r = await fetch(String(ep).replace(/\/+$/, "") + "/api/guest/register", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Smac-Pair-Token": process.env.SMAC_PAIR_TOKEN || "" },
            body: json,
            signal: AbortSignal.timeout(4500)
          });
          const data = await r.json();
          if (data && data.ok) {
            console.log("\n[连接成功] 已自动注册到主机端 " + data.hostName + "（设备名：" + data.deviceName + "）！");
            console.log("现在可以直接在主机端控制台确定同步文件夹、远程安装 CLI/Desktop，或无感调用本机 Agent。");
            connected = true;
            break;
          }
        } catch {}
      }
      if (!connected) {
        console.log("\n未能直接回连主机端（可能主机控制台尚未打开，或需先在 ZeroTier 后台勾选授权）。");
        console.log("请复制下方配对码，在主机端控制台点击「配对码接入客机」粘贴即可一键连接：\n");
        console.log(code);
        console.log("\n（配对码也已保存在：" + process.env.HOME + "/.smac-guest/pairing-code.txt）");
      }
      console.log("\n本机 IP：" + primaryIp + (fallbackIp ? "  (备用: " + fallbackIp + ")" : "") + (ztIp ? "  (ZeroTier: " + ztIp + ")" : ""));
      console.log("用户名：" + env.machine.user + "    SSH 端口：" + (env.machine.sshPort || 22));
    })();
  '
elif command -v python3 >/dev/null 2>&1; then
  echo "[提示] 本机尚未安装 Node.js，自动切换为内置 Python3 探测并注册（稍后可在主机端一键远程安装环境）。"
  SMAC_HOST_ENDPOINTS="$HOST_ENDPOINTS" SMAC_PAIR_TOKEN="$PAIR_TOKEN" SMAC_ZT_NWID="$ZEROTIER_NETWORK" SMAC_ZT_INFO="$INFO_OUT" SMAC_ZT_NETS="$NETS_OUT" python3 - <<'PY'
import base64, getpass, json, os, platform, re, socket, subprocess, urllib.request

nwid = (os.environ.get("SMAC_ZT_NWID") or "").strip().lower()
zt_info = os.environ.get("SMAC_ZT_INFO") or ""
zt_nets = os.environ.get("SMAC_ZT_NETS") or ""
zt_node, zt_status, zt_ip = "", "", ""
m = re.search(r"200\s+info\s+([0-9a-f]{10})", zt_info, re.I)
if m:
    zt_node = m.group(1).lower()
try:
    for item in json.loads(zt_nets):
        if str(item.get("nwid") or item.get("id") or "").lower() == nwid:
            zt_status = str(item.get("status") or "")
            for a in (item.get("assignedAddresses") or []):
                ip = str(a).split("/")[0]
                if re.match(r"^\d+\.\d+\.\d+\.\d+$", ip):
                    zt_ip = ip
                    break
except Exception:
    pass

lan_ips, ts_ips = [], []
try:
    out = subprocess.check_output(["ifconfig"], text=True, stderr=subprocess.DEVNULL)
    for ip in re.findall(r"inet\s+(\d+\.\d+\.\d+\.\d+)", out):
        if ip.startswith(("127.", "169.254.", "198.18.", "198.19.")):
            continue
        p = [int(x) for x in ip.split(".")]
        if p[0] == 100 and 64 <= p[1] <= 127:
            if ip not in ts_ips: ts_ips.append(ip)
        elif ip != zt_ip and ((p[0] == 192 and p[1] == 168) or (p[0] == 172 and 16 <= p[1] <= 31)):
            if ip not in lan_ips: lan_ips.append(ip)
except Exception:
    pass

host = socket.gethostname()
user = getpass.getuser()
os_label = "macOS" if platform.system() == "Darwin" else platform.system()
primary_ip = (lan_ips[0] if lan_ips else "") or (ts_ips[0] if ts_ips else "") or zt_ip
fallback_ip = (ts_ips[0] if ts_ips and ts_ips[0] != primary_ip else "") or (zt_ip if zt_ip and zt_ip != primary_ip else "")
payload = {
    "name": re.sub(r"\.local$", "", host, flags=re.I),
    "hostname": host,
    "primaryIp": primary_ip,
    "fallbackIp": fallback_ip,
    "sshPort": 22,
    "user": user,
    "os": os_label,
    "zerotierNetworkId": nwid if re.match(r"^[0-9a-f]{16}$", nwid) else "",
    "zerotierNodeId": zt_node,
    "zerotierStatus": zt_status,
    "zerotierIp": zt_ip
}
raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
code = "SMAC-GUEST://" + base64.b64encode(raw.encode("utf-8")).decode("ascii")
code_path = os.path.expanduser("~/.smac-guest/pairing-code.txt")
with open(code_path, "w", encoding="utf-8") as f:
    f.write(code)

connected = False
try:
    eps = json.loads(os.environ.get("SMAC_HOST_ENDPOINTS") or "[]")
except Exception:
    eps = []
for ep in eps:
    try:
        req = urllib.request.Request(
            str(ep).rstrip("/") + "/api/guest/register",
            data=raw.encode("utf-8"),
            headers={"Content-Type": "application/json", "X-Smac-Pair-Token": os.environ.get("SMAC_PAIR_TOKEN") or ""},
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=4.5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("ok"):
                print(f"\n[连接成功] 已自动注册到主机端 {data.get('hostName')}（设备名：{data.get('deviceName')}）！")
                connected = True
                break
    except Exception:
        pass

if not connected:
    print("\n请复制下方配对码，在主机端控制台点击「配对码接入客机」粘贴即可一键连接：\n")
    print(code)
    print(f"\n（配对码已保存在：{code_path}）")
print(f"\n本机 IP：{primary_ip}" + (f"  (备用: {fallback_ip})" if fallback_ip else "") + (f"  (ZeroTier: {zt_ip})" if zt_ip else ""))
print(f"用户名：{user}    SSH 端口：22")
PY
else
  echo "[提示] 未检测到 Node.js 或 Python3，请在主机端控制台手动添加本机（用户名 $(whoami)，端口 22）。"
fi

if [ "$(uname -s)" = "Darwin" ] && [ -f "$SCRIPT_DIR/smac-mac-bin" ]; then
  APP_PARENT="/Applications"
  if [ ! -w "$APP_PARENT" ]; then
    APP_PARENT="$HOME/Applications"
    mkdir -p "$APP_PARENT"
  fi
  APP_PATH="$APP_PARENT/smac 客机控制台.app"
  rm -rf "$APP_PATH"
  mkdir -p "$APP_PATH/Contents/MacOS" "$APP_PATH/Contents/Resources/app/guest"
  cp "$SCRIPT_DIR/smac-mac-bin" "$APP_PATH/Contents/MacOS/smac-guest"
  chmod +x "$APP_PATH/Contents/MacOS/smac-guest"
  [ -f "$SCRIPT_DIR/AppIcon-guest.icns" ] && cp "$SCRIPT_DIR/AppIcon-guest.icns" "$APP_PATH/Contents/Resources/AppIcon.icns"
  cp "$HOME/.smac-guest/guest-server.js" \
     "$HOME/.smac-guest/guest.html" \
     "$HOME/.smac-guest/guest.css" \
     "$HOME/.smac-guest/guest.js" \
     "$HOME/.smac-guest/guest-env.js" \
     "$APP_PATH/Contents/Resources/app/guest/" 2>/dev/null || true
  cat > "$APP_PATH/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>smac 客机控制台</string>
  <key>CFBundleName</key>
  <string>smac 客机控制台</string>
  <key>CFBundleExecutable</key>
  <string>smac-guest</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>com.smac.guest</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>2.0.0</string>
  <key>CFBundleVersion</key>
  <string>200</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsArbitraryLoads</key>
    <true/>
  </dict>
  <key>SmacAppMode</key>
  <string>guest</string>
</dict>
</plist>
PLIST
  xattr -cr "$APP_PATH" 2>/dev/null || true
  codesign --force --deep --sign - "$APP_PATH" >/dev/null 2>&1 || true
  LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
  [ -x "$LSREG" ] && "$LSREG" -f "$APP_PATH" || true
  mdimport "$APP_PATH" 2>/dev/null || true
  echo "[OK] 已安装 macOS 独立窗口应用: $APP_PATH（可按 Command+空格 输入 smac 打开）"
fi

if [ -n "$NODE_BIN" ] && [ -f "$HOME/.smac-guest/guest-server.js" ]; then
  echo ""
  echo "== 启动客机端独立窗口控制台 (http://127.0.0.1:8790/) =="
  nohup "$NODE_BIN" "$HOME/.smac-guest/guest-server.js" --open >"$HOME/.smac-guest/guest-web.log" 2>&1 </dev/null &
  sleep 1
  echo "[OK] 客机控制台已后台启动（可随时在独立窗口中主动连接或主动断联主机端）。"
fi
