#!/usr/bin/env bash
set -euo pipefail

# smac - macOS / Linux 主机端统一入口
# 用法:
#   ./smac.sh web          启动网页控制台并自动打开浏览器
#   ./smac.sh web stop     停止网页控制台
#   ./smac.sh discover     立即自动识别已配对机器并映射同步文件夹
#   ./smac.sh sync now     立即执行一次双向同步
#   ./smac.sh sync start   启动后台定时同步守护
#   ./smac.sh sync stop    停止后台定时同步守护
#   ./smac.sh status       查看运行状态

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/current/bin:$HOME/.hermes/node/bin:$HOME/.local/bin:$PATH"

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$HOME/.smac"
mkdir -p "$DATA_DIR"

WEB_PID="$DATA_DIR/web.pid"
WEB_PORT="$DATA_DIR/web-port"
WEB_LOG="$DATA_DIR/web.log"
WEB_ERR="$DATA_DIR/web.err.log"

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for cand in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.hermes/node/bin/node"; do
    if [ -x "$cand" ]; then
      echo "$cand"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(find_node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "[X] 未找到 Node.js，请先安装 Node.js（如 brew install node）。" >&2
  exit 1
fi

ensure_deps() {
  if [ ! -d "$APP_DIR/web/node_modules/ssh2" ] || [ ! -d "$APP_DIR/web/node_modules/ws" ]; then
    echo "==> 首次启动正在安装控制台依赖 (ssh2 / ws)…"
    (cd "$APP_DIR/web" && npm install --omit=optional --no-audit --no-fund)
  fi
}

check_health() {
  local port="$1"
  [ -n "$port" ] || return 1
  curl -fsS --max-time 1 "http://127.0.0.1:${port}/api/health" 2>/dev/null | grep -q '"app":"smac"'
}

open_url() {
  local url="$1"
  if command -v open >/dev/null 2>&1; then
    open "$url" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 || true
  fi
}

cmd="${1:-web}"
sub="${2:-}"

case "$cmd" in
  web)
    if [ "$sub" = "stop" ]; then
      if [ -f "$WEB_PID" ]; then
        pid="$(cat "$WEB_PID" 2>/dev/null || true)"
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
          kill -TERM "$pid" 2>/dev/null || true
          sleep 0.5
          kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
          echo "[OK] 网页控制台已停止。"
        else
          echo "[..] 网页控制台未在运行（已清理残留记录）。"
        fi
        rm -f "$WEB_PID" "$WEB_PORT"
      else
        echo "[..] 网页控制台未在运行。"
      fi
      exit 0
    fi

    ensure_deps

    if [ -f "$WEB_PORT" ]; then
      existing_port="$(cat "$WEB_PORT" 2>/dev/null || true)"
      if check_health "$existing_port"; then
        echo "[OK] 网页控制台已在运行: http://127.0.0.1:${existing_port}/"
        if [ "$sub" != "--no-open" ]; then open_url "http://127.0.0.1:${existing_port}/"; fi
        exit 0
      fi
    fi

    for p in 8788 8789 8790 8791 8792; do
      if check_health "$p"; then
        echo "[OK] 网页控制台已在运行: http://127.0.0.1:${p}/"
        if [ "$sub" != "--no-open" ]; then open_url "http://127.0.0.1:${p}/"; fi
        exit 0
      fi
    done

    rm -f "$WEB_PID" "$WEB_PORT"
    nohup "$NODE_BIN" "$APP_DIR/web/server.js" >"$WEB_LOG" 2>"$WEB_ERR" </dev/null &

    live_port=""
    for _ in $(seq 1 40); do
      sleep 0.25
      if [ -f "$WEB_PORT" ]; then
        cand="$(cat "$WEB_PORT" 2>/dev/null || true)"
        if check_health "$cand"; then
          live_port="$cand"
          break
        fi
      fi
    done

    if [ -z "$live_port" ]; then
      echo "[X] 网页控制台启动失败，请查看日志: $WEB_ERR" >&2
      tail -n 20 "$WEB_ERR" 2>/dev/null || true
      exit 1
    fi

    echo "[OK] smac 网页控制台已启动: http://127.0.0.1:${live_port}/"
    if [ "$sub" != "--no-open" ]; then open_url "http://127.0.0.1:${live_port}/"; fi
    ;;

  discover)
    ensure_deps
    "$NODE_BIN" -e "require('$APP_DIR/web/peer-discovery.js').discoverAllPairedPeers().then(r => console.log(JSON.stringify(r, null, 2)))"
    ;;

  sync)
    ensure_deps
    case "$sub" in
      now)
        "$NODE_BIN" -e "require('$APP_DIR/web/host-engine.js').syncNow('${3:-}', l => console.log(l)).then(r => process.exit(r.ok ? 0 : 1))"
        ;;
      start)
        "$NODE_BIN" -e "console.log(require('$APP_DIR/web/host-engine.js').startDaemon('sync').output)"
        ;;
      stop)
        "$NODE_BIN" -e "console.log(require('$APP_DIR/web/host-engine.js').stopDaemon('sync').output)"
        ;;
      *)
        echo "用法: ./smac.sh sync [now [名称]|start|stop]"
        ;;
    esac
    ;;

  status)
    if [ -f "$WEB_PORT" ] && check_health "$(cat "$WEB_PORT" 2>/dev/null || true)"; then
      echo "[OK] 控制台运行中: http://127.0.0.1:$(cat "$WEB_PORT")/"
    else
      echo "[..] 控制台未运行"
    fi
    ;;

  *)
    echo "用法: ./smac.sh [web|web stop|discover|sync now|sync start|sync stop|status]"
    ;;
esac
