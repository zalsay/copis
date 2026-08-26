#!/usr/bin/env bash
set -euo pipefail

# 默认只构建应用，不编译 Rust API；构建后上传固定文件名安装包，可用 --skip-cos-upload 跳过。

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$ROOT_DIR/apps/electron"

load_dotenv() {
  local env_file="$1"
  local line key value

  [[ -f "$env_file" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    line="${line#"${line%%[![:space:]]*}"}"
    if [[ "$line" == export[[:space:]]* ]]; then
      line="${line#export}"
      line="${line#"${line%%[![:space:]]*}"}"
    fi

    if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      if [[ -n "${!key+x}" ]]; then
        continue
      fi

      value="${value#"${value%%[![:space:]]*}"}"
      value="${value%"${value##*[![:space:]]}"}"
      if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then
        value="${value:1:${#value}-2}"
      elif [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
        value="${value:1:${#value}-2}"
      fi
      export "$key=$value"
    fi
  done < "$env_file"
}

load_dotenv "$ROOT_DIR/.env"

SKIP_COS_UPLOAD="${COPIS_SKIP_COS_UPLOAD:-0}"
NEW_VERSION=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --new)
      NEW_VERSION=1
      shift
      ;;
    --skip-cos-upload)
      SKIP_COS_UPLOAD=1
      shift
      ;;
    *)
      echo "[Copis] 未知参数: $1" >&2
      exit 1
      ;;
  esac
done

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

if [[ "$NEW_VERSION" -eq 1 ]]; then
  NEW_APP_VERSION="$(cd "$ROOT_DIR" && bun scripts/bump-electron-version.ts --new)"
  echo "[Copis] Electron 应用版本已更新为 $NEW_APP_VERSION"
fi

APP_VERSION="$(cd "$APP_DIR" && bun -e "console.log(JSON.parse(await Bun.file('package.json').text()).version)")"

cd "$APP_DIR"
echo "[Copis] 默认构建仅包含 macOS 应用，不编译 Rust API。"
echo "[Copis] 开始构建 macOS $MAC_ARCH DMG"
bun run build
bun run sync:runtime-deps
bunx electron-builder --mac --"$MAC_ARCH" --config.mac.target=dmg

VERSIONED_DMG="$APP_DIR/out/Copis-$APP_VERSION-$MAC_ARCH.dmg"
FIXED_DMG="$APP_DIR/out/Copis-$MAC_ARCH.dmg"
if [[ ! -f "$VERSIONED_DMG" ]]; then
  echo "[Copis] 未找到当前版本安装包：$VERSIONED_DMG" >&2
  exit 1
fi
cp -f "$VERSIONED_DMG" "$FIXED_DMG"
echo "[Copis] 固定安装包：$FIXED_DMG"

if [[ "$SKIP_COS_UPLOAD" -eq 0 ]]; then
  if [[ -z "${COS_PUBLIC_BASE_URL:-}" || -z "${COS_BUCKET_URL:-}" ]]; then
    echo "[Copis] 上传固定安装包需要 COS_PUBLIC_BASE_URL 和 COS_BUCKET_URL，或使用 --skip-cos-upload 跳过。" >&2
    exit 1
  fi
  (cd "$ROOT_DIR" && bun run publish:macos-installer -- \
    --file "$FIXED_DMG" \
    --arch "$MAC_ARCH" \
    --version "$APP_VERSION" \
    --public-base-url "$COS_PUBLIC_BASE_URL" \
    --bucket-url "$COS_BUCKET_URL")
  (cd "$ROOT_DIR" && bun run publish:client-update -- \
    --file "$FIXED_DMG" \
    --object-key "copis/downloads/stable/darwin-$MAC_ARCH/Copis-$MAC_ARCH.dmg" \
    --version "$APP_VERSION" \
    --public-base-url "$COS_PUBLIC_BASE_URL" \
    --bucket-url "$COS_BUCKET_URL")
fi

echo "[Copis] 构建完成，产物目录: $APP_DIR/out"
