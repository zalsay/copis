# Copis 全面重命名 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Proma 的第一方产品标识全面迁移为 Copis，同时迁移并兼容已有本地配置、脚本和历史会话数据。

**Architecture:** 以 `@copis/*` 作为新的 workspace 包边界，以 `COPIS_*` 和 `~/.copis*` 作为新的运行时契约。Electron 主进程负责配置目录迁移，CLI 独立实现同一套无 Electron 路径规则；旧名称只保留在显式兼容解析和迁移常量中。

**Tech Stack:** Bun workspace、TypeScript、Electron、esbuild、Vite、Electron Builder、Bun test。

---

### Task 1: 建立命名与路径迁移测试

**Files:**
- Modify: `apps/electron/src/main/lib/config-paths.ts`
- Create: `apps/electron/src/main/lib/config-paths.test.ts`
- Modify: `apps/cli/src/paths.ts`
- Create: `apps/cli/src/paths.test.ts`

- [ ] **Step 1: Write failing tests for canonical paths and migration**

测试覆盖以下行为：`COPIS_DEV=1` 解析为 `~/.copis-dev`；只有 `~/.proma-dev` 时迁移到新目录；`PROMA_DEV=1` 只作为兼容输入但仍解析新目录；新旧目录同时存在时新目录优先；CLI 的 `configDir` 不受环境变量覆盖。

- [ ] **Step 2: Run the focused tests and verify the expected failure**

Run: `bun test apps/electron/src/main/lib/config-paths.test.ts apps/cli/src/paths.test.ts`

Expected: FAIL because the current path helpers still return legacy `.proma*` paths for the old environment variable and do not migrate directories.

- [ ] **Step 3: Implement one idempotent migration helper per runtime boundary**

Electron path resolution must map `COPIS_DEV` first, then `PROMA_DEV`, then `app.isPackaged`; before creating the target directory, move the matching legacy directory when the target is absent. CLI keeps explicit `configDir` first and applies the same canonical mapping without importing Electron.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `bun test apps/electron/src/main/lib/config-paths.test.ts apps/cli/src/paths.test.ts`

Expected: PASS, including the no-overwrite case.

### Task 2: Rename workspace packages and TypeScript contracts

**Files:**
- Modify: `package.json`, `bun.lock`
- Modify: `packages/shared/package.json`, `packages/core/package.json`, `packages/session-core/package.json`, `packages/ui/package.json`
- Modify: `apps/cli/package.json`, `apps/electron/package.json`
- Modify: all tracked TypeScript source/test files importing `@proma/*`

- [ ] **Step 1: Add contract assertions for the new package names**

Use package manifest checks in the existing Bun test style to assert each workspace package name starts with `@copis/`, the CLI bin is `copis`, and no root script filters `@proma/electron`.

- [ ] **Step 2: Run the assertions before the rename**

Run: `bun test apps/cli/src/paths.test.ts`

Expected: FAIL on the legacy package and CLI names.

- [ ] **Step 3: Apply the mechanical package and import rename**

Replace first-party package references only: `@proma/` -> `@copis/`, `PromaPermissionMode` -> `CopisPermissionMode`, `isPromaPermissionMode` -> `isCopisPermissionMode`, `PROMA_DEFAULT_PERMISSION_MODE` -> `COPIS_DEFAULT_PERMISSION_MODE`, and related first-party helper names. Keep third-party protocol strings and explicit legacy parser aliases unchanged until Task 4.

- [ ] **Step 4: Update package versions and regenerate the lockfile**

Increment patch versions in every changed workspace manifest, then run `bun install --lockfile-only` so workspace snapshots and package dependency keys match the new scope.

- [ ] **Step 5: Run typecheck and package assertions**

Run: `bun run typecheck && bun test apps/cli/src/paths.test.ts`

Expected: PASS with no unresolved `@proma/*` imports in source.

### Task 3: Rename CLI, Electron resources, and build/runtime identifiers

**Files:**
- Modify: `apps/cli/src/index.ts`, `apps/cli/src/commands/*.ts`, `apps/cli/src/registry.ts`, `apps/cli/src/sessions.ts`
- Modify: `apps/electron/scripts/build-cli.ts`, `apps/electron/scripts/dev-split.sh`, `apps/electron/scripts/dist.ts`, `apps/electron/scripts/download-bun.ts`
- Modify: `apps/electron/electron-builder.yml`, `apps/electron/src/main/tray.ts`, `apps/electron/src/main/ipc.ts`
- Rename: `apps/electron/resources/proma-logos/` -> `apps/electron/resources/copis-logos/`

- [ ] **Step 1: Add CLI name and resource path assertions**

Assert the CLI manifest exposes `copis`, the build script emits `dist/copis`, the builder and tray resolve `copis-logos`, and the generated variant path is `copis-{variant}.png`.

