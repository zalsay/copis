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
export COPIS_BACKEND_URL="${COPIS_BACKEND_URL:-https://edu-api.meetlife.com.cn:9001}"
# 开发 Rust API 使用独立端口，避免连接到正式 App 的 51730 服务。
export COPIS_HTTP_API_PORT="${COPIS_HTTP_API_PORT:-51740}"

# 本地开发优先使用当前仓库构建的 Rust API，避免继续命中 ~/.copis/modules 中的旧版本。
LOCAL_RUST_HTTP_API="$ROOT_DIR/native/http-api-server/target/release/copis-http-api-server"
if [[ -x "$LOCAL_RUST_HTTP_API" ]]; then
  export COPIS_HTTP_API_SERVER="$LOCAL_RUST_HTTP_API"
fi

echo "[Copis] 启动 Electron dev"
echo "[Copis] COPIS_BACKEND_URL=${COPIS_BACKEND_URL}"
echo "[Copis] Vite=http://127.0.0.1:5174"
echo "[Copis] HTTP API=http://127.0.0.1:${COPIS_HTTP_API_PORT}"

exec bun run dev
