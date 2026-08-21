#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"
mode="${1:-}"
upstream_root="${DASHI_PPT_UPSTREAM_ROOT:-${repo_root}/third_party/dashi-ppt-skill}"
destination="${DASHI_PPT_DESTINATION:-${repo_root}/apps/electron/default-skills/dashi-ppt}"
patch_file="${DASHI_PPT_PATCH:-${repo_root}/patches/dashi-ppt/local-customizations.patch}"
upstream_skill="${upstream_root}/skills/dashi-ppt"
destination_parent="$(dirname "$destination")"
work_root=""

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$work_root" && -d "$work_root" ]]; then
    rm -rf "$work_root"
  fi
}

validate_inputs() {
  [[ "$mode" == "--write" || "$mode" == "--check" ]] || fail "用法: $0 --write|--check"
  [[ -f "${upstream_skill}/SKILL.md" ]] || fail "上游子模块未初始化: ${upstream_root}"
  [[ -f "${upstream_skill}/project/package.json" ]] || fail "上游 Skill 缺少 project/package.json"
  [[ -f "$patch_file" ]] || fail "本地定制补丁不存在: ${patch_file}"
  mkdir -p "$destination_parent"
}

apply_local_patch() {
  local staged="$1"
  [[ -s "$patch_file" ]] || return 0
  if ! (cd "$staged" && GIT_CEILING_DIRECTORIES="$work_root" git apply --unsafe-paths --check "$patch_file"); then
    fail "本地定制补丁无法应用: ${patch_file}"
  fi
  (cd "$staged" && GIT_CEILING_DIRECTORIES="$work_root" git apply --unsafe-paths "$patch_file")
}

upstream_commit() {
  git -C "$upstream_root" rev-parse HEAD 2>/dev/null || printf '2eee97e5a58cfc54fd0ca66b582251153710f64f\n'
}

upstream_version() {
  node -e 'const p=require(process.argv[1]); process.stdout.write(String(p.version || ""))' \
    "${upstream_skill}/project/package.json" 2>/dev/null || printf '0.4.2\n'
}

write_upstream_metadata() {
  local staged="$1"
  local commit version
  commit="$(upstream_commit)"
  version="$(upstream_version)"
  [[ -n "$version" ]] || fail "无法读取上游 Skill 版本"
  cat >"${staged}/UPSTREAM.md" <<EOF
# Upstream

- Repository: https://github.com/chuspeeism/dashi-ppt-skill
- Commit: \`${commit}\`
- Skill version: \`${version}\`

This directory is rebuilt from the pinned submodule plus \`patches/dashi-ppt/local-customizations.patch\`.
EOF
}

validate_staged_skill() {
  local staged="$1"
  [[ "$(sed -n '1p' "${staged}/SKILL.md")" == "---" ]] || fail "合并后的 SKILL.md 缺少 YAML frontmatter"
  grep -Eq '^name:[[:space:]]*[^[:space:]]' "${staged}/SKILL.md" || fail "合并后的 SKILL.md 缺少 name"
  grep -Eq '^displayName:[[:space:]]*.+$' "${staged}/SKILL.md" || fail "合并后的 SKILL.md 缺少 displayName"
  grep -Eq '^group:[[:space:]]*.+$' "${staged}/SKILL.md" || fail "合并后的 SKILL.md 缺少 group"
  grep -Eq '^version:[[:space:]]*.+$' "${staged}/SKILL.md" || fail "合并后的 SKILL.md 缺少 version"
  grep -Eq '^description:[[:space:]]*.+$' "${staged}/SKILL.md" || fail "合并后的 SKILL.md 缺少 description"
}

prepare_staged_skill() {
  local staged="${work_root}/staged"
  mkdir -p "$staged"
  cp -R "${upstream_skill}/." "$staged/"
  if [[ -f "${upstream_root}/LICENSE" ]]; then
    cp "${upstream_root}/LICENSE" "${staged}/LICENSE"
  fi
  # 清除上游可能残留的运行时依赖与构建产物目录
  rm -rf "${staged}/node_modules" \
         "${staged}/.playwright-browsers" \
         "${staged}/output" \
         "${staged}/screens" \
         "${staged}/uploads" \
         "${staged}/project/node_modules" \
         "${staged}/project/.playwright-browsers" \
         "${staged}/project/output" \
         "${staged}/project/screens" \
         "${staged}/project/uploads" \
         "${staged}/.git"
  apply_local_patch "$staged"
  write_upstream_metadata "$staged"
  validate_staged_skill "$staged"
}

check_for_drift() {
  local staged="${work_root}/staged"
  local output
  if ! output="$(diff -qr --exclude=node_modules --exclude=output --exclude=.playwright-browsers "$staged" "$destination" 2>&1)"; then
    printf '%s\n' "$output" >&2
    fail "Dashi PPT 合并副本存在漂移"
  fi
  printf 'Dashi PPT 合并副本无漂移\n'
}

reject_dirty_destination() {
  [[ -n "${DASHI_PPT_DESTINATION+x}" ]] && return 0
  local dirty
  dirty="$(git -C "$repo_root" status --porcelain --untracked-files=all -- apps/electron/default-skills/dashi-ppt 2>/dev/null || true)"
  [[ -z "$dirty" ]] || fail "apps/electron/default-skills/dashi-ppt 存在未提交修改,拒绝覆盖"
}

replace_destination() {
  local staged="${work_root}/staged"
  local backup="${work_root}/backup"
  reject_dirty_destination
  if [[ -e "$destination" ]]; then
    mv "$destination" "$backup"
  fi
  if ! mv "$staged" "$destination"; then
    [[ -e "$backup" ]] && mv "$backup" "$destination"
    fail "替换 Dashi PPT 合并副本失败"
  fi
  rm -rf "$backup"
  printf '已更新 Dashi PPT 合并副本: %s\n' "$destination"
}

validate_inputs
work_root="$(mktemp -d "${destination_parent}/.dashi-ppt-sync.XXXXXX")"
trap cleanup EXIT
prepare_staged_skill

if [[ "$mode" == "--check" ]]; then
  check_for_drift
else
  replace_destination
fi
