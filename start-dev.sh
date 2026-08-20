#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

# Bun 安装器默认写入 ~/.bun/bin；脚本自身初始化 PATH，兼容非交互式启动。
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"
if ! command -v bun >/dev/null 2>&1; then
  echo "[Copis] 未找到 Bun，请确认 $BUN_INSTALL/bin/bun 已安装。" >&2
  exit 1
fi

# 与 ai-education/frontend/.env.development 保持一致，也允许本地临时覆盖。
export COPIS_BACKEND_URL="${COPIS_BACKEND_URL:-https://pie.meetlife.com.cn/pi-api}"
# 开发 Rust API 使用独立端口，避免连接到正式 App 的 51730 服务。
export COPIS_HTTP_API_PORT="${COPIS_HTTP_API_PORT:-51740}"

# 本地开发优先使用当前仓库构建的 Rust API，避免继续命中 ~/.copis/modules 中的旧版本。
LOCAL_RUST_HTTP_API="$ROOT_DIR/native/http-api-server/target/release/copis-http-api-server"
if [[ -x "$LOCAL_RUST_HTTP_API" ]]; then
  export COPIS_HTTP_API_SERVER="$LOCAL_RUST_HTTP_API"
fi

prepare_development_alipay_bot() {
  local platform architecture archive_path module_dir node_path
  if [[ -n "${COPIS_ALIPAY_BOT_CLI:-}" ]]; then
    return
  fi

  case "$(uname -s)" in
    Darwin) platform='darwin' ;;
    Linux) platform='linux' ;;
    *)
      echo "[Copis] start-dev.sh 不支持当前操作系统的支付宝智能体 CLI：$(uname -s)" >&2
      exit 1
      ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) architecture='arm64' ;;
    x86_64|amd64) architecture='x64' ;;
    *)
      echo "[Copis] 不支持当前架构的支付宝智能体 CLI：$(uname -m)" >&2
      exit 1
      ;;
  esac

  archive_path="$ROOT_DIR/apps/electron/resources/alipay-bot/${platform}-${architecture}.tar.gz"
  module_dir="${COPIS_DEV_ALIPAY_BOT_DIR:-$HOME/.copis-dev/alipay-bot/${platform}-${architecture}}"
  if [[ ! -f "$archive_path" || "${COPIS_REFRESH_ALIPAY_BOT_CLI:-0}" == '1' ]]; then
    echo '[Copis] 正在准备开发环境的官方支付宝智能体 CLI...'
    bun run prepare:alipay-bot-module -- --platform "$platform" --arch "$architecture" --output "$archive_path"
  fi

  mkdir -p "$module_dir"
  tar -xzf "$archive_path" -C "$module_dir"
  if [[ ! -x "$module_dir/bin/alipay-bot" ]]; then
    echo "[Copis] 开发环境支付宝智能体 CLI 入口无效：$module_dir/bin/alipay-bot" >&2
    exit 1
  fi
  node_path="$(node -p 'process.execPath')"
  if [[ ! -x "$node_path" ]]; then
    echo '[Copis] 未找到开发环境支付宝智能体 CLI 所需的 Node.js。' >&2
    exit 1
  fi
  export COPIS_ALIPAY_BOT_CLI="$module_dir/bin/alipay-bot"
  export COPIS_ALIPAY_BOT_NODE="$node_path"
}

prepare_development_alipay_bot

echo "[Copis] 启动 Electron dev"
echo "[Copis] COPIS_BACKEND_URL=${COPIS_BACKEND_URL}"
echo "[Copis] Vite=http://127.0.0.1:5174"
echo "[Copis] HTTP API=http://127.0.0.1:${COPIS_HTTP_API_PORT}"
echo "[Copis] Alipay CLI=${COPIS_ALIPAY_BOT_CLI}"

exec bun run dev
