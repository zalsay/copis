# Playwright Workflow Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `luna-worker` to implement this plan with TDD. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Browser Workflow raw-CDP step runner with generated Playwright scripts that attach to the running Copis Electron browser and reuse its `persist:copis-web` login state.

**Architecture:** Electron enables an ephemeral local CDP endpoint before `app.whenReady()`, discovers it from `DevToolsActivePort`, and keeps the endpoint internal to the main process. A new required `playwright-core` functional module supplies the driver through its activated COS artifact; each validated workflow write produces an ESM script, and the run orchestration executes the exact script in the bundled Node runtime against the workflow-owned tab selected by CDP target ID.

**Tech Stack:** Electron 43, TypeScript, Bun test, Node 24 functional module, `playwright-core@1.62.1`, existing functional-module manifest/COS publisher, Electron `WebContentsView`.

## Global Constraints

- Work directly on `main`; preserve all unrelated dirty changes and do not create a branch or commit.
- Do not modify `README.md` or `AGENTS.md` without a separate user authorization.
- Use Chinese comments and logs; add no browser binary because Playwright attaches to Copis Electron.
- `playwright-core` is a required functional module and is displayed as `浏览器自动化内核` in all module download/update progress.
- Use test-first red/green cycles for behavior changes. Keep existing Workflow approval semantics for execution, but generate scripts automatically for both draft and persisted versions.
- Generated scripts must not embed cookies, credentials, CDP endpoints, or supplied variable values.

---

### Task 1: Package and distribute the Playwright driver module

**Files:**
- Modify: `apps/electron/package.json`, `package.json`, `bun.lock`
- Modify: `apps/electron/scripts/sync-runtime-deps.ts`
- Create: `scripts/build-playwright-core-module.ts`
- Modify: `scripts/build-functional-module-manifest.ts`, `scripts/publish-functional-modules.ts`, `scripts/functional-module-version-lock.ts`, `scripts/functional-module-versions.json`
- Modify: `deploy.sh`, `deploy.ps1`
- Test: `apps/electron/scripts/sync-runtime-deps.test.ts`, `scripts/build-playwright-core-module.test.ts`, `scripts/functional-module-publisher.test.ts`

**Interfaces:**
- Produces a `tar.gz` whose entrypoint is `node_modules/playwright-core/index.js` and contains `playwright-core@1.62.1` plus its resolved runtime dependency closure.
- Adds `--playwright-core`, `--playwright-core-archive`, and `--playwright-core-version` to the manifest/publisher/deploy paths.

- [ ] **Step 1: Write failing archive and manifest tests**

```ts
test('Playwright module archive contains the driver entrypoint and closure', async () => {
  const archive = await buildPlaywrightCoreModule({ output })
  expect(listTarGzEntries(archive)).toContain('node_modules/playwright-core/index.js')
})

test('publisher emits a platform Playwright artifact', () => {
  expect(manifest.platforms['darwin-arm64'].modules['playwright-core']).toMatchObject({
    format: 'tar.gz', entrypoint: 'node_modules/playwright-core/index.js', required: true,
  })
})
```

- [ ] **Step 2: Run the focused tests and verify they fail because the module builder and CLI support do not exist**

Run: `bun test scripts/build-playwright-core-module.test.ts scripts/functional-module-publisher.test.ts`

- [ ] **Step 3: Add the exact dependency and archive builder**

```ts
await buildPlaywrightCoreModule({
  output,
  externalRuntimePackages: ['playwright-core'],
  entrypoint: 'node_modules/playwright-core/index.js',
})
```

Use the existing closure copier to stage `node_modules`, then archive it. Add the module to the release command arguments and merge checks without adding Chromium downloads.

- [ ] **Step 4: Run focused module tests and inspect the archive content**

Run: `bun test scripts/build-playwright-core-module.test.ts scripts/functional-module-publisher.test.ts apps/electron/scripts/sync-runtime-deps.test.ts`

- [ ] **Step 5: Keep deployment scripts symmetric**

Update the macOS/Linux shell and Windows PowerShell command parsing, single-module guards, defaults, release argument generation, and final manifest assertions for `playwright-core`.

### Task 2: Activate the required module and expose friendly startup progress

