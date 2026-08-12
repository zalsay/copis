# Rust Automation Pi Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Rust HTTP API the sole owner of Automation scheduling and Pi Worker execution so every Automation capability is issued, used, and revoked in one Rust process.

**Architecture:** Rust keeps the existing `~/.copis/automations.json` contract, runs a short polling scheduler, reserves each due Automation, asks Electron only to prepare the session-bound Pi configuration through the existing private business bridge, and then starts/finishes the Pi Worker locally. Electron remains responsible for encrypted channel credentials, Agent session JSONL/meta persistence, renderer event forwarding, and Feishu notification delivery; it no longer decides when or how a scheduled task executes.

**Tech Stack:** Rust standard library threads and mutexes, existing Rust HTTP API/PiWorkerManager, Electron TypeScript/Bun, existing private stdio bridge, Bun tests, Cargo tests.

## Global Constraints

- Keep `~/.copis/automations.json` at version 2 and preserve all existing task and run-history fields.
- Rust production modules must not embed `#[cfg(test)]`; use adjacent `*_test.rs` files.
- Do not pass global internal tokens or channel credentials into Pi Worker processes.
- Pi Automation tools retain their session capability boundary and must reject invalid, expired, revoked, or cross-process tokens.
- Electron UI remains a renderer concern; verification may not substitute screenshots for user confirmation.
- Update `AGENTS.md` and `README.md` to reflect the final behavior, as authorized by the user.
- Increment affected package/module patch versions before any requested commit.

---

### Task 1: Lock the Rust capability and endpoint-routing contract

**Files:**
- Modify: `native/http-api-server/src/automation.rs`
- Test: `native/http-api-server/src/automation_test.rs`
- Modify: `apps/electron/src/main/lib/agent-rpc-gateway.ts`
- Create: `apps/electron/src/main/lib/agent-rpc-gateway.test.ts`

**Interfaces:**
- Produces: `AutomationStore::due_automations(now)` and an atomic task reservation API used by the scheduler.
- Produces: shared development/production port resolution in `AgentRpcGateway`.

- [ ] **Step 1: Write failing Rust tests for task reservation and capability lifecycle**

```rust
#[test]
fn given_due_automation_when_reserved_then_only_one_runner_receives_it() {
    let store = AutomationStore::open(temp_dir());
    let automation = store.create(due_input()).unwrap();
    assert_eq!(store.reserve_due(&automation["id"].as_str().unwrap(), now()).unwrap(), true);
    assert_eq!(store.reserve_due(&automation["id"].as_str().unwrap(), now()).unwrap(), false);
}

#[test]
fn given_worker_capability_when_released_then_it_is_rejected() {
    let issued = issue_worker_capability("session-1", "user", "channel-1".into(), None, Some("workspace-1".into()), None);
    assert!(worker_automation_context("session-1", &issued.token).is_ok());
    revoke_worker_capability("session-1");
    assert!(worker_automation_context("session-1", &issued.token).is_err());
}
```

- [ ] **Step 2: Run the Rust test target and verify the reservation test fails because the API is absent**

Run: `cargo test --manifest-path native/http-api-server/Cargo.toml automation_test`

Expected: FAIL referring to missing `reserve_due` or the equivalent missing contract.

- [ ] **Step 3: Write a failing Gateway test for development routing**

```ts
test('Given no explicit base URL in development When AgentRpcGateway starts a run Then it targets the development Rust API port', async () => {
  const gateway = new AgentRpcGateway({ fetchImpl })
  await gateway.run(input, callbacks)
  expect(requests[0]?.url).toStartWith('http://127.0.0.1:51740/')
})
```

- [ ] **Step 4: Run the Gateway test and verify it fails against the old 51730 fallback**

Run: `bun test apps/electron/src/main/lib/agent-rpc-gateway.test.ts`

Expected: FAIL showing `51730` rather than the configured shared development port.

- [ ] **Step 5: Implement the smallest storage/reservation and shared-port changes**

```rust
pub fn reserve_due(&self, id: &str, now: u64) -> Result<bool, AutomationError> {
    // Under the store mutex, require active + runnable + nextRunAt <= now,
    // then persist an in-progress marker before returning true.
}
```

```ts
function resolveBaseUrl(value?: string): string {
  if (value?.trim()) return value.replace(/\/$/, '')
  return `http://${COPIS_HTTP_API_HOST}:${resolveCopisHttpApiPort({
    configuredPort: process.env.COPIS_HTTP_API_PORT,
    isPackaged: app.isPackaged === true,
  })}`
}
```

