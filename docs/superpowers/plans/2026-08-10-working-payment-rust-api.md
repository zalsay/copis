# Working Payment Rust API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Copis Working diamond and VIP payment calls through the local Rust HTTP API so Rust, rather than Electron's business bridge, owns the edu-api request.

**Architecture:** Rust recognizes a dedicated `/api/working/*` payment route group, reuses the existing Working token state and backend proxy, and forwards only the corresponding edu-api paths. Native Electron IPC calls the local Rust HTTP API without sending the JWT; browser mode uses the same local routes. Payment payloads are normalized in the existing TypeScript boundary before renderer code receives them.

**Tech Stack:** Rust `ureq` HTTP proxy, Bun/TypeScript Electron main process, Jotai renderer state, Bun tests, Cargo tests.

---

### Task 1: Add the Rust payment route contract

**Files:**
- Create: `native/http-api-server/src/working_payment.rs`
- Create: `native/http-api-server/src/working_payment_tests.rs`
- Modify: `native/http-api-server/src/main.rs`
- Modify: `native/http-api-server/src/skill_market.rs`
- Modify: `native/http-api-server/src/main_tests.rs`

- [x] **Step 1: Write the failing route and proxy tests**

Cover exact route parsing, `packageId` to `package_id` request conversion, bearer forwarding, `data` unwrapping, and preservation of the payment-check `ok/data` envelope.

- [x] **Step 2: Run the focused Cargo test and verify it fails**

Run: `cargo test --manifest-path native/http-api-server/Cargo.toml working_payment`

Expected: compilation/test failure because the Rust payment route module and handlers do not exist yet.

- [x] **Step 3: Implement the Rust route and proxy**

Reuse `SkillMarketState`, `COPIS_BACKEND_URL`, and the existing remote error mapping. Add the route dispatch before the Electron bridge and synchronize the existing internal Working token update into the shared state used by the payment route.

- [x] **Step 4: Run the focused Cargo tests again**

Run: `cargo test --manifest-path native/http-api-server/Cargo.toml working_payment`

Expected: all payment route tests pass.

### Task 2: Move Electron payment calls to local Rust

**Files:**
- Modify: `apps/electron/src/main/lib/working-api-client.ts`
- Modify: `apps/electron/src/main/lib/working-api-client.test.ts`
- Modify: `apps/electron/src/main/lib/http-api-handler.ts`
- Modify: `apps/electron/src/main/lib/http-api-server.test.ts`
- Modify: `apps/electron/src/renderer/lib/http-api-bridge.ts`

- [x] **Step 1: Add failing boundary tests**

Assert the main-process payment client requests `http://127.0.0.1:<rust-port>/api/working/*`, does not attach `Authorization`, and preserves the existing normalized payment model. Assert the Electron business bridge no longer handles payment routes.

- [x] **Step 2: Run the focused Bun tests and verify the new assertions fail**

Run: `bun test apps/electron/src/main/lib/working-api-client.test.ts apps/electron/src/main/lib/http-api-server.test.ts`

Expected: payment calls still target edu-api or the bridge still forwards them.

- [x] **Step 3: Implement the local Rust transport and renderer normalization**

Keep remote auth and refresh behavior for non-payment Working APIs. Payment methods must synchronize the current token to Rust, call the loopback endpoint, and normalize only the allowed payment fields. Browser bridge methods must perform the same normalization.

- [x] **Step 4: Run the focused Bun tests again**

Run: `bun test apps/electron/src/main/lib/working-api-client.test.ts apps/electron/src/main/lib/http-api-server.test.ts`

Expected: all focused TypeScript tests pass.

### Task 3: Verify the integrated contract

**Files:**
- No additional source files unless the focused checks identify a contract defect.

- [x] **Step 1: Run Rust formatting and tests**

Run: `cargo fmt --manifest-path native/http-api-server/Cargo.toml -- --check` and `cargo test --manifest-path native/http-api-server/Cargo.toml`

- [x] **Step 2: Run Copis typecheck and builds**

Run: `bun run typecheck`, `bun run --filter='@copis/electron' build:main`, `bun run --filter='@copis/electron' build:preload`, and `bun run --filter='@copis/electron' build:renderer`.

- [x] **Step 3: Inspect the final diff**

Run: `git diff --check` and confirm no payment IPC path calls the edu-api base URL directly and no JWT or payment diagnostic payload is logged or persisted.
