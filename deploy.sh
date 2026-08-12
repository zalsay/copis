#!/usr/bin/env bash
set -euo pipefail

# 默认构建当前平台的功能模块并发布版本；应用包需要显式传入 --build-app。

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

export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

SKIP_INSTALL=0
BUILD_APP=0
SKIP_RUST_BUILD=0
SKIP_PUBLISH=0
RUST_ONLY="${COPIS_RUST_ONLY:-0}"
OFFICECLI_ONLY="${COPIS_OFFICECLI_ONLY:-0}"
NODE_RUNTIME_ONLY="${COPIS_NODE_RUNTIME_ONLY:-0}"
ALIPAY_BOT_ONLY="${COPIS_ALIPAY_BOT_ONLY:-0}"
PLATFORM="${COPIS_MODULE_PLATFORM:-}"
ARCH="${COPIS_MODULE_ARCH:-}"
CHANNEL="${COPIS_MODULE_CHANNEL:-stable}"
VERSION="${COPIS_MODULE_VERSION:-}"
CLIENT_MIN_VERSION="${COPIS_MODULE_CLIENT_MIN_VERSION:-}"
PUBLIC_BASE_URL="${COS_PUBLIC_BASE_URL:-}"
OBJECT_PREFIX_PATH="${OBJECT_PREFIX_PATH:-}"
RUST_BINARY="${COPIS_RUST_HTTP_API_BINARY:-}"
OFFICECLI_BINARY="${COPIS_OFFICECLI_BINARY:-}"
OFFICECLI_VERSION="${COPIS_OFFICECLI_VERSION:-}"
NODE_RUNTIME_ARCHIVE="${COPIS_NODE_RUNTIME_ARCHIVE:-}"
NODE_RUNTIME_VERSION="${COPIS_NODE_RUNTIME_VERSION:-}"
NODE_RUNTIME_SOURCE="${COPIS_NODE_RUNTIME_SOURCE:-}"
ALIPAY_BOT_ARCHIVE="${COPIS_ALIPAY_BOT_ARCHIVE:-}"
ALIPAY_BOT_VERSION="${COPIS_ALIPAY_BOT_VERSION:-}"

fail() {
  echo "[Copis] $*" >&2
  exit 1
}

show_help() {
  cat <<'EOF'
用法：./deploy.sh [选项]

默认行为：编译当前平台 Rust HTTP API、生成功能模块 manifest，并发布到 COS。
应用包默认不构建，使用 --build-app 显式开启。

选项：
  --skip-install       跳过 bun install --frozen-lockfile
  --build-app          同时构建当前平台 Electron 应用包
  --skip-rust-build    使用已有 Rust 二进制
  --rust               只发布 Rust HTTP API；缺失 Node.js runtime 或支付宝智能体 CLI 时仍可继续发布，分别用 --node-runtime 或 --alipay-bot 补齐
  --officecli          只发布 OfficeCLI，保留 COS 中已有 Node.js runtime、Rust HTTP API 与支付宝智能体 CLI
  --node-runtime       只发布 Node.js runtime，保留 COS 中已有 Rust HTTP API、OfficeCLI 与支付宝智能体 CLI
  --alipay-bot         只发布官方支付宝智能体 CLI，保留 COS 中已有 Node.js runtime、Rust HTTP API 与 OfficeCLI
  --skip-publish       只构建二进制，不发布 COS
  --platform <name>    win32、darwin 或 linux
  --arch <name>        x64 或 arm64
  --channel <name>     发布 channel，默认 stable
  --version <version>  功能模块版本，默认使用 Electron 版本
  --client-min-version 客户端最低版本，默认使用发布版本
  --public-base-url    COS_PUBLIC_BASE_URL 的显式值
  --prefix <path>      COS 对象前缀
  --rust-binary <path> 指定已有 Rust 二进制路径
  --officecli-binary <path> 指定已有 OfficeCLI 二进制路径
  --officecli-version <version> 指定 OfficeCLI 模块版本，默认读取二进制版本
  --node-runtime-archive <path> 指定已打包的 Node.js runtime tar.gz
  --node-runtime-version <version> 指定 Node.js runtime 模块版本，默认使用功能模块版本
  --alipay-bot-archive <path> 指定已打包的 alipay-bot tar.gz
  --alipay-bot-version <version> 指定 alipay-bot 模块版本，默认读取官方 runtime 版本
  -h, --help           显示帮助
EOF
}