- [ ] **Step 6: Run the focused Rust and TypeScript tests and confirm both are green**

Run: `cargo test --manifest-path native/http-api-server/Cargo.toml automation_test && bun test apps/electron/src/main/lib/agent-rpc-gateway.test.ts`

Expected: PASS.

### Task 2: Add a Rust-owned Automation scheduler and headless Pi Worker run path

**Files:**
- Create: `native/http-api-server/src/automation_scheduler.rs`
- Create: `native/http-api-server/src/automation_scheduler_test.rs`
- Modify: `native/http-api-server/src/main.rs`
- Modify: `native/http-api-server/src/pi_rpc.rs`
- Modify: `native/http-api-server/src/automation.rs`

**Interfaces:**
- Consumes: `AutomationStore`, `PiWorkerManager`, and `Bridge`.
- Produces: `AutomationScheduler::start`, `AutomationScheduler::run_now`, `AutomationScheduler::stop`, and route `POST /api/automations/:id/run`.
- Produces: a common Rust Worker-frame processor usable by interactive SSE and scheduler runs.

- [ ] **Step 1: Write failing scheduler tests before implementation**

```rust
#[test]
fn given_due_runnable_task_when_ticked_then_scheduler_requests_a_prepared_pi_config_once() {
    let harness = SchedulerHarness::with_due_automation();
    harness.scheduler.tick_once();
    assert_eq!(harness.bridge.requests(), vec!["/api/internal/automation/prepare-run"]);
}

#[test]
fn given_manual_run_when_requested_then_scheduler_uses_the_same_rust_worker_path() {
    let harness = SchedulerHarness::with_runnable_automation();
    assert!(harness.scheduler.run_now("automation-1").unwrap());
    assert_eq!(harness.worker_starts(), 1);
}
```

- [ ] **Step 2: Run the scheduler tests and verify they fail because the module does not exist**

Run: `cargo test --manifest-path native/http-api-server/Cargo.toml automation_scheduler_test`

Expected: FAIL with missing module or missing scheduler types.

- [ ] **Step 3: Implement the scheduler with Rust-owned execution state**

```rust
pub struct AutomationScheduler {
    running: Mutex<HashSet<String>>,
    store: Arc<AutomationStore>,
    bridge: Arc<Bridge>,
    workers: Arc<PiWorkerManager>,
}

impl AutomationScheduler {
    pub fn tick_once(&self) { /* reserve, prepare over bridge, then start PiWorkerManager */ }
    pub fn run_now(&self, id: &str) -> Result<bool, AutomationError> { /* same execute path */ }
}
```

The scheduler must:

- reserve before bridge work and always release its reservation;
- skip a task that is active in `PiWorkerManager` or whose source session is active;
- invoke `/api/internal/automation/prepare-run` through the private bridge;
- call `PiWorkerManager::start` itself and process frames until completion;
- persist `AutomationRunInput`, advance `nextRunAt`, and apply existing max-runs/once/failure behavior through `AutomationStore`;
- call `/api/internal/automation/run-finished` only after persistence, without exposing capability tokens;
- restore overdue tasks on Rust startup by advancing only recurring jobs and allowing a missed `once` task to run once.

- [ ] **Step 4: Add the API route and create the scheduler at Rust startup**

```rust
("POST", ["api", "automations", id, "run"]) => scheduler.run_now(id)
    .map(|started| json!({ "started" : started }))
```

The startup path must retain an `Arc<AutomationScheduler>`, call `start()`, and stop its loop on Rust process shutdown. Do not start another Electron `setInterval`.

- [ ] **Step 5: Run Rust scheduler, automation, and Pi RPC tests**

Run: `cargo test --manifest-path native/http-api-server/Cargo.toml automation_scheduler_test automation_test pi_rpc_tests`

Expected: PASS.

### Task 3: Make Electron a preparation, persistence, event, and notification bridge only

**Files:**
- Modify: `apps/electron/src/main/lib/http-api-handler.ts`
- Modify: `apps/electron/src/main/lib/agent-rpc-service.ts`
- Modify: `apps/electron/src/main/lib/automation-api-client.ts`
- Create: `apps/electron/src/main/lib/automation-api-client.test.ts`
- Modify: `apps/electron/src/main/lib/automation-notification-service.ts`
- Modify: `apps/electron/src/main/lib/automation-scheduler.ts`
- Modify: `apps/electron/src/main/index.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts`

