# ClawShell-Inspired Payment Security Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Copis 设置页的本机 Pi 支付执行基建收紧为短生命周期、单次、单请求内容绑定的 Rust capability，并为后续 A1 支付协调器提供不泄漏敏感数据的内部结果和本机诊断能力。

**Architecture:** 保留设置页 `Renderer -> Rust /api/working/* -> edu-api` 的既有业务路径，且不将其与对话式 Agent 付费资源协议混用。只有 Rust 的 A1 支付协调器可调用 `PiWorkerManager::execute_payment()`；它创建固定 `default` 项目内的隔离 PiHome、签发一次性 capability，并把精确的支付请求摘要绑定到 capability。无模型 Pi Worker 只能把该请求交给 Rust 的 `alipay-bot` adapter；Payment-Proof 仅沿 Worker 到 Rust 的内部返回路径传递，Renderer 和普通 Agent 工具只得到脱敏结果。

**Tech Stack:** Rust 2021、现有 `serde_json` / `sha2` / `getrandom`、标准库 `Duration` / `Instant` / `VecDeque`、Electron TypeScript、Bun test、Cargo test。不得新增 crate 或 npm 包。

## Global Constraints

- 默认支付工作区必须继续由 Electron 启动时注入，固定为 `slug = "default"` 和 `<default-project>/.copis/payment`；不得从 Renderer、订单或 Agent 会话接收路径。
- 设置页的公开业务 API 继续只访问本地 Rust；本计划不修改 `working_payment.rs` 对 `edu-api` 的现有转发，也不改 `edu-api`、`pi-runtime`、套餐、价格、账本或 VIP 规则。
- 普通 Agent 的 `alipay_bot` Skill 保留其现有文件 capability 路径；设置页 A1 Worker 只能使用 `x-copis-payment-capability`，二者不得回退或互换。
- 不得把 Working JWT、`payment_needed`、受控 headers、Payment-Proof、CLI 原文、二维码本地文件路径、PiHome 路径、账号 ID、capability token 或完整上游响应写入日志、测试快照、Jotai、共享类型、IPC 或诊断接口。
- 所有新增注释、错误和日志使用中文；状态管理若未来接入 UI，使用 Jotai。未经用户允许，不修改 `AGENTS.md` 或 `README.md`。
- 支付 capability 默认有效期为 120 秒，正确 token 的首次使用即永久消费；CLI 失败后必须重新从服务端支付准备信息创建新的 capability，不能复用旧 token 重试。
- 每个实现任务先写失败测试，再写最小实现；每个任务完成后只提交该任务涉及的文件。

## Scope and Dependencies

本计划实施后，Copis 具备 A1 协调器所需的本机安全边界，但不会自行创建 A1 业务订单。A1 仍依赖 `edu-api` 冻结并实际提供钻石/VIP 的 `prepare`、`payment-context`、`payment-started` 和 `finalize/check` 契约；这些接口必须不再调用 `pi-runtime /api/alipay/execute`。在该外部契约冻结前，禁止把新的本机执行能力接到当前 `/api/working/diamond-purchases` 或 `/api/working/vip/upgrade` 创建接口。

## File Structure

| 文件 | 责任 |
| --- | --- |
| `native/http-api-server/src/payment_capability.rs` | 一次性、过期回收、请求摘要绑定的支付 capability 存储与校验。 |
| `native/http-api-server/src/alipay_bot.rs` | 把 Worker 请求归一化为可摘要的受控输入；按调用者返回公开或内部支付结果。 |
| `native/http-api-server/src/pi_rpc.rs` | 在启动无模型支付 Worker 前签发 capability、记录安全审计，并只解析当前支付 Worker 的内部结果。 |
| `native/http-api-server/src/payment_audit.rs` | 有界、内存态、无敏感字段的支付执行计数和近期结果。 |
| `native/http-api-server/src/main.rs` | 注册本地受 web token 保护的只读支付诊断路由。 |
| `apps/electron/src/main/pi-rpc-worker.ts` | 明确支付 Worker 的内部结果帧只回传 Rust，不进入普通 Agent 事件流。 |
| `apps/electron/src/main/lib/adapters/pi-alipay-bot-tool.ts` | 对普通 Agent 工具结果做第二层敏感字段剔除；不改变其请求协议。 |
| 对应 `*_tests.rs` / `*.test.ts` | 保护 capability、脱敏、诊断和 Worker 边界的 BDD 回归。 |