- [ ] **Step 2: Run the assertions and confirm they fail**

Run: `bun test apps/cli/src/paths.test.ts`

Expected: FAIL on the old bin/output/resource names.

- [ ] **Step 3: Rename the CLI and resource paths**

Change user-facing help and generated output to `copis`; rename the resource directory and `proma-*` asset filenames to `copis-*`; update tray lookup, icon generation, Electron Builder extraResources, and the brand-logo IPC path.

- [ ] **Step 4: Keep externally bound URLs stable while renaming local identifiers**

Rename local constants such as `PROMA_API_BASE` to `COPIS_API_BASE` only when the string points to an internal name. Do not change a deployed API URL or third-party protocol endpoint without a separately verified server contract.

- [ ] **Step 5: Run build checks**

Run: `bun run --filter='@copis/electron' build:main && bun run --filter='@copis/electron' build:preload && bun run --filter='@copis/electron' build:renderer`

Expected: all three commands complete successfully and the generated bundles contain no unresolved `@proma/*` imports.

### Task 4: Add historical compatibility for runtime events and child-process environment

**Files:**
- Modify: `packages/session-core/src/group.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`, `apps/electron/src/main/lib/agent-prompt-builder.ts`, `apps/electron/src/main/lib/agent-runtime-env.ts`
- Modify: `packages/shared/src/types/*` files defining first-party event and permission contracts
- Test: adjacent existing session, agent runtime, and prompt-builder tests

- [ ] **Step 1: Write failing compatibility tests**

Add tests proving old scheduled-run markers and old event kind payloads are accepted during read/normalization, while newly generated prompts and environment maps use `COPIS_*` names.

- [ ] **Step 2: Run the tests to verify the failure**

Run: `bun test packages/session-core apps/electron/src/main/lib/agent-runtime-env.test.ts apps/electron/src/main/lib/agent-prompt-builder.test.ts`

Expected: FAIL where the new canonical names and legacy aliases are not yet recognized.

- [ ] **Step 3: Implement canonical writes with legacy reads**

Write `<!--COPIS_SCHEDULED_RUN-->`, `copis_event`, and `COPIS_*`; normalize old `<!--PROMA_SCHEDULED_RUN-->`, `proma_event`, and `PROMA_*` values at read boundaries. When launching child processes, expose both canonical and legacy aliases with identical values during the transition.

- [ ] **Step 4: Run focused compatibility tests**

Run: `bun test packages/session-core apps/electron/src/main/lib/agent-runtime-env.test.ts apps/electron/src/main/lib/agent-prompt-builder.test.ts`

Expected: PASS.

### Task 5: Update product text, documentation, default Skills, and migration notes

**Files:**
- Modify: `README.md`, `README.en.md`, `AGENTS.md`, `COPIS-客户端方案.md`, `.gitignore`
- Modify: tracked source comments and user-facing text containing the first-party Proma brand
- Rename: `apps/electron/default-skills/proma-coach/` -> `apps/electron/default-skills/copis-coach/`
- Modify: default Skill references and upgrade mapping for the legacy `proma-coach` slug

- [ ] **Step 1: Add a repository scan check**

Use `git grep -n -i 'proma'` as the check, with an allowlist limited to migration aliases, legacy file-format descriptions, and external URLs that remain service contracts.

- [ ] **Step 2: Replace product-facing names and update the default Skill slug**

Change visible brand text, comments, docs, tutorial content, script labels, and first-party paths to Copis; keep explicit Chinese migration text that tells users which old `.proma` files are still supported.

- [ ] **Step 3: Run the repository scan and review every allowlisted occurrence**

Run: `git grep -n -i 'proma'`

Expected: only intentional compatibility aliases, legacy import/file-format notes, or verified external service identifiers remain.

### Task 6: Full verification and diff review

**Files:**
- Test: all existing test files affected by the rename

- [ ] **Step 1: Run the full test suite**

Run: `bun test`

Expected: PASS; if a legacy-path test relies on a fixed `PROMA_DEV` fixture, update the fixture to use the canonical `COPIS_DEV` path while preserving a separate compatibility case.

- [ ] **Step 2: Run workspace typecheck**

Run: `bun run typecheck`

Expected: PASS for every workspace package.

- [ ] **Step 3: Run Electron build and diff checks**

Run: `bun run --filter='@copis/electron' build:main && bun run --filter='@copis/electron' build:preload && bun run --filter='@copis/electron' build:renderer && git diff --check`

Expected: all commands pass.

- [ ] **Step 4: Inspect the final diff without touching unrelated work**

Run: `git status --short && git diff --stat && git diff --name-only`

Confirm that all existing user changes remain present, only intended rename/migration files are added to the task diff, and no generated bundles, secrets, or unrelated formatting churn are included.