**Files:**
- Modify: `apps/electron/src/main/lib/functional-module-manager.ts`
- Modify: `apps/electron/src/main/lib/functional-module-startup.ts`
- Create: `apps/electron/src/main/lib/playwright-core-runtime.ts`
- Test: `apps/electron/src/main/lib/functional-module-manager.test.ts`, `apps/electron/src/main/lib/functional-module-startup.test.ts`, `apps/electron/src/main/lib/playwright-core-runtime.test.ts`

**Interfaces:**
- Produces `resolvePlaywrightCoreEntrypoint(): string`, which resolves the activated artifact in packaged mode and the repository dependency in development mode.
- `playwright-core` is required and has display name `浏览器自动化内核`.

- [ ] **Step 1: Write failing module requirement and runtime-resolution tests**

```ts
test('startup requires 浏览器自动化内核 from the manifest', () => {
  expect(() => assertRequiredModuleArtifacts(withoutPlaywright)).toThrow('浏览器自动化内核')
})

test('packaged mode resolves the activated Playwright entrypoint', () => {
  expect(resolvePlaywrightCoreEntrypoint()).toBe(activeEntrypoint)
})
```

- [ ] **Step 2: Run the focused tests and confirm the missing-module failure**

Run: `bun test apps/electron/src/main/lib/functional-module-manager.test.ts apps/electron/src/main/lib/functional-module-startup.test.ts apps/electron/src/main/lib/playwright-core-runtime.test.ts`

- [ ] **Step 3: Add the module definition, required startup validation, and loader**

The loader must use `createRequire()` from the activated module entrypoint in packaged mode, and only resolve the repo package in development mode. Do not let renderer IPC, Agent tools, or workflow scripts discover the module installation path.

- [ ] **Step 4: Re-run the focused tests**

Run: `bun test apps/electron/src/main/lib/functional-module-manager.test.ts apps/electron/src/main/lib/functional-module-startup.test.ts apps/electron/src/main/lib/playwright-core-runtime.test.ts`

### Task 3: Enable and discover the internal Electron CDP endpoint

**Files:**
- Create: `apps/electron/src/main/lib/playwright-cdp-endpoint.ts`
- Modify: `apps/electron/src/main/index.ts`
- Modify: `apps/electron/src/main/lib/web-tab-manager.ts`
- Test: `apps/electron/src/main/lib/playwright-cdp-endpoint.test.ts`, `apps/electron/src/main/lib/web-tab-manager.test.ts`

**Interfaces:**
- Produces `configurePlaywrightCdpEndpoint(app): void` before `app.whenReady()` and `getPlaywrightCdpEndpoint(): Promise<string>` after Chromium writes `DevToolsActivePort`.
- Produces `getWebTabCdpTargetId(tabId): Promise<string>` for the Playwright runner to select only the Workflow-owned target.

- [ ] **Step 1: Write failing endpoint-discovery and target-resolution tests**

```ts
test('configures Chromium with port zero before ready and reads DevToolsActivePort', async () => {
  configurePlaywrightCdpEndpoint(app)
  expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('remote-debugging-port', '0')
  expect(await getPlaywrightCdpEndpoint()).toBe('http://127.0.0.1:43123')
})

test('returns the CDP target id belonging to the requested WebContentsView', async () => {
  expect(await getWebTabCdpTargetId('workflow-tab')).toBe('target-1')
})
```

- [ ] **Step 2: Run focused tests and verify the new public contracts fail**

Run: `bun test apps/electron/src/main/lib/playwright-cdp-endpoint.test.ts apps/electron/src/main/lib/web-tab-manager.test.ts`

- [ ] **Step 3: Implement a main-process-only endpoint lifecycle**

Use `--remote-debugging-port=0` before Electron becomes ready, read and validate the port from the app user-data `DevToolsActivePort` file, and retry until a bounded timeout. Never expose the URL through IPC, logs, script files, or Agent tools. Get each WebContents target ID using its already-attached debugger session.

- [ ] **Step 4: Re-run endpoint and tab-manager tests**

Run: `bun test apps/electron/src/main/lib/playwright-cdp-endpoint.test.ts apps/electron/src/main/lib/web-tab-manager.test.ts`

### Task 4: Generate scripts on Workflow writes and replace raw CDP execution