---

### Task 1: Bind Each Payment Capability to One Expiring Request

**Files:**

- Modify: `native/http-api-server/src/payment_capability.rs`
- Modify: `native/http-api-server/src/alipay_bot.rs`
- Modify: `native/http-api-server/src/alipay_bot_tests.rs`
- Modify: `native/http-api-server/src/pi_rpc.rs`
- Modify: `native/http-api-server/src/pi_rpc_tests.rs`

**Interfaces:**

- Produces `PaymentCapabilityScope { action: String, request_digest: [u8; 32] }` and `PaymentCapabilityStore::consume(session_id, token, &scope) -> Result<PathBuf, PaymentCapabilityError>`.
- `payment_scope_from_value(action, &Value) -> Result<PaymentCapabilityScope, String>` parses the same request schema used by `alipay_bot`; it excludes `sessionId` from the digest and includes action, wallet fields, Payment-Needed, resource URL, method, data, ordered headers, intent summary and payment identifiers.
- `PaymentCapabilityScope::for_test(action, digest)` is `#[cfg(test)]` only and exists solely for deterministic store tests.
- `PiWorkerManager::execute_payment()` creates the scope before spawning the Worker. `alipay_bot::handle_request()` rebuilds it after parsing the Worker HTTP request and consumes the capability before launching the CLI.

- [ ] **Step 1: Write failing one-shot, expiry and request-substitution tests**

In `payment_capability.rs`, replace the current reusable `resolve()` expectations with tests for successful `consume()`, repeated consumption and a zero-TTL test store:

```rust
#[test]
fn given_consumed_capability_when_called_again_then_it_is_unavailable() {
    let temp = TempDir::new();
    let store = PaymentCapabilityStore::new();
    let scope = PaymentCapabilityScope::for_test("wallet.check", [7; 32]);
    let token = store.register("payment-1", &temp.path, scope.clone()).unwrap();

    assert!(store.consume("payment-1", &token, &scope).is_ok());
    assert_eq!(
        store.consume("payment-1", &token, &scope).unwrap_err().code,
        "payment_capability_invalid"
    );
}

#[test]
fn given_expired_capability_when_consumed_then_it_is_removed() {
    let temp = TempDir::new();
    let store = PaymentCapabilityStore::new_with_ttl(Duration::ZERO);
    let scope = PaymentCapabilityScope::for_test("wallet.check", [8; 32]);
    let token = store.register("payment-1", &temp.path, scope.clone()).unwrap();

    assert_eq!(
        store.consume("payment-1", &token, &scope).unwrap_err().code,
        "payment_capability_invalid"
    );
    assert_eq!(store.active_count(), 0);
}
```

In `alipay_bot_tests.rs`, register a `payment.start` scope for a request containing `https://seller.example/prepare`, then invoke the internal endpoint with the same token but a changed `resourceUrl` and a fake CLI. Assert `payment_capability_invalid` and assert the fake CLI marker file was not created. Add equivalent cases for changed `paymentNeeded`, `data`, headers and `tradeNo`.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```bash
cargo test --manifest-path native/http-api-server/Cargo.toml payment_capability
cargo test --manifest-path native/http-api-server/Cargo.toml alipay_bot
cargo test --manifest-path native/http-api-server/Cargo.toml pi_rpc
```

Expected: the new tests fail because the store still exposes reusable `resolve()`, has no TTL or request digest, and `PiWorkerManager` registers only an action string.

- [ ] **Step 3: Implement scope digest, atomic consume and expiry cleanup**

In `payment_capability.rs`:

```rust
pub const PAYMENT_CAPABILITY_TTL: Duration = Duration::from_secs(120);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentCapabilityScope {
    action: String,
    request_digest: [u8; 32],
}

pub fn consume(
    &self,
    session_id: &str,
    token: &str,
    scope: &PaymentCapabilityScope,
) -> Result<PathBuf, PaymentCapabilityError> {
    // 在同一把锁内清除过期项，并在校验 token 后移除该 session。
    // scope、过期时间或目录校验不通过时不得执行 CLI。
}
```

Store each capability with `created_at: Instant`, `home` and `scope`. `consume()` must remove the session once its token is valid, before comparing action/digest or returning the home path. A wrong token must not remove another caller's capability. `active_count()` must purge expired entries before returning the count. Preserve canonical-directory and anti-symlink checks.

