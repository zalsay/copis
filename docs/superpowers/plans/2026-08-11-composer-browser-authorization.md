# Composer Browser Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the Composer advanced-authorization icon to the bound AI browser so enabled user sessions execute all page actions, including sensitive fields, without page-approval prompts.

**Architecture:** Reuse persisted `AgentSessionMeta.advancedAuthorization` as the single source of truth. `browser-workflow-service` derives the effective page mode, `browser-page-control-service` uses a session-scoped advanced-authorization predicate to bypass its sensitive-element guard, and the IPC toggle publishes a fresh browser status event. Automation and delegation sessions never inherit this user-session capability.

**Tech Stack:** Electron main process, TypeScript, Bun test, React/Jotai renderer, Pi prompt/Skill files, JSON session metadata.

## Global Constraints

- Preserve Worker capability, session binding/owner, HTTP(S), Origin/URL, and trusted-event checks.
- Only `triggeredBy: user` sessions without automation/delegation source metadata may use Composer advanced authorization.
- No new dependency or database; keep session metadata as the source of truth.
- Comments and logs remain Chinese; use interfaces and `import type`; do not introduce `any`.
- Bump `apps/electron` patch version and bump `browser-page-control` Skill frontmatter from `1.0.3` to `1.0.4`.
- Keep AGENTS.md and README.md synchronized with the behavior change.
- Electron UI visual acceptance remains a user check in the real Copis window.

---

### Task 1: Derive Effective Browser Authorization From Session Metadata

**Files:**
- Modify: `apps/electron/src/main/lib/browser-workflow-service.ts`
- Test: `apps/electron/src/main/lib/browser-workflow-service.test.ts`

**Interfaces:**
- Produces `isBrowserPageAdvancedAuthorizationEnabled(sessionId: string): boolean` for the page-control runtime.
- `getBrowserPageControlMode(sessionId)` and `withBrowserPageControlState` return `authorized` when this predicate is true; otherwise retain per-origin authorization behavior.

- [ ] **Step 1: Write failing BDD tests**

Add tests covering a `user` session with `advancedAuthorization: true` reporting `authorized`, the same session with the flag off retaining `ask`, and sessions with `sourceAutomationId` or `sourceDelegationId` never inheriting the flag. Use the existing browser workflow test fixtures and mock session metadata.

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run: `bun test apps/electron/src/main/lib/browser-workflow-service.test.ts`

Expected: the new assertions fail because the current status only checks persisted origin authorizations and no advanced-authorization predicate exists.

- [ ] **Step 3: Implement the minimal effective-mode helper**

Read `getAgentSessionMeta(sessionId)` in `browser-workflow-service.ts`. Return true only when `advancedAuthorization === true`, `sourceAutomationId` is absent, and `sourceDelegationId` is absent. Make `withBrowserPageControlState` and `getBrowserPageControlMode` use this helper before the existing origin calculation. Keep `setBrowserPageControlMode` persistence unchanged for explicit per-origin authorization.

- [ ] **Step 4: Run the focused test and verify green**

Run: `bun test apps/electron/src/main/lib/browser-workflow-service.test.ts`

Expected: all existing and new status assertions pass.

- [ ] **Step 5: Commit the isolated service/test change**

```bash
git add apps/electron/src/main/lib/browser-workflow-service.ts apps/electron/src/main/lib/browser-workflow-service.test.ts
git commit -m "feat: derive browser authorization from composer session"
```

### Task 2: Allow Sensitive Page Controls Only Under Effective Advanced Authorization

**Files:**
- Modify: `apps/electron/src/main/lib/browser-page-control-service.ts`
- Modify: `apps/electron/src/main/lib/browser-page-control-runtime.ts`
- Test: `apps/electron/src/main/lib/browser-page-control-service.test.ts`

**Interfaces:**
- Extend `BrowserPageControlRuntime` with `isAdvancedAuthorizationEnabled(sessionId: string): boolean`.
- `createBrowserPageControlService` keeps all existing element, input-length, key, URL, and CDP validation while skipping `assertNonSensitiveElement` only when the runtime predicate is true.

- [ ] **Step 1: Write failing tests**

Update the runtime fixture with a mutable advanced flag. Keep the existing test proving sensitive input is rejected when the flag is false, then add tests proving password/OTP/file-like fields can be typed/selected/pressed when the flag is true and the CDP input command is reached.

- [ ] **Step 2: Run the focused test and verify red**

