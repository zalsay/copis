#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"
sync_script="${script_dir}/sync-dashi-ppt-skill.sh"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/dashi-ppt-sync-test.XXXXXX")"
repo_fixture="${repo_root}/.dashi-ppt-sync-test-${RANDOM}"
trap 'rm -rf "$test_root" "$repo_fixture"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local value="$1"
  local expected="$2"
  [[ "$value" == *"$expected"* ]] || fail "expected output to contain: ${expected}"
}

create_fixture() {
  local fixture="$1"
  local upstream="${fixture}/upstream"
  mkdir -p "${upstream}/skills/dashi-ppt/project"
  cat >"${upstream}/skills/dashi-ppt/SKILL.md" <<'EOF'
---
name: fixture-ppt
description: Fixture skill used by the synchronization test.
---

# Fixture
EOF
  cat >"${upstream}/skills/dashi-ppt/project/package.json" <<'EOF'
{"name":"fixture-ppt","version":"9.9.9"}
EOF
  printf 'fixture license\n' >"${upstream}/LICENSE"
  printf 'upstream\n' >"${upstream}/skills/dashi-ppt/content.txt"
  git -C "$upstream" init -q
  git -C "$upstream" config user.name "fixture"
  git -C "$upstream" config user.email "fixture@example.invalid"
  git -C "$upstream" add .
  git -C "$upstream" commit -q -m fixture

  cat >"${fixture}/local.patch" <<'EOF'
diff --git a/SKILL.md b/SKILL.md
--- a/SKILL.md
+++ b/SKILL.md
@@ -1,4 +1,8 @@
 ---
 name: fixture-ppt
+displayName: Fixture PPT
+group: 系统内置
+version: "9.9.9"
+license: AGPL-3.0-only
 description: Fixture skill used by the synchronization test.
 ---
diff --git a/content.txt b/content.txt
--- a/content.txt
+++ b/content.txt
@@ -1 +1 @@
-upstream
+custom
EOF
}

run_sync() {
  local fixture="$1"
  shift
  DASHI_PPT_UPSTREAM_ROOT="${fixture}/upstream" \
  DASHI_PPT_DESTINATION="${fixture}/destination" \
  DASHI_PPT_PATCH="${fixture}/local.patch" \
    "$sync_script" "$@"
}

test_missing_upstream_fails() {
  local fixture="${test_root}/missing"
  local output
  mkdir -p "$fixture"
  printf '' >"${fixture}/local.patch"
  set +e
  output="$(run_sync "$fixture" --check 2>&1)"
  local status=$?
  set -e
  [[ $status -ne 0 ]] || fail "missing upstream should fail"
  assert_contains "$output" "上游子模块未初始化"
}

test_write_and_check_are_reproducible() {
  local fixture="${test_root}/reproducible"
  local commit
  mkdir -p "$fixture"
  create_fixture "$fixture"
  run_sync "$fixture" --write
  [[ "$(cat "${fixture}/destination/content.txt")" == "custom" ]] || fail "local patch was not applied"
  [[ "$(cat "${fixture}/destination/LICENSE")" == "fixture license" ]] || fail "upstream license was not copied"
  commit="$(git -C "${fixture}/upstream" rev-parse HEAD)"
  assert_contains "$(cat "${fixture}/destination/UPSTREAM.md")" "$commit"
  assert_contains "$(cat "${fixture}/destination/UPSTREAM.md")" '9.9.9'
  run_sync "$fixture" --check
}

test_check_detects_drift() {
  local fixture="${test_root}/drift"
  local output
  mkdir -p "$fixture"
  create_fixture "$fixture"
  run_sync "$fixture" --write
  printf 'drift\n' >>"${fixture}/destination/content.txt"
  set +e
  output="$(run_sync "$fixture" --check 2>&1)"
  local status=$?
  set -e
  [[ $status -ne 0 ]] || fail "drifted destination should fail"
  assert_contains "$output" "存在漂移"
}

test_patch_conflict_preserves_destination() {
  local fixture="${test_root}/conflict"
  local output
  mkdir -p "$fixture/destination"
  create_fixture "$fixture"
  printf 'sentinel\n' >"${fixture}/destination/sentinel.txt"
  cat >"${fixture}/local.patch" <<'EOF'
diff --git a/content.txt b/content.txt
--- a/content.txt
+++ b/content.txt
@@ -1 +1 @@
-not-the-upstream-content
+custom
EOF
  set +e
  output="$(run_sync "$fixture" --write 2>&1)"
  local status=$?
  set -e
  [[ $status -ne 0 ]] || fail "conflicting patch should fail"
  assert_contains "$output" "本地定制补丁无法应用"
  [[ "$(cat "${fixture}/destination/sentinel.txt")" == "sentinel" ]] || fail "destination changed after patch conflict"
  [[ ! -e "${fixture}/destination/content.txt" ]] || fail "partial destination was written after patch conflict"
}

test_write_applies_patch_inside_git_worktree() {
  local fixture="${test_root}/in-repo"
  mkdir -p "$fixture"
  create_fixture "$fixture"
  DASHI_PPT_UPSTREAM_ROOT="${fixture}/upstream" \
  DASHI_PPT_DESTINATION="${repo_fixture}/destination" \
  DASHI_PPT_PATCH="${fixture}/local.patch" \
    "$sync_script" --write
  [[ "$(cat "${repo_fixture}/destination/content.txt")" == "custom" ]] || fail "patch was not applied inside git worktree"
}

test_no_runtime_directory_copied() {
  local fixture="${test_root}/runtime-filter"
  mkdir -p "$fixture"
  create_fixture "$fixture"
  mkdir -p "${fixture}/upstream/skills/dashi-ppt/node_modules"
  touch "${fixture}/upstream/skills/dashi-ppt/node_modules/junk.txt"
  mkdir -p "${fixture}/upstream/skills/dashi-ppt/.playwright-browsers"
  touch "${fixture}/upstream/skills/dashi-ppt/.playwright-browsers/junk.txt"
  mkdir -p "${fixture}/upstream/skills/dashi-ppt/output"
  touch "${fixture}/upstream/skills/dashi-ppt/output/junk.txt"
  run_sync "$fixture" --write
  [[ ! -d "${fixture}/destination/node_modules" ]] || fail "node_modules should not be copied"
  [[ ! -d "${fixture}/destination/.playwright-browsers" ]] || fail ".playwright-browsers should not be copied"
  [[ ! -d "${fixture}/destination/output" ]] || fail "output should not be copied"
}

test_missing_upstream_fails
test_write_and_check_are_reproducible
test_check_detects_drift
test_patch_conflict_preserves_destination
test_write_applies_patch_inside_git_worktree
test_no_runtime_directory_copied
printf 'PASS: dashi-ppt sync tests\n'
