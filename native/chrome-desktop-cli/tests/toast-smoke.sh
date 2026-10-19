#!/bin/bash
# 显式展示短暂原生提示，仅验证 AppKit 状态，不操作 Chrome 或发送输入。
set -euo pipefail
if [[ "$(uname -s)" != Darwin ]]; then exit 2; fi
root="$(cd "$(dirname "$0")/.." && pwd)"
scratch="$(mktemp -d /tmp/copis-chrome-toast-smoke.XXXXXX)"
trap 'rm -rf "$scratch"' EXIT
sources=()
for source in "$root"/swift/*.swift; do
  [[ "$(basename "$source")" == main.swift ]] || sources+=("$source")
done
swiftc -O -warnings-as-errors -target "$(uname -m)-apple-macosx14.0" "${sources[@]}" \
  "$root/tests/toast/main.swift" -o "$scratch/toast-tests"
/usr/bin/python3 - "$scratch/toast-tests" <<'PY'
import subprocess
import sys
subprocess.run(sys.argv[1:], check=True, timeout=12)
PY
