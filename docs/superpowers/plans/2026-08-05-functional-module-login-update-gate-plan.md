# Copis 登录后功能模块更新 Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 登录成功后自动检查并更新必选的 OfficeCLI 与 Rust HTTP API，显示 Copis 主题更新页面，只有模块阶段完成到 95% 且正式 Rust API health 通过后才进入主界面。

**Architecture:** Electron 主进程新增单例启动编排器，复用现有功能模块存储、下载和 Rust 候选版本切换逻辑；它通过独立的聚合进度 IPC 向 Renderer 推送 0-100% 状态。`App.tsx` 在登录态之后、onboarding 和 AppShell 之前挂载全屏 Gate，Gate 使用 Jotai 和现有主题 token 展示状态，完成后再放行主界面。

**Tech Stack:** Bun test、TypeScript、Electron IPC/preload、React、Jotai、Tailwind CSS、Lucide、现有 functional-module-store/manager/http-api-server。

---

### Task 1: Extend the shared functional-module contract

**Files:**
- Modify: `packages/shared/src/types/functional-module.ts`
- Test: `apps/electron/src/main/lib/functional-module-startup.test.ts`
- Modify: `packages/shared/package.json` (patch version)

- [ ] **Step 1: Write the failing contract test**

Add a test fixture that imports the shared types and asserts the new startup IPC names and phases are present through the Electron-side startup test. The expected contract is:

```ts
const progress: FunctionalModuleStartupProgressPayload = {
  phase: 'health',
  detail: '正在检查本地 API',
  progress: 0.97,
  activeModule: 'rust-http-api',
}

expect(FUNCTIONAL_MODULE_IPC_CHANNELS.STARTUP_PROGRESS).toBe('functional-module:startup-progress')
expect(FUNCTIONAL_MODULE_IPC_CHANNELS.ENSURE_REQUIRED).toBe('functional-module:ensure-required')
expect(progress.phase).toBe('health')
```

Also assert `FunctionalModuleStartupProgressPayload.progress` accepts a number and optional `activeModule`, `downloadedBytes`, `totalBytes`, and `error`.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
bun test apps/electron/src/main/lib/functional-module-startup.test.ts
```

Expected: FAIL because the startup payload type and IPC constants do not exist.

- [ ] **Step 3: Implement the minimal shared contract**

In `packages/shared/src/types/functional-module.ts`, add:

```ts
export type FunctionalModuleStartupProgressPhase =
  | 'checking'
  | 'modules'
  | 'health'
  | 'ready'
  | 'error'

export interface FunctionalModuleStartupProgressPayload {
  phase: FunctionalModuleStartupProgressPhase
  detail: string
  progress: number
  activeModule?: FunctionalModuleName
  downloadedBytes?: number
  totalBytes?: number
  error?: string
}
```

Extend `FUNCTIONAL_MODULE_IPC_CHANNELS` with `ENSURE_REQUIRED: 'functional-module:ensure-required'` and `STARTUP_PROGRESS: 'functional-module:startup-progress'`. Keep `FunctionalModuleProgressPayload` unchanged because settings UI depends on its per-module progress semantics.

- [ ] **Step 4: Mark the shared package patch release and run the test**

Increment the current `packages/shared/package.json` patch version, then run:

```bash
bun test apps/electron/src/main/lib/functional-module-startup.test.ts
```

Expected: PASS for the contract assertions.

### Task 2: Build the main-process startup orchestrator and health contract

**Files:**
- Create: `apps/electron/src/main/lib/functional-module-startup.ts`
- Test: `apps/electron/src/main/lib/functional-module-startup.test.ts`
- Modify: `apps/electron/src/main/lib/http-api-server.ts`
- Test: `apps/electron/src/main/lib/http-api-server-runtime.test.ts`

- [ ] **Step 1: Add failing pure progress tests**

Test exported pure helpers before implementing the orchestrator:

```ts
test('模块阶段最多推进到 95%，health 阶段占最后 5%', () => {
  expect(mapModuleProgress(0, 0, 0.5)).toBe(0.05)
  expect(mapModuleProgress(0.5, 0, 0.5)).toBeCloseTo(0.275)
  expect(mapModuleProgress(1, 0.5, 0.5)).toBe(0.95)
  expect(mapHealthProgress(0)).toBe(0.95)
  expect(mapHealthProgress(0.8)).toBe(0.99)
  expect(mapHealthProgress(1)).toBe(1)
})

