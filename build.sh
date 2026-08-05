#!/usr/bin/env bash
set -euo pipefail

# 默认只构建应用，不编译 Rust API，也不执行 COS 发布；发布流程由独立部署脚本负责。

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$ROOT_DIR/apps/electron"

export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  echo "[Copis] 未找到 Bun，请确认 $BUN_INSTALL/bin/bun 已安装。" >&2
  exit 1
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[Copis] build.sh 仅支持在 macOS 上生成 DMG。" >&2
  exit 1
fi

case "$(uname -m)" in
  arm64|aarch64)
    MAC_ARCH="arm64"
    ;;
  x86_64)
    MAC_ARCH="x64"
    ;;
  *)
    echo "[Copis] 不支持的 macOS 架构: $(uname -m)" >&2
    exit 1
    ;;
esac

export CSC_IDENTITY_AUTO_DISCOVERY="${CSC_IDENTITY_AUTO_DISCOVERY:-false}"

cd "$APP_DIR"
echo "[Copis] 默认构建仅包含 macOS 应用，不编译 Rust API，不发布 COS。"
echo "[Copis] 开始构建 macOS $MAC_ARCH DMG"
bun run build
bun run sync:runtime-deps
bunx electron-builder --mac --"$MAC_ARCH" --config.mac.target=dmg
echo "[Copis] 构建完成，产物目录: $APP_DIR/out"