require_value() {
  if [[ $# -lt 2 || -z "${2:-}" ]]; then
    fail "$1 缺少参数值"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-install)
      SKIP_INSTALL=1
      ;;
    --build-app)
      BUILD_APP=1
      ;;
    --skip-rust-build)
      SKIP_RUST_BUILD=1
      ;;
    --rust)
      RUST_ONLY=1
      ;;
    --officecli)
      OFFICECLI_ONLY=1
      ;;
    --node-runtime)
      NODE_RUNTIME_ONLY=1
      ;;
    --alipay-bot)
      ALIPAY_BOT_ONLY=1
      ;;
    --skip-publish)
      SKIP_PUBLISH=1
      ;;
    --platform)
      require_value "$1" "${2:-}"
      PLATFORM="$2"
      shift
      ;;
    --arch)
      require_value "$1" "${2:-}"
      ARCH="$2"
      shift
      ;;
    --channel)
      require_value "$1" "${2:-}"
      CHANNEL="$2"
      shift
      ;;
    --version)
      require_value "$1" "${2:-}"
      VERSION="$2"
      shift
      ;;
    --client-min-version)
      require_value "$1" "${2:-}"
      CLIENT_MIN_VERSION="$2"
      shift
      ;;
    --public-base-url)
      require_value "$1" "${2:-}"
      PUBLIC_BASE_URL="$2"
      shift
      ;;
    --prefix)
      require_value "$1" "${2:-}"
      OBJECT_PREFIX_PATH="$2"
      shift
      ;;
    --rust-binary)
      require_value "$1" "${2:-}"
      RUST_BINARY="$2"
      shift
      ;;
    --officecli-binary)
      require_value "$1" "${2:-}"
      OFFICECLI_BINARY="$2"
      shift
      ;;
    --officecli-version)
      require_value "$1" "${2:-}"
      OFFICECLI_VERSION="$2"
      shift
      ;;
    --node-runtime-archive)
      require_value "$1" "${2:-}"
      NODE_RUNTIME_ARCHIVE="$2"
      shift
      ;;
    --node-runtime-version)
      require_value "$1" "${2:-}"
      NODE_RUNTIME_VERSION="$2"
      shift
      ;;
    --alipay-bot-archive)
      require_value "$1" "${2:-}"
      ALIPAY_BOT_ARCHIVE="$2"
      shift
      ;;
    --alipay-bot-version)
      require_value "$1" "${2:-}"
      ALIPAY_BOT_VERSION="$2"
      shift
      ;;
    -h|--help)
      show_help
      exit 0
      ;;
    *)
      fail "未知参数：$1"
      ;;
  esac
  shift
done

if [[ $((RUST_ONLY + OFFICECLI_ONLY + NODE_RUNTIME_ONLY + ALIPAY_BOT_ONLY)) -gt 1 ]]; then
  fail '--rust、--officecli、--node-runtime 与 --alipay-bot 不能同时使用。'
fi

if ! command -v bun >/dev/null 2>&1; then
  fail "未找到 Bun，请确认 $BUN_INSTALL/bin/bun 已安装并位于 PATH。"
fi
BUN_BIN="$(command -v bun)"

if [[ ! -f "$ROOT_DIR/package.json" || ! -f "$APP_DIR/package.json" ]]; then
  fail "项目 package.json 不完整：$ROOT_DIR"
fi

case "$(uname -s)" in
  Darwin)
    CURRENT_PLATFORM="darwin"
    ;;
  Linux)
    CURRENT_PLATFORM="linux"
    ;;
  *)
    fail "deploy.sh 不支持当前操作系统：$(uname -s)"
    ;;
esac

case "$(uname -m)" in
  arm64|aarch64)
    CURRENT_ARCH="arm64"
    ;;
  x86_64|amd64)
    CURRENT_ARCH="x64"
    ;;
  *)
    fail "不支持的当前架构：$(uname -m)"
    ;;