test('错误消息不泄露 COS secret 或内部 token', () => {
  expect(toStartupError(new Error('COS_SECRET_KEY=secret /internal token')))
    .not.toContain('secret')
})
```

Add a health fixture test for a 200 response with the wrong service identity; it must return false. Add a success fixture for `{ ok: true, service: 'copis-http-api' }`.

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test apps/electron/src/main/lib/functional-module-startup.test.ts
```

Expected: FAIL because the helpers and startup service are not present.

- [ ] **Step 3: Add strict Rust health polling**

In `http-api-server.ts`, export a testable `waitForHttpApiHealth(options)` wrapper around the existing 100ms polling. Parse the JSON response and require HTTP 2xx, `ok === true`, and `service === 'copis-http-api'`. Preserve the existing 5-second timeout and `fetchImpl` injection. Replace candidate and formal calls to the private health function with this strict version, while retaining candidate cleanup and old-version rollback.

Add runtime tests for:

- candidate health success and formal health success;
- a 200 response from another service being rejected;
- formal health failure restoring the previous active module and process.

- [ ] **Step 4: Implement the single-flight startup orchestrator**

Create `ensureRequiredFunctionalModules(options)` with an injected `rootDir`, manifest options, fetch implementation, and `onProgress` callback. Use a module-level `Map<string, Promise<FunctionalModuleStatus[]>>` keyed by root directory. The implementation must:

1. Emit `checking` at `0.02` and resolve the manifest once.
2. Require both `officecli` and `rust-http-api` artifacts and reject a manifest that marks either as optional or omits either module.
3. Read current statuses and process `officecli` first.
4. For each module, call `checkFunctionalModule`; call `installFunctionalModule` only when missing or `updateAvailable`.
5. Forward per-module progress through the existing callback and map it into the aggregate `0.05-0.95` interval using manifest `size` weights.
6. Use `updateHttpApiServer` when Rust needs activation/update; otherwise call `startHttpApiServer` and then strict formal health.
7. Emit `health` from `0.95` through `0.99` while polling, then resync the persisted Working token and emit `ready` at `1`.
8. On any failure, emit `error` with a concise Chinese message and rethrow after preserving old active state.

Export `StartupFunctionalModuleOptions` and `mapModuleProgress(progress, normalizedStart, normalizedWeight)`, `mapHealthProgress`, and `toStartupError` so the tests cover the boundary without mocking the entire service. `mapModuleProgress` must calculate `0.05 + 0.9 * (normalizedStart + normalizedWeight * clamp(progress, 0, 1))`.

- [ ] **Step 5: Run the focused main-process tests**

Run:

```bash
bun test apps/electron/src/main/lib/functional-module-startup.test.ts
bun test apps/electron/src/main/lib/http-api-server-runtime.test.ts
```

Expected: all startup progress, required-module, health identity, single-flight, and rollback tests pass.

### Task 3: Connect the main process and preload, and stop background update races