In `alipay_bot.rs`, derive the digest from a dedicated serializable payload with fixed field order. Do not hash the raw JSON bytes: `headers` may arrive as tuples or objects and semantically identical input must create the same digest after parsing. Do not include `sessionId`, token, local file paths or CLI output in the digest.

In `pi_rpc.rs`, obtain `PaymentCapabilityScope` from the original Rust-owned request, call `register(session_id, account_home, scope)`, and retain the existing `remove(session_id)` cleanup after `wait_with_output()`. Replace `resolve()` in the internal handler with `consume()`.

- [ ] **Step 4: Run focused Rust tests and inspect the exact safety behavior**

Run:

```bash
cargo test --manifest-path native/http-api-server/Cargo.toml payment_capability
cargo test --manifest-path native/http-api-server/Cargo.toml alipay_bot
cargo test --manifest-path native/http-api-server/Cargo.toml pi_rpc
```

Expected: valid scope executes once; duplicate, expired, cross-session, changed action and changed request content are rejected before CLI execution; a bad token cannot delete a valid capability.

- [ ] **Step 5: Commit the capability boundary**

```bash
git add native/http-api-server/src/payment_capability.rs native/http-api-server/src/alipay_bot.rs native/http-api-server/src/alipay_bot_tests.rs native/http-api-server/src/pi_rpc.rs native/http-api-server/src/pi_rpc_tests.rs
git commit -m "feat(payment): bind local payment capability to one request"
```

### Task 2: Separate Internal Payment Evidence from Agent-Safe Output

**Files:**

- Modify: `native/http-api-server/src/alipay_bot.rs`
- Modify: `native/http-api-server/src/alipay_bot_tests.rs`
- Modify: `apps/electron/src/main/pi-rpc-worker.ts`
- Modify: `apps/electron/src/main/pi-rpc-worker.test.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-alipay-bot-tool.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-alipay-bot-tool.test.ts`

**Interfaces:**

- Produces `AlipayBotOutput::to_agent_value()` and `AlipayBotOutput::to_payment_worker_value()`.
- `to_agent_value()` is the only result accepted by `buildPiAlipayBotTools()` and excludes `paymentProof`, `qrCodePath`, `raw`, Payment-Needed and headers.
- `to_payment_worker_value()` is selected only after a valid `x-copis-payment-capability` is consumed. It may contain a sanitized `paymentProof`, `tradeNo`, `outShakeNo`, `cashierUrl`, `status`, `code`, `success`, `message` and `errorCode`; it never contains raw CLI output or filesystem paths.
- `runPaymentWorker()` emits this internal object only in a `payment_result` frame. It must not call `emitEvent()` or `toAgentToolResult()`.

- [ ] **Step 1: Write failing public/internal serialization tests**

Add a Rust fixture with `payment_proof`, `qr_code_path` and raw CLI text. Assert both serializers explicitly:

```rust
let output = sanitize_alipay_output(
    r#"{"trade_no":"trade-1","payment_proof":"proof-secret","cashier_url":"https://pay.example"}"#,
);
let agent = output.to_agent_value();
let worker = output.to_payment_worker_value();

assert!(agent.get("paymentProof").is_none());
assert!(agent.get("qrCodePath").is_none());
assert_eq!(worker.get("paymentProof").and_then(Value::as_str), Some("proof-secret"));
assert!(worker.get("raw").is_none());
assert!(worker.get("qrCodePath").is_none());
```

Add an endpoint test proving that a valid normal Agent file token still receives no proof even if a malicious Rust fixture returns it. Add a payment capability request test proving the Worker does receive the proof but not the raw output.

In `pi-rpc-worker.test.ts`, run the payment command fixture with a response containing `paymentProof` and assert the only stdout JSON frame is `type: "payment_result"`; assert the serialized frame is never routed through an `event` or `sdk_message` payload. In `pi-alipay-bot-tool.test.ts`, make the mocked normal Agent response contain `paymentProof` and assert `details` and text content omit it.

- [ ] **Step 2: Run focused tests to verify they fail**

Run:

```bash
cargo test --manifest-path native/http-api-server/Cargo.toml alipay_bot
bun test apps/electron/src/main/pi-rpc-worker.test.ts apps/electron/src/main/lib/adapters/pi-alipay-bot-tool.test.ts
```

Expected: current `sanitize_alipay_output()` discards proof for every caller, and the TypeScript tool result has no defense against an unexpected sensitive field.