esac

PLATFORM="${PLATFORM:-$CURRENT_PLATFORM}"
ARCH="${ARCH:-$CURRENT_ARCH}"
case "$PLATFORM" in
  win32|darwin|linux)
    ;;
  *)
    fail "不支持的功能模块平台：$PLATFORM"
    ;;
esac
case "$ARCH" in
  x64|arm64)
    ;;
  *)
    fail "不支持的功能模块架构：$ARCH"
    ;;
esac

if [[ -z "$CHANNEL" ]]; then
  fail '发布 channel 不能为空。'
fi

APP_VERSION="$(cd "$ROOT_DIR" && "$BUN_BIN" -e 'const pkg = JSON.parse(await Bun.file("apps/electron/package.json").text()); console.log(pkg.version)')"
VERSION="${VERSION:-$APP_VERSION}"
CLIENT_MIN_VERSION="${CLIENT_MIN_VERSION:-$VERSION}"

run_bun() {
  local working_directory="$1"
  local failure_message="$2"
  shift 2
  if ! (cd "$working_directory" && "$BUN_BIN" "$@"); then
    fail "$failure_message"
  fi
}

is_node_runtime_24() {
  local node_path="$1"
  local version
  [[ -x "$node_path" ]] || return 1
  version="$("$node_path" --version 2>/dev/null || true)"
  [[ "$version" =~ ^v?24\. ]]
}

resolve_node_runtime_source() {
  local system_node nvm_root candidate
  if [[ -n "$NODE_RUNTIME_SOURCE" ]]; then
    printf '%s\n' "$NODE_RUNTIME_SOURCE"
    return
  fi

  system_node="$(node -p 'process.execPath' 2>/dev/null || true)"
  if [[ -n "$system_node" ]] && is_node_runtime_24 "$system_node"; then
    dirname "$system_node"
    return
  fi

  nvm_root="${NVM_DIR:-$HOME/.nvm}"
  for candidate in "$nvm_root"/versions/node/v24.* /opt/homebrew/opt/node@24 /usr/local/opt/node@24; do
    if is_node_runtime_24 "$candidate/bin/node"; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  fail '未找到 Node.js 24 runtime。请安装 Node.js 24，或通过 COPIS_NODE_RUNTIME_SOURCE 指定其安装目录。'
}

read_node_runtime_version() {
  local source="$1"
  local node_path version
  for node_path in "$source/bin/node" "$source/node"; do
    if is_node_runtime_24 "$node_path"; then
      version="$("$node_path" --version)"
      printf '%s\n' "${version#v}"
      return
    fi
  done
  fail "Node.js runtime 源目录不是 Node.js 24：$source"
}