**Interfaces:**
- Consumes: Rust bridge calls `/api/internal/automation/prepare-run`, `/event`, and `/run-finished`.
- Produces: `prepareAutomationRpcRun(...)` which returns a Pi run config, and public `AutomationApiClient.runNow(id)`.

- [ ] **Step 1: Write failing client and bridge tests**

```ts
test('Given an immediate-run request When the client calls Rust Then it posts only to the task run endpoint', async () => {
  await client.runNow('automation-1')
  expect(request).toMatchObject({ method: 'POST', url: '.../api/automations/automation-1/run' })
})

test('Given a Rust scheduler prepare request When Electron handles it Then it returns Pi config without calling AgentRpcGateway', async () => {
  const response = await handleHttpApiRequest(prepareRequest)
  expect(response.status).toBe(200)
  expect(response.body).toHaveProperty('config.query.triggeredBy', 'automation')
})
```

- [ ] **Step 2: Run tests and verify the client lacks `runNow` and the bridge route is absent**

Run: `bun test apps/electron/src/main/lib/automation-api-client.test.ts apps/electron/src/main/lib/http-api-handler.test.ts`

Expected: FAIL on the unimplemented API/route behavior.

- [ ] **Step 3: Implement Electron bridge routes without reintroducing local scheduling**

`prepareAutomationRpcRun` may create or reuse an Agent session because metadata and encrypted credential resolution remain Electron-owned. It must return only `{ automationId, sessionId, config, createdSession }`; Rust writes `lastSessionId` and starts the Worker. It must mark all generated input `triggeredBy: 'automation'`, force `bypassPermissions`, and emit the normal external-run-started event to the desktop renderer.

`run-finished` must receive the persisted automation and run record, broadcast `AUTOMATION_IPC_CHANNELS.CHANGED`, forward the completion/error to the renderer, and invoke `notifyAutomationRunFinished`. It must not edit `automations.json` or invoke an Agent run.

- [ ] **Step 4: Replace all Electron execution entry points with Rust `runNow`**

```ts
ipcMain.handle(AUTOMATION_IPC_CHANNELS.RUN_NOW, async (_, id: string) => {
  await runtimeAutomationApiClient.runNow(id)
})
```

Remove `startScheduler` and `stopScheduler` from `index.ts`, remove `runAgentHeadless` use from the scheduler module, and remove the legacy `pi-builtin-tools` Automation CRUD/run-now registration. The capability-backed `pi-automation-tools.ts` remains the only Pi Automation tool implementation.

- [ ] **Step 5: Run focused Electron tests**

Run: `bun test apps/electron/src/main/lib/automation-api-client.test.ts apps/electron/src/main/lib/adapters/pi-automation-tools.test.ts apps/electron/src/main/lib/agent-rpc-gateway.test.ts`

Expected: PASS.

### Task 4: Validate complete lifecycle, documentation, and release metadata

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: affected `package.json`/Rust module version metadata

- [ ] **Step 1: Add a Rust lifecycle regression test**

```rust
#[test]
fn given_rust_scheduled_run_when_pi_calls_automation_tool_then_capability_is_valid_until_worker_finishes() {
    let run = harness.start_due_run();
    assert!(harness.worker_tool_context(&run.session_id).is_ok());
    harness.finish(run);
    assert!(harness.worker_tool_context(&run.session_id).is_err());
}
```

- [ ] **Step 2: Run it red, implement only the lifecycle gap it exposes, then rerun green**

Run: `cargo test --manifest-path native/http-api-server/Cargo.toml automation_scheduler_test`

Expected before implementation: FAIL; after implementation: PASS.

- [ ] **Step 3: Update repository documentation and versions**

Document that Automation scheduling and Pi Worker ownership are Rust-side, that Electron only bridges session preparation/persistence/notifications, and that runtime port resolution is shared. Increment the Electron and Rust HTTP API patch versions affected by the change.

- [ ] **Step 4: Run full proportional verification**

Run:

```bash
cargo test --manifest-path native/http-api-server/Cargo.toml
bun test apps/electron/src/main/lib/automation-api-client.test.ts
bun test apps/electron/src/main/lib/adapters/pi-automation-tools.test.ts
bun test apps/electron/src/main/lib/agent-rpc-gateway.test.ts
bun run --filter='@copis/electron' typecheck
bun run --filter='@copis/electron' build:main
```

Expected: all commands exit 0. Then inspect `git diff --check` and the scoped diff. UI behavior still requires user confirmation in the Electron application.