- [ ] **Step 3: Implement audience-specific output with defense in depth**

In `sanitize_alipay_output()`, retain only a bounded, single-line `payment_proof` from structured JSON. Continue clearing `qr_code_path` and `raw` unconditionally. Update `merge_alipay_output_json()` to read only documented proof aliases (`paymentProof`, `payment_proof`) through `sanitize_text()`.

In `handle_request()`, select the audience from the authenticated capability path:

```rust
let audience = if payment_capability_token.is_some() {
    AlipayBotAudience::PaymentWorker
} else {
    AlipayBotAudience::Agent
};

let body = match audience {
    AlipayBotAudience::Agent => output.to_agent_value(),
    AlipayBotAudience::PaymentWorker => output.to_payment_worker_value(),
};
```

Do not let a request body field, Origin, query parameter or TypeScript option choose this audience. In `pi-alipay-bot-tool.ts`, add a narrow `redactAgentPaymentFields()` that removes `paymentProof`, `payment_needed`, `paymentNeeded`, `headers`, `raw` and `qrCodePath` before `toAgentToolResult()` serializes any normal Agent result. `runPaymentWorker()` continues to call the client with the dedicated header and writes its result only to the existing `payment_result` frame.

- [ ] **Step 4: Run focused tests and scan for sensitive response fields**

Run:

```bash
cargo test --manifest-path native/http-api-server/Cargo.toml alipay_bot
bun test apps/electron/src/main/pi-rpc-worker.test.ts apps/electron/src/main/lib/adapters/pi-alipay-bot-tool.test.ts
rg -n "paymentProof|payment_proof|qrCodePath|paymentNeeded" apps/electron/src/main/pi-rpc-worker.ts apps/electron/src/main/lib/adapters/pi-alipay-bot-tool.ts native/http-api-server/src/alipay_bot.rs
```

Expected: proof is visible only in the Rust-to-payment-Worker response/frame; normal Agent output has no sensitive fields; the search identifies each remaining sensitive field as internal parsing, scope hashing or explicit redaction only.

- [ ] **Step 5: Commit the result boundary**

```bash
git add native/http-api-server/src/alipay_bot.rs native/http-api-server/src/alipay_bot_tests.rs apps/electron/src/main/pi-rpc-worker.ts apps/electron/src/main/pi-rpc-worker.test.ts apps/electron/src/main/lib/adapters/pi-alipay-bot-tool.ts apps/electron/src/main/lib/adapters/pi-alipay-bot-tool.test.ts
git commit -m "feat(payment): isolate local payment proof from agents"
```

### Task 3: Add Bounded, Sanitized Local Payment Diagnostics

**Files:**

- Create: `native/http-api-server/src/payment_audit.rs`
- Create: `native/http-api-server/src/payment_audit_tests.rs`
- Modify: `native/http-api-server/src/main.rs`
- Modify: `native/http-api-server/src/main_tests.rs`
- Modify: `native/http-api-server/src/pi_rpc.rs`
- Modify: `native/http-api-server/src/pi_rpc_tests.rs`

**Interfaces:**

- Produces `PaymentAuditStore` with a bounded 50-entry in-memory ring buffer and `PaymentDiagnostics { active_capabilities, recent }`.
- Each `recent` element is exactly `{ action, outcome, elapsedMs }`; `action` is a fixed `PaymentWorkerAction` string and `outcome` is either `succeeded` or `failed`.
- `PiWorkerManager::payment_diagnostics() -> PaymentDiagnostics` snapshots the audit store with `PaymentCapabilityStore::active_count()`; it has no request, account or Worker-result parameter.
- Exposes `GET /api/working/payment-diagnostics`, requiring both the existing local web-token authorization and an active `SkillMarketState` Working token. The route has no upstream `edu-api` call and returns no identity or payment data.

- [ ] **Step 1: Write failing audit-store and route tests**

Create `payment_audit_tests.rs` with a cap test and a serialization test:

```rust
#[test]
fn given_more_than_fifty_records_when_snapshot_then_only_latest_fifty_are_returned() {
    let audit = PaymentAuditStore::new();
    for _ in 0..51 {
        audit.record(PaymentAuditAction::PaymentCheck, PaymentAuditOutcome::Succeeded, 12);
    }

    let snapshot = audit.snapshot(3);
    assert_eq!(snapshot.active_capabilities, 3);
    assert_eq!(snapshot.recent.len(), 50);
    let json = serde_json::to_value(snapshot).unwrap();
    assert_eq!(json["activeCapabilities"], 3);
    assert_eq!(json["recent"].as_array().map(Vec::len), Some(50));
    assert_eq!(json["recent"][0], json!({
        "action": "payment.check",
        "outcome": "succeeded",
        "elapsedMs": 12,
    }));
}
```