**Files:**
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/preload/index.ts`
- Modify: `apps/electron/src/main/index.ts`
- Test: `apps/electron/src/main/lib/functional-module-startup.test.ts`

- [ ] **Step 1: Add failing IPC boundary assertions**

Extend the startup test or an IPC-focused test to assert that the main handler validates no input, returns `FunctionalModuleStatus[]`, forwards startup progress, and does not expose arbitrary paths or manifest URLs from Renderer.

- [ ] **Step 2: Register the new IPC handler and preload bridge**

In `ipc.ts`, register `FUNCTIONAL_MODULE_IPC_CHANNELS.ENSURE_REQUIRED`. Use `BrowserWindow.fromWebContents(event.sender)` and send startup payloads only while the window is alive. In `preload/index.ts`, add:

```ts
ensureRequiredFunctionalModules: () => Promise<FunctionalModuleStatus[]>
onFunctionalModuleStartupProgress: (
  callback: (payload: FunctionalModuleStartupProgressPayload) => void,
) => () => void
```

Use the same listener cleanup pattern as `onFunctionalModuleProgress`.

- [ ] **Step 3: Remove the background Rust update from app bootstrap**

In `ensureHttpApiServer`, keep starting a resolved active/resource binary, but remove the fire-and-forget `updateHttpApiServer` call. The login Gate becomes the sole automatic update path. Keep shutdown and existing development overrides intact.

- [ ] **Step 4: Verify the IPC/preload build boundary**

Run:

```bash
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:preload
```

Expected: both builds pass with the new shared types and no missing preload methods.

### Task 4: Implement the Jotai state and Copis-themed login update Gate

**Files:**
- Create: `apps/electron/src/renderer/components/functional-modules/FunctionalModuleUpdateGate.tsx`
- Create: `apps/electron/src/renderer/components/functional-modules/functional-module-startup-ui.ts`
- Create: `apps/electron/src/renderer/components/functional-modules/functional-module-startup-ui.test.ts`
- Modify: `apps/electron/src/renderer/atoms/functional-modules.ts`
- Modify: `apps/electron/src/renderer/App.tsx`

- [ ] **Step 1: Write failing UI model tests**

Cover the pure UI model before the component:

```ts
test('health 阶段显示最后 5% 的 API 检查文案', () => {
  expect(getStartupPhaseLabel({ phase: 'health', progress: 0.97 })).toBe('正在检查本地 API')
})

test('模块状态顺序固定为 Rust API 和 OfficeCLI', () => {
  expect(getStartupModuleRows().map((row) => row.name))
    .toEqual(['rust-http-api', 'officecli'])
})