**Files:**
- Create: `apps/electron/src/main/lib/browser-workflow-playwright-script.ts`
- Modify: `apps/electron/src/main/lib/browser-workflow-store.ts`, `apps/electron/src/main/lib/browser-workflow-service.ts`, `apps/electron/src/main/lib/browser-workflow-runner.ts`
- Test: `apps/electron/src/main/lib/browser-workflow-store.test.ts`, `apps/electron/src/main/lib/browser-workflow-service.test.ts`, `apps/electron/src/main/lib/browser-workflow-runner.test.ts`, `apps/electron/scripts/browser-workflow-e2e-main.ts`

**Interfaces:**
- Produces `writeBrowserWorkflowPlaywrightDraft(workspace, version): string` at `playwright/draft.mjs` and `writeBrowserWorkflowPlaywrightVersion(workspace, version): string` at `playwright/v{version}.mjs`.
- Generated module receives only ephemeral `COPIS_PLAYWRIGHT_CDP_ENDPOINT`, `COPIS_PLAYWRIGHT_TARGET_ID`, `COPIS_PLAYWRIGHT_CORE_ENTRY`, run artifact directory, and validated variable JSON from the main process.

- [ ] **Step 1: Write failing generation and runner tests**

```ts
test('submitting a valid draft writes a Playwright draft script without secrets', async () => {
  await submitBrowserWorkflowDraft(sessionId, version)
  expect(readFileSync(draftScript, 'utf8')).toContain('connectOverCDP')
  expect(readFileSync(draftScript, 'utf8')).not.toContain('session=')
})

test('running a workflow uses the shared Copis web partition and the generated script', async () => {
  await runBrowserWorkflow(input)
  expect(createWorkflowWebTab).toHaveBeenCalledWith(expect.objectContaining({ partition: 'persist:copis-web' }))
  expect(runGeneratedScript).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'target-1' }))
})
```

- [ ] **Step 2: Run the focused tests and verify the expected failures**

Run: `bun test apps/electron/src/main/lib/browser-workflow-store.test.ts apps/electron/src/main/lib/browser-workflow-service.test.ts apps/electron/src/main/lib/browser-workflow-runner.test.ts`

- [ ] **Step 3: Implement deterministic Playwright compilation and execution**

Compile all schema-supported steps into Playwright locators/actions with per-step Origin validation, timeout/error attribution, manual-step pausing, popup/tab tracking, variable resolution, and artifact capture. Keep the current run events, run summary, unattended gate, and failure-to-Browser-Agent handoff. Generate the draft artifact on accepted draft submission and immutable version artifact alongside each persisted Workflow version. The executor must spawn the activated Node runtime with the exact generated script, not execute arbitrary workspace files.

- [ ] **Step 4: Re-run Workflow unit tests and the real Electron replay**

Run: `bun test apps/electron/src/main/lib/browser-workflow-store.test.ts apps/electron/src/main/lib/browser-workflow-service.test.ts apps/electron/src/main/lib/browser-workflow-runner.test.ts`

Run: `bun run --filter='@copis/electron' test:browser-workflow:e2e`

- [ ] **Step 5: Add the cookie-reuse regression case**

In the Electron fixture, set a cookie in a normal `persist:copis-web` tab, then assert the Playwright Workflow-owned tab can read it while the generated script remains free of that cookie value.

### Task 5: Final integration verification

**Files:**
- Modify only files necessary to resolve integration failures from Tasks 1-4.

- [ ] **Step 1: Run all relevant module, workflow, and prompt tests**

Run: `bun test apps/electron/src/main/lib/functional-module-manager.test.ts apps/electron/src/main/lib/functional-module-startup.test.ts apps/electron/src/main/lib/playwright-core-runtime.test.ts apps/electron/src/main/lib/playwright-cdp-endpoint.test.ts apps/electron/src/main/lib/browser-workflow-store.test.ts apps/electron/src/main/lib/browser-workflow-service.test.ts apps/electron/src/main/lib/browser-workflow-runner.test.ts apps/electron/src/main/lib/agent-prompt-builder.test.ts`

- [ ] **Step 2: Build and typecheck**

Run: `bun run typecheck`

Run: `bun run --filter='@copis/electron' build:main`

- [ ] **Step 3: Review the change scope**

Run: `git diff --check`

Inspect the diff to ensure no credentials, CDP endpoint, cookie, workflow variable value, generated browser binary, README, or AGENTS changes were introduced.
