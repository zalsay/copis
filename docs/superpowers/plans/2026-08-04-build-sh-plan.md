# Copis build.sh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a root-level executable script that builds the current macOS architecture's Copis DMG through the complete Electron build pipeline.

**Architecture:** `build.sh` resolves the repository root from its own location, initializes the Bun path, enters `apps/electron`, runs the package's complete build and runtime dependency synchronization, then invokes Electron Builder for the host architecture and DMG target. The existing `electron-builder.yml` remains the source of truth for the application name, which is already `Copis`.

**Tech Stack:** Bash, Bun workspace scripts, Electron Builder, macOS DMG packaging.

---

### Task 1: Add the root build script

**Files:**
- Create: `build.sh`

- [x] **Step 1: Add the script with strict execution and environment checks**

Create `build.sh` with the following contents:

```bash
#!/usr/bin/env bash
set -euo pipefail

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
echo "[Copis] 开始构建 macOS $MAC_ARCH DMG"
bun run build
bun run sync:runtime-deps
bunx electron-builder --mac --"$MAC_ARCH" --config.mac.target=dmg
echo "[Copis] 构建完成，产物目录: $APP_DIR/out"
```

- [x] **Step 2: Mark the script executable**

Run:

```bash
chmod +x build.sh
```

- [x] **Step 3: Verify the script syntax and diff formatting**

Run:

```bash
bash -n build.sh
git diff --check -- build.sh
```

Expected: both commands exit with status `0` and print no errors.

### Task 2: Verify the real packaging path

**Files:**
- Test: `build.sh`

- [x] **Step 1: Run the build script**

Run:

```bash
./build.sh
```

Result: the strict `./build.sh` path reached the existing native Agent Island helper and stopped because the installed Command Line Tools Swift compiler and macOS SDK versions do not match. Running the same script with the existing project fallback enabled, `COPIS_AGENT_ISLAND_NATIVE_OPTIONAL=1 ./build.sh`, completed the full Electron build, runtime dependency synchronization, and Electron Builder steps.

- [x] **Step 2: Confirm the generated artifact name**

Run:

```bash
find apps/electron/out -maxdepth 1 -type f -name 'Copis-*.dmg' -print
```

Result: `apps/electron/out/Copis-0.16.11-arm64.dmg` exists and contains an arm64 `Copis.app`.