read_officecli_version() {
  local binary="$1"
  local version
  version="$("$binary" --version 2>/dev/null || true)"
  if [[ "$version" =~ ([0-9]+\.[0-9]+\.[0-9]+) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return
  fi
  fail "无法读取 OfficeCLI 版本：$binary"
}

read_alipay_bot_version() {
  local archive runtime_metadata
  archive="$1"
  runtime_metadata="$(LC_ALL=C tar -xOf "$archive" ./runtime/package.json 2>/dev/null)"
  if [[ -z "$runtime_metadata" ]]; then
    fail "无法读取支付宝智能体 CLI 归档版本：$archive"
  fi
  "$BUN_BIN" -e '
    const metadata = JSON.parse(process.argv[1])
    if (typeof metadata.version !== "string" || !/^\d+\.\d+\.\d+/.test(metadata.version)) {
      throw new Error("runtime package.json 缺少 version")
    }
    console.log(metadata.version)
  ' "$runtime_metadata"
}

if [[ "$SKIP_INSTALL" -eq 0 ]]; then
  echo '[Copis] 正在按 bun.lock 安装依赖...'
  run_bun "$ROOT_DIR" 'Bun 依赖安装失败' install --frozen-lockfile
fi

if [[ "$PLATFORM" == 'win32' ]]; then
  DEFAULT_RUST_BINARY="$ROOT_DIR/native/http-api-server/target/release/copis-http-api-server.exe"
else
  DEFAULT_RUST_BINARY="$ROOT_DIR/native/http-api-server/target/release/copis-http-api-server"
fi

if [[ "$OFFICECLI_ONLY" != '1' && "$NODE_RUNTIME_ONLY" != '1' && "$ALIPAY_BOT_ONLY" != '1' && "$SKIP_RUST_BUILD" -eq 0 ]]; then
  if [[ "$PLATFORM" != "$CURRENT_PLATFORM" || "$ARCH" != "$CURRENT_ARCH" ]]; then
    fail 'deploy.sh 默认只能在当前平台和架构编译 Rust API；跨平台产物请传入 --skip-rust-build 和 --rust-binary。'
  fi
  echo '[Copis] 正在显式构建 Rust HTTP API 二进制...'
  run_bun "$APP_DIR" 'Rust HTTP API 构建失败' run build:http-api-server
fi

if [[ "$OFFICECLI_ONLY" != '1' && "$NODE_RUNTIME_ONLY" != '1' && "$ALIPAY_BOT_ONLY" != '1' ]]; then
  if [[ -n "$RUST_BINARY" && "$RUST_BINARY" != /* ]]; then
    RUST_BINARY="$ROOT_DIR/$RUST_BINARY"
  fi
  RUST_BINARY="${RUST_BINARY:-$DEFAULT_RUST_BINARY}"
  if [[ ! -f "$RUST_BINARY" ]]; then
    fail "未找到 Rust HTTP API 二进制：$RUST_BINARY"
  fi
  RUST_BINARY="$(cd "$(dirname "$RUST_BINARY")" && pwd)/$(basename "$RUST_BINARY")"
fi

if [[ "$RUST_ONLY" != '1' && "$NODE_RUNTIME_ONLY" != '1' && "$ALIPAY_BOT_ONLY" != '1' ]]; then
  if [[ -n "$OFFICECLI_BINARY" && "$OFFICECLI_BINARY" != /* ]]; then
    OFFICECLI_BINARY="$ROOT_DIR/$OFFICECLI_BINARY"
  fi
  if [[ -z "$OFFICECLI_BINARY" ]]; then
    OFFICECLI_BINARY="$APP_DIR/resources/bin/officecli"
    if [[ "$PLATFORM" == 'win32' ]]; then
      OFFICECLI_BINARY+='.exe'
    fi
    echo '[Copis] 正在从 GitHub release 准备 OfficeCLI 功能模块...'
    run_bun "$ROOT_DIR" 'OfficeCLI 功能模块准备失败' run prepare:officecli-module -- \
      --platform "$PLATFORM" --arch "$ARCH" --output "$OFFICECLI_BINARY"
  fi
  if [[ ! -f "$OFFICECLI_BINARY" ]]; then
    fail "未找到 OfficeCLI 二进制：$OFFICECLI_BINARY"
  fi
  OFFICECLI_BINARY="$(cd "$(dirname "$OFFICECLI_BINARY")" && pwd)/$(basename "$OFFICECLI_BINARY")"
  OFFICECLI_VERSION="${OFFICECLI_VERSION:-$(read_officecli_version "$OFFICECLI_BINARY")}"
fi

if [[ "$RUST_ONLY" != '1' && "$OFFICECLI_ONLY" != '1' && "$ALIPAY_BOT_ONLY" != '1' ]]; then
  if [[ "$PLATFORM" != "$CURRENT_PLATFORM" || "$ARCH" != "$CURRENT_ARCH" ]]; then
    fail 'Node.js runtime 必须在目标平台和架构构建，跨平台请传入 --node-runtime-archive。'
  fi
  if [[ -z "$NODE_RUNTIME_ARCHIVE" ]]; then
    NODE_RUNTIME_ARCHIVE="$APP_DIR/resources/node-runtime/${PLATFORM}-${ARCH}.tar.gz"
    NODE_RUNTIME_SOURCE="$(resolve_node_runtime_source)"
    echo '[Copis] 正在打包 Node.js runtime 功能模块...'
    run_bun "$ROOT_DIR" 'Node.js runtime 模块构建失败' run build:node-runtime-module -- \
      --source "$NODE_RUNTIME_SOURCE" --output "$NODE_RUNTIME_ARCHIVE"
    NODE_RUNTIME_VERSION="${NODE_RUNTIME_VERSION:-$(read_node_runtime_version "$NODE_RUNTIME_SOURCE")}"
  elif [[ ! -f "$NODE_RUNTIME_ARCHIVE" ]]; then
    fail "未找到 Node.js runtime 归档：$NODE_RUNTIME_ARCHIVE"
  fi
  NODE_RUNTIME_VERSION="${NODE_RUNTIME_VERSION:-$VERSION}"
fi

if [[ "$RUST_ONLY" != '1' && "$OFFICECLI_ONLY" != '1' && "$NODE_RUNTIME_ONLY" != '1' ]]; then
  if [[ -n "$ALIPAY_BOT_ARCHIVE" && "$ALIPAY_BOT_ARCHIVE" != /* ]]; then
    ALIPAY_BOT_ARCHIVE="$ROOT_DIR/$ALIPAY_BOT_ARCHIVE"
  fi
  if [[ -z "$ALIPAY_BOT_ARCHIVE" ]]; then
    ALIPAY_BOT_ARCHIVE="$APP_DIR/resources/alipay-bot/${PLATFORM}-${ARCH}.tar.gz"
  fi
  if [[ ! -f "$ALIPAY_BOT_ARCHIVE" || "${COPIS_REFRESH_ALIPAY_BOT_CLI:-0}" == '1' ]]; then
    if [[ "$PLATFORM" != "$CURRENT_PLATFORM" || "$ARCH" != "$CURRENT_ARCH" ]]; then
      fail '支付宝智能体 CLI 必须在目标平台和架构准备，跨平台请传入 --alipay-bot-archive。'
    fi
    ALIPAY_BOT_METADATA="$(mktemp "${TMPDIR:-/tmp}/copis-alipay-bot-metadata.XXXXXX")"
    echo '[Copis] 正在通过官方安装器准备支付宝智能体 CLI 功能模块...'
    run_bun "$ROOT_DIR" '支付宝智能体 CLI 功能模块准备失败' run prepare:alipay-bot-module -- \
      --platform "$PLATFORM" --arch "$ARCH" --output "$ALIPAY_BOT_ARCHIVE" --metadata "$ALIPAY_BOT_METADATA"
    ALIPAY_BOT_VERSION="${ALIPAY_BOT_VERSION:-$(cd "$ROOT_DIR" && "$BUN_BIN" -e 'const metadata = JSON.parse(await Bun.file(process.argv[1]).text()); console.log(metadata.version)' "$ALIPAY_BOT_METADATA")}"
    rm -f "$ALIPAY_BOT_METADATA"
  fi
  if [[ ! -f "$ALIPAY_BOT_ARCHIVE" ]]; then
    fail "未找到支付宝智能体 CLI 归档：$ALIPAY_BOT_ARCHIVE"
  fi
  ALIPAY_BOT_VERSION="${ALIPAY_BOT_VERSION:-$(read_alipay_bot_version "$ALIPAY_BOT_ARCHIVE")}"
fi

if [[ "$BUILD_APP" -eq 1 ]]; then
  if [[ "$PLATFORM" != "$CURRENT_PLATFORM" ]]; then
    fail '--build-app 只能构建当前平台的 Electron 应用。'
  fi
  echo '[Copis] 正在构建 Electron 应用（默认构建不包含 Rust API 与 COS 发布）...'
  if [[ "$CURRENT_PLATFORM" == 'darwin' ]]; then
    bash "$ROOT_DIR/build.sh"
  else
    run_bun "$APP_DIR" 'Electron 应用构建失败' run build
    run_bun "$APP_DIR" '运行时依赖同步失败' run sync:runtime-deps
    run_bun "$APP_DIR" 'Linux Electron 打包失败' x electron-builder --linux
  fi
fi

if [[ "$SKIP_PUBLISH" -eq 0 ]]; then
  if [[ -z "$PUBLIC_BASE_URL" ]]; then
    fail '发布功能模块需要 COS_PUBLIC_BASE_URL 或 --public-base-url。'
  fi

  RELEASE_ARGS=(
    --platform "$PLATFORM"
    --arch "$ARCH"
    --channel "$CHANNEL"
    --version "$VERSION"
    --client-min-version "$CLIENT_MIN_VERSION"
    --public-base-url "$PUBLIC_BASE_URL"
  )
  MANIFEST_OUTPUT="$APP_DIR/dist/functional-modules/manifest.json"
  if [[ "$OFFICECLI_ONLY" != '1' && "$NODE_RUNTIME_ONLY" != '1' && "$ALIPAY_BOT_ONLY" != '1' ]]; then
    RELEASE_ARGS+=(--rust-binary "$RUST_BINARY")
  fi
  if [[ "$RUST_ONLY" != '1' && "$NODE_RUNTIME_ONLY" != '1' && "$ALIPAY_BOT_ONLY" != '1' ]]; then
    RELEASE_ARGS+=(--officecli-binary "$OFFICECLI_BINARY" --officecli-version "$OFFICECLI_VERSION")
  fi
  if [[ "$RUST_ONLY" != '1' && "$OFFICECLI_ONLY" != '1' && "$ALIPAY_BOT_ONLY" != '1' ]]; then
    RELEASE_ARGS+=(--node-runtime-archive "$NODE_RUNTIME_ARCHIVE" --node-runtime-version "$NODE_RUNTIME_VERSION")
  fi
  if [[ "$RUST_ONLY" != '1' && "$OFFICECLI_ONLY" != '1' && "$NODE_RUNTIME_ONLY" != '1' ]]; then
    RELEASE_ARGS+=(--alipay-bot-archive "$ALIPAY_BOT_ARCHIVE" --alipay-bot-version "$ALIPAY_BOT_VERSION")
  fi
  if [[ -n "$OBJECT_PREFIX_PATH" ]]; then
    RELEASE_ARGS+=(--prefix "$OBJECT_PREFIX_PATH")
  fi
  if [[ "$RUST_ONLY" == '1' ]]; then
    RELEASE_ARGS+=(--rust)
  fi
  if [[ "$OFFICECLI_ONLY" == '1' ]]; then
    RELEASE_ARGS+=(--officecli)
  fi
  if [[ "$NODE_RUNTIME_ONLY" == '1' ]]; then
    RELEASE_ARGS+=(--node-runtime)
  fi
  if [[ "$ALIPAY_BOT_ONLY" == '1' ]]; then
    RELEASE_ARGS+=(--alipay-bot)
  fi

  echo '[Copis] 正在生成功能模块 manifest...'
  run_bun "$ROOT_DIR" '功能模块 manifest 构建失败' run build:functional-module-manifest -- "${RELEASE_ARGS[@]}" --output "$MANIFEST_OUTPUT"
  echo '[Copis] 正在发布功能模块二进制与 manifest 到 COS...'
  run_bun "$ROOT_DIR" '功能模块 COS 发布失败' run publish:functional-modules -- "${RELEASE_ARGS[@]}" --manifest-output "$MANIFEST_OUTPUT"
  PUBLISHED_MODULE_VERSIONS="$(cd "$ROOT_DIR" && "$BUN_BIN" -e '
    const [manifestPath, platform, arch] = process.argv.slice(1)
    const manifest = JSON.parse(await Bun.file(manifestPath).text())
    const modules = manifest.platforms?.[`${platform}-${arch}`]?.modules
    if (!modules || typeof modules !== "object") throw new Error(`最终 manifest 缺少平台: ${platform}-${arch}`)
    const versions = Object.entries(modules)
      .map(([name, artifact]) => `${name}=${artifact.version}`)
      .sort()
      .join(", ")
    if (!versions) throw new Error(`最终 manifest 缺少模块: ${platform}-${arch}`)
    console.log(versions)
  ' "$MANIFEST_OUTPUT" "$PLATFORM" "$ARCH")"
  echo "[Copis] 功能模块发布完成：$PLATFORM/$ARCH $PUBLISHED_MODULE_VERSIONS"
else
  echo '[Copis] 已跳过 COS 发布（--skip-publish）。'
fi

echo '[Copis] 部署流程完成。'