test('失败状态只能重试，不能生成继续进入操作', () => {
  expect(getStartupActions('error')).toEqual(['retry'])
})
```

- [ ] **Step 2: Run the UI model test to verify it fails**

Run:

```bash
bun test apps/electron/src/renderer/components/functional-modules/functional-module-startup-ui.test.ts
```

Expected: FAIL because the model and Gate do not exist.

- [ ] **Step 3: Add Jotai startup state and pure UI helpers**

Add `functionalModuleStartupAtom` with `checking`, `updating`, `health`, `ready`, and `error` state, plus aggregate progress, detail, active module, byte counts, and error. Keep existing per-module atoms unchanged. Implement helpers for phase labels, module row status, byte formatting, and the single retry action.

- [ ] **Step 4: Implement the Gate component**

The Gate must:

- subscribe to `onFunctionalModuleStartupProgress` on mount and unsubscribe on cleanup;
- call `ensureRequiredFunctionalModules()` once per authenticated mount;
- write final statuses into `functionalModuleStatusesAtom`;
- show stable `role="progressbar"` attributes with `aria-valuenow` from clamped 0-100 values;
- render Copis logo, phase/detail, percentage, byte detail, Rust API row, OfficeCLI row, and error retry;
- use `bg-background`, `bg-secondary`, `bg-primary`, `text-foreground`, `text-muted-foreground`, and `text-destructive` tokens;
- avoid a skip button and avoid mounting children until the startup state is `ready`;
- respect `prefers-reduced-motion` and keep text within its parent at narrow widths.

When state becomes `ready`, wait only for a short 200-300ms transition, then render `children`.

- [ ] **Step 5: Place the Gate after authentication**

In `App.tsx`, keep the existing loading and login branches first. After the authenticated branch, wrap the existing onboarding/main return in `FunctionalModuleUpdateGate`. This ensures onboarding and `AppShell` are not mounted before module readiness. Do not put the Gate around the login dialog, because login must remain available before the module check.

- [ ] **Step 6: Run the UI test and renderer build**

Run:

```bash
bun test apps/electron/src/renderer/components/functional-modules/functional-module-startup-ui.test.ts
bun run --filter='@copis/electron' build:renderer
```

Expected: all UI model tests pass and Vite builds the Gate.

### Task 5: Make OfficeCLI required everywhere and synchronize versions

**Files:**
- Modify: `apps/electron/src/main/lib/functional-module-manager.ts`
- Modify: `apps/electron/src/renderer/components/settings/functional-module-ui.ts`
- Modify: `scripts/build-functional-module-manifest.ts`
- Modify: `scripts/publish-functional-modules.ts`
- Modify: `apps/electron/package.json` (patch version)
- Test: `apps/electron/src/main/lib/functional-module-manager.test.ts`
- Test: `apps/electron/src/renderer/components/settings/functional-module-ui.test.ts`
- Test: `scripts/functional-module-publisher.test.ts`

- [ ] **Step 1: Add failing required-module assertions**

Assert that the main manager definitions, Renderer definitions, and generated/published manifest inputs all require OfficeCLI. Add a manifest test where OfficeCLI is `required: false` and assert the login startup orchestrator rejects it as incomplete.

- [ ] **Step 2: Change the required flags and test**

Change OfficeCLI to `required: true` in the main manager and Renderer settings definition. Change the default publisher/build input to `required: true`. Update test fixtures that intentionally describe a required OfficeCLI. Do not alter the COS object path or version naming scheme.

- [ ] **Step 3: Increment the Electron patch version**

Increment the current `apps/electron/package.json` patch version as required by `AGENTS.md`. Do not modify unrelated package versions or overwrite existing dirty edits.

- [ ] **Step 4: Run focused required-flag tests**

Run:

```bash
bun test apps/electron/src/main/lib/functional-module-manager.test.ts
bun test apps/electron/src/renderer/components/settings/functional-module-ui.test.ts
bun test scripts/functional-module-publisher.test.ts
```

Expected: all required-flag and existing module behavior tests pass.

### Task 6: Full verification and real Electron smoke test

**Files:**
- Review: all files changed by Tasks 1-5
- Review: `docs/superpowers/specs/2026-08-05-functional-module-login-update-gate-design.md`

- [ ] **Step 1: Run the combined focused test set**

Run:

```bash
bun test apps/electron/src/main/lib/functional-module-startup.test.ts
bun test apps/electron/src/main/lib/functional-module-manager.test.ts
bun test apps/electron/src/main/lib/functional-module-store.test.ts
bun test apps/electron/src/main/lib/http-api-server-runtime.test.ts
bun test apps/electron/src/renderer/components/functional-modules/functional-module-startup-ui.test.ts
bun test apps/electron/src/renderer/components/settings/functional-module-ui.test.ts
bun test scripts/functional-module-publisher.test.ts
```

Expected: zero failures.

- [ ] **Step 2: Run typecheck and all affected builds**

Run:

```bash
bun run typecheck
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:preload
bun run --filter='@copis/electron' build:renderer
```

Expected: zero TypeScript errors and successful main, preload, and renderer bundles.

- [ ] **Step 3: Inspect the diff and version/document boundaries**

Run:

```bash
git diff --check
git diff --stat
git status --short
```

Confirm no COS credentials, temporary binaries, generated dist output, unrelated user edits, or debug logs are included. Confirm the Electron package patch version and the shared package patch version match the changes.

- [ ] **Step 4: Run the real Electron smoke path**

Stop any existing Copis dev Electron/Rust process that owns the test ports, start the repository dev flow, and log in through the actual Electron window. Verify:

- the login page remains available before authentication;
- the update Gate appears immediately after authentication;
- missing/outdated modules show status and progress;
- module work never exceeds 95%;
- health text appears for the final 5%;
- a healthy `/api/health` response reaches 100% and then mounts onboarding/main UI;
- a forced health failure keeps the error page and retry action visible;
- light/dark themes and narrow window sizes keep text and progress controls contained.

Use the in-app browser or the repository's Electron test harness only for visible verification; do not treat a static browser DOM as proof of Rust process health.

- [ ] **Step 5: Summarize residual risk**

Report any verification that could not run, especially if COS is unreachable, a logged-in test account is unavailable, or an existing dirty process owns the port. Do not claim the feature is complete without the successful focused tests, builds, and a documented smoke result.