Add a `main_tests.rs` request fixture named `given_payment_diagnostics_when_working_token_is_missing_then_it_returns_unauthorized`, plus one named `given_payment_diagnostics_when_working_token_exists_then_it_returns_only_safe_fields`. The second fixture verifies a 200 response and that its body has none of `sessionId`, `token`, `account`, `home`, `resourceUrl`, `paymentProof`, `paymentNeeded`, `headers`, `tradeNo` or `cashierUrl`.

- [ ] **Step 2: Run focused tests to verify they fail**

Run:

```bash
cargo test --manifest-path native/http-api-server/Cargo.toml payment_audit
cargo test --manifest-path native/http-api-server/Cargo.toml payment_diagnostics
```

Expected: compilation fails because the audit module, diagnostics response and route do not exist.

- [ ] **Step 3: Implement audit storage and authenticated route**

Implement `PaymentAuditStore` with `Mutex<VecDeque<PaymentAuditRecord>>`; trim to 50 on insert. Add `#[cfg(test)] #[path = "payment_audit_tests.rs"] mod tests;` in `payment_audit.rs`. Its `record()` method accepts only `PaymentWorkerAction`, `PaymentAuditOutcome::{Succeeded, Failed}` and an elapsed `u64`; it must never accept an arbitrary error string or `Value`, so sensitive text cannot reach the snapshot by accident.

Add `payment_audit: Arc<PaymentAuditStore>` to `PiWorkerManager`. Add `payment_diagnostics()` that combines `payment_audit.snapshot(payment_capabilities.active_count())`. In `execute_payment()`, capture `Instant::now()`, record `Succeeded` only when the final result is `Ok`, otherwise record `Failed`, with `elapsed.as_millis().min(u64::MAX as u128) as u64`, and then remove the capability. Do not write the request, result or error string to stderr.

In `main.rs`, add the route before the generic `is_working_payment_path()` dispatch:

```rust
if request.method == "GET" && path == "/api/working/payment-diagnostics" {
    if skill_market_state.access_token().is_none() {
        send_json_response(&mut stream, 401, r#"{"error":"请先登录 Copis Working","code":"unauthorized"}"#, origin);
    } else {
        let body = serde_json::to_string(&workers.payment_diagnostics())
            .expect("固定支付诊断模型必须可序列化");
        send_json_response(&mut stream, 200, &body, origin);
    }
    let _ = stream.shutdown(Shutdown::Both);
    return;
}
```

Keep the existing `is_web_route_authorized()` gate in front of it. Do not add the route to `working_payment.rs`, because it is local process state rather than an edu-api business resource.

- [ ] **Step 4: Run focused tests and verify no sensitive diagnostic fields**

Run:

```bash
cargo test --manifest-path native/http-api-server/Cargo.toml payment_audit
cargo test --manifest-path native/http-api-server/Cargo.toml payment_diagnostics
rg -n "payment-diagnostics|PaymentDiagnostics|sessionId|paymentProof|paymentNeeded|resourceUrl|cashierUrl" native/http-api-server/src/payment_audit.rs native/http-api-server/src/main.rs
```

Expected: diagnostics remain bounded, require active Working login, and expose only fixed action/outcome names plus elapsed time and active capability count.

- [ ] **Step 5: Commit the diagnostic surface**

```bash
git add native/http-api-server/src/payment_audit.rs native/http-api-server/src/payment_audit_tests.rs native/http-api-server/src/main.rs native/http-api-server/src/main_tests.rs native/http-api-server/src/pi_rpc.rs native/http-api-server/src/pi_rpc_tests.rs
git commit -m "feat(payment): add sanitized local payment diagnostics"
```

### Task 4: Prove the Combined Boundary and Package It

**Files:**

- Modify: `native/http-api-server/src/pi_rpc_tests.rs`
- Do not modify `docs/superpowers/specs/2026-08-10-working-payment-integration-design.md`, `README.md` or `AGENTS.md` without separate user approval.

**Interfaces:**