Run: `bun test apps/electron/src/main/lib/browser-page-control-service.test.ts`

Expected: the new advanced-sensitive-action tests fail at the existing `assertNonSensitiveElement` guard.

- [ ] **Step 3: Implement the minimal runtime predicate and guard bypass**

Wire `isAdvancedAuthorizationEnabled` to `isBrowserPageAdvancedAuthorizationEnabled` in `browser-page-control-runtime.ts`. Change `assertNonSensitiveElement` to accept the session ID and return when the runtime predicate is true. Use it in `typeText`, `select`, and `press`; do not remove sensitivity classification from observe output.

- [ ] **Step 4: Run the focused test and verify green**

Run: `bun test apps/electron/src/main/lib/browser-page-control-service.test.ts`

Expected: ordinary ask-mode and non-advanced sensitive rejection tests remain green; advanced-sensitive actions pass.

- [ ] **Step 5: Commit the control-layer change**

```bash
git add apps/electron/src/main/lib/browser-page-control-service.ts apps/electron/src/main/lib/browser-page-control-runtime.ts apps/electron/src/main/lib/browser-page-control-service.test.ts
git commit -m "feat: allow advanced browser sensitive actions"
```

### Task 3: Refresh Browser Status When Composer Authorization Toggles

**Files:**
- Modify: `apps/electron/src/main/lib/browser-workflow-service.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Test: `apps/electron/src/main/lib/browser-workflow-service.test.ts`
- Test: `apps/electron/src/main/lib/browser-agent-tool-service.test.ts`

**Interfaces:**
- Produces `refreshBrowserWorkflowStatus(sessionId: string): BrowserWorkflowStatus | undefined` (or an equivalent existing-service notification path) for the advanced-authorization IPC handler.
- `BrowserPageOpenTab`, navigation, mutation, and sensitive dispatcher tests prove user sessions do not request single approval under advanced authorization while automation/delegation still do.

- [ ] **Step 1: Add failing status-refresh and dispatcher tests**

Add a test that toggles session metadata through the existing IPC-facing service path and observes a status event changing to `authorized`. Add dispatcher coverage for a user session with advanced authorization executing a sensitive `BrowserPageType` without approval, and for an automation/delegation session still rejecting or requesting its existing approval.

- [ ] **Step 2: Run focused tests and verify red**

Run: `bun test apps/electron/src/main/lib/browser-agent-tool-service.test.ts` and separately `bun test apps/electron/src/main/lib/browser-workflow-service.test.ts`.

Expected: status remains stale or sensitive dispatcher calls remain blocked until the runtime changes from Tasks 1-2 are wired through the toggle path.

- [ ] **Step 3: Implement the IPC refresh path**

Export a small browser-workflow refresh/emit helper that recomputes status through `currentStatus`. Import it in `ipc.ts` and call it after `updateAgentSessionMeta(sessionId, { advancedAuthorization: enabled })`. Do not create a new channel or mutate per-origin authorization storage. Ensure no-op sessions without a binding simply return without emitting.

- [ ] **Step 4: Run focused tests and verify green**

Run each Bun test file in its own process: `bun test apps/electron/src/main/lib/browser-agent-tool-service.test.ts` and `bun test apps/electron/src/main/lib/browser-workflow-service.test.ts`.

Expected: user advanced sessions execute all dispatcher actions without single approval; automation/delegation boundaries and existing ask-mode behavior remain green.

- [ ] **Step 5: Commit the toggle/status integration**

```bash
git add apps/electron/src/main/ipc.ts apps/electron/src/main/lib/browser-workflow-service.ts apps/electron/src/main/lib/browser-workflow-service.test.ts apps/electron/src/main/lib/browser-agent-tool-service.test.ts
git commit -m "feat: refresh browser status on composer authorization"
```

### Task 4: Align Agent Instructions With the New Toggle

**Files:**
- Modify: `apps/electron/src/main/lib/agent-prompt-builder.ts`
- Modify: `apps/electron/src/main/lib/agent-rpc-service.ts`
- Modify: `apps/electron/default-skills/browser-page-control/SKILL.md`
- Modify: `apps/electron/src/main/lib/agent-prompt-builder.test.ts`
- Modify: `apps/electron/src/main/lib/default-skills-manifest.test.ts`

**Interfaces:**
- Extend system-prompt context with `browserAdvancedAuthorization?: boolean`, passed from the session metadata in `prepareAgentRpcRun`.
- Prompt text explicitly distinguishes Composer advanced-on (all requested page actions, including sensitive fields) from advanced-off (current page policy).

- [ ] **Step 1: Write failing prompt/manifest tests**

Add prompt assertions for advanced-on instructions and advanced-off instructions. Update the Skill manifest expectation to require version `1.0.4` and assert the Skill no longer categorically says sensitive actions must be user-only.

- [ ] **Step 2: Run focused tests and verify red**

Run: `bun test apps/electron/src/main/lib/agent-prompt-builder.test.ts` and separately `bun test apps/electron/src/main/lib/default-skills-manifest.test.ts`.

Expected: advanced-state text and the new Skill version assertions fail before implementation.

- [ ] **Step 3: Implement dynamic prompt and Skill copy**

Pass `session.advancedAuthorization === true` only for the bound user browser context. Update browser instructions to say that the Composer icon is the authorization source and that advanced-on permits sensitive actions. Bump the Skill frontmatter patch version and preserve Observe/ref, untrusted-content, and internal-tab rules.

- [ ] **Step 4: Run focused tests and verify green**

Run the two focused test files from Step 2. Expected: all prompt and manifest assertions pass.

- [ ] **Step 5: Commit instruction changes**

```bash
git add apps/electron/src/main/lib/agent-prompt-builder.ts apps/electron/src/main/lib/agent-rpc-service.ts apps/electron/src/main/lib/agent-prompt-builder.test.ts apps/electron/src/main/lib/default-skills-manifest.test.ts apps/electron/default-skills/browser-page-control/SKILL.md
git commit -m "docs: align browser agent instructions with composer authorization"
```

### Task 5: Update Composer Copy, Project Docs, and Package Version

**Files:**
- Modify: `apps/electron/src/renderer/components/agent/AgentConversationSurface.tsx`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `apps/electron/package.json`

**Interfaces:**
- The existing shield icon remains the control; its tooltip names AI-browser authorization and its `aria-label` remains discoverable.
- Documentation states that enabled Composer authorization permits all bound internal-page actions, while capability and internal-tab boundaries remain.

- [ ] **Step 1: Update the UI and documentation**

Change the enabled tooltip from Git/SSH-only wording to include bound AI-browser page operations and sensitive fields. Update README and AGENTS browser sections with the exact enabled/disabled behavior and automation/delegation boundary. Bump Electron patch version `0.0.55` to `0.0.56`.

- [ ] **Step 2: Run static checks**

Run: `git diff --check`.

Expected: no whitespace errors and no unrelated file changes introduced by this task.

- [ ] **Step 3: Commit UI/docs/version changes**

```bash
git add apps/electron/src/renderer/components/agent/AgentConversationSurface.tsx README.md AGENTS.md apps/electron/package.json
git commit -m "docs: describe composer browser authorization"
```

### Task 6: Combined Verification and User Handoff

**Files:**
- Verify all files changed by Tasks 1-5; no new implementation files.

- [ ] **Step 1: Run browser unit tests in separate Bun processes**

Run:

```bash
bun test apps/electron/src/main/lib/browser-page-control-service.test.ts
bun test apps/electron/src/main/lib/browser-agent-tool-service.test.ts
bun test apps/electron/src/main/lib/browser-workflow-service.test.ts
```

Expected: each process exits 0. Keep config-path mocks isolated by not combining the two workflow/storage test files into one process.

- [ ] **Step 2: Run prompt/RPC regression tests**

Run:

```bash
bun test apps/electron/src/main/lib/agent-prompt-builder.test.ts
bun test apps/electron/src/main/lib/agent-rpc-service.test.ts
bun test apps/electron/src/main/lib/default-skills-manifest.test.ts
```

- [ ] **Step 3: Run repository-required checks**

Run:

```bash
bun run typecheck
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:renderer
git diff --check
```

- [ ] **Step 4: Inspect the final diff**

Confirm no secrets, capability tokens, sensitive values, generated build noise, or unrelated user changes are staged. Verify the design commit and implementation changes remain separable.

- [ ] **Step 5: Ask for real Electron UI confirmation**

Tell the user to open a normal HTTP(S) page in Copis, open the Composer shield icon, and verify that a sensitive-field page action proceeds without the old “询问模式” message. Record that this visual/interaction check cannot be replaced by screenshots or DOM-only automation.
