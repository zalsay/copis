#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

# 与 ai-education/frontend/.env.development 保持一致，也允许本地临时覆盖。
export COPIS_BACKEND_URL="${COPIS_BACKEND_URL:-https://edu-api.meetlife.com.cn:9001}"

echo "[Copis] 启动 Electron dev"
echo "[Copis] COPIS_BACKEND_URL=${COPIS_BACKEND_URL}"
echo "[Copis] Vite=http://127.0.0.1:5174"
echo "[Copis] HTTP API=http://127.0.0.1:51730"

exec bun run dev