- Consumes the capability, audience and diagnostics contracts from Tasks 1-3.
- Produces a Rust HTTP API binary that starts the existing self-contained `copis __pi-worker` and retains the default-payment-workspace environment contract.

- [ ] **Step 1: Add one end-to-end BDD regression in Rust**

Extend `pi_rpc_tests.rs` with a fake `alipay-bot` process and this behavior:

```text
Given a Rust-owned payment.start request for Working account A in the default payment workspace
When PiWorkerManager starts the no-model payment Worker
Then exactly one matching capability can invoke the CLI
And a second request, a changed resource URL, an Agent file token, or account B's PiHome cannot invoke it
And the public Agent response and payment diagnostics do not contain proof, headers, URL, account, token or local path
```

The test must use a marker file written only by the fake CLI, then assert the marker exists once for the valid request and is unchanged for all rejected requests. Use unique temp directories and remove only those explicit directories in `Drop`/cleanup.

- [ ] **Step 2: Run all affected automated checks**

Run:

```bash
cargo fmt --manifest-path native/http-api-server/Cargo.toml -- --check
cargo test --manifest-path native/http-api-server/Cargo.toml
bun test apps/electron/src/main/pi-rpc-worker.test.ts apps/electron/src/main/lib/adapters/pi-alipay-bot-tool.test.ts apps/electron/src/main/lib/http-api-server-runtime.test.ts
bun run typecheck
bun run --filter='@copis/electron' build:main
git diff --check
```

Expected: every focused and Rust test passes; TypeScript typecheck and main-process build pass; no format or whitespace errors remain.

- [ ] **Step 3: Build and validate the development Rust binary**

Run:

```bash
bun run scripts/build-http-api-server.ts
native/http-api-server/target/release/copis-http-api-server --help
```

Expected: the release binary builds and is executable. This does not publish a functional module or deploy a client.

- [ ] **Step 4: Inspect the final diff for prohibited data flows**

Run:

```bash
git diff --check
git diff -- native/http-api-server/src/payment_capability.rs native/http-api-server/src/payment_audit.rs native/http-api-server/src/alipay_bot.rs native/http-api-server/src/pi_rpc.rs native/http-api-server/src/main.rs apps/electron/src/main/pi-rpc-worker.ts apps/electron/src/main/lib/adapters/pi-alipay-bot-tool.ts
```

Reject the change if any diff adds Payment-Needed, Payment-Proof, token, full CLI output, account ID/hash, `resourceUrl`, headers or PiHome path to a public type, `console.*`, `eprintln!`, Jotai atom, IPC payload or diagnostics response.

- [ ] **Step 5: Commit the end-to-end regression**

```bash
git add native/http-api-server/src/pi_rpc_tests.rs
git commit -m "test(payment): verify local capability boundary"
```

## A1 Integration Gate After This Plan

Do not attach `PiWorkerManager::execute_payment()` to the settings page until all of the following are evidenced by a versioned `edu-api` contract test:

1. Diamond and VIP prepare endpoints return a server-owned `paymentId`, `outTradeNo`, `paymentNeeded` and payment context without calling `pi-runtime`.
2. `payment-started` persists display fields idempotently and accepts no Renderer-provided amount, order, resource URL or proof.
3. `finalize/check` accepts the local internal result idempotently, performs the ledger/VIP mutation exactly once, and returns `resource_ready` as the only success state.
4. Rust records every external abort as the fixed `failed` audit outcome without logging untrusted body text.

Once these four conditions hold, implement the A1 coordinator described in `docs/superpowers/specs/2026-08-10-working-payment-integration-design.md`; use the hardened `execute_payment()` path from this plan rather than the current public create/check forwarding path.

## Plan Self-Review

- Spec coverage: fixed default workspace, short-lived single-use capability, request integrity, internal Payment-Proof path, agent output redaction, local diagnostics and packaging verification are each covered by a separate testable task. Existing settings UI and Rust-to-edu-api routing remain intentionally unchanged.
- Placeholder scan: no task contains an unassigned implementation marker, unspecified error handling or unnamed tests. The only external dependency is explicitly isolated in the A1 integration gate and is not an implementation task in this repository.
- Type consistency: `PaymentCapabilityScope` is created from the Rust-owned request before Worker launch and reconstructed from the parsed adapter request before CLI launch; `to_agent_value()` is public-only, while `to_payment_worker_value()` is restricted to the dedicated payment capability path.
