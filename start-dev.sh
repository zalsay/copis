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

echo "[Copis] 启动 Electron dev"
echo "[Copis] COPIS_BACKEND_URL=${COPIS_BACKEND_URL}"
echo "[Copis] Vite=http://127.0.0.1:5174"
echo "[Copis] HTTP API=http://127.0.0.1:51730"

exec bun run dev
