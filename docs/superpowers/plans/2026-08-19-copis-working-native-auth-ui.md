# Copis Working Native Auth UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Copis Working's original in-app login, registration, and password-reset UI while keeping the new Auth backend and token bridge.

**Architecture:** Restore the existing renderer dialog behavior from commit `4c6c19c0`. The renderer calls the already-existing `window.electronAPI` auth methods; the main-process `WorkingApiClient` remains the only layer that handles backend responses and persists credentials. OIDC token refresh and discovery stay unchanged.

**Tech Stack:** React 18, TypeScript, Bun test, Electron preload IPC, existing Copis CSS and Lucide icons.

## Global Constraints

- Use Jotai for application state; this dialog keeps transient form state local as before.
- Do not add dependencies or change the Auth/OIDC protocol.
- Keep tokens out of the renderer and route auth through existing IPC methods.
- Preserve Chinese comments/logs and existing component/CSS conventions.
- Do not modify `README.md` or `AGENTS.md` in this task.

### Task 1: Restore the dialog contract

**Files:**
- Modify: `apps/electron/src/renderer/components/app-shell/CopisWorkingLoginPage.contract.test.ts`
- Modify: `apps/electron/src/renderer/components/app-shell/CopisWorkingLoginDialog.tsx`
- Modify: `apps/electron/src/renderer/components/app-shell/CopisWorkingLoginDialog.css`

**Interfaces:**
- Consumes: existing `window.electronAPI.loginWorking`, `registerWorking`, `sendWorkingVerificationCode`, `verifyWorkingPasswordResetCode`, and `resetWorkingPassword` methods.
- Produces: the existing `CopisWorkingLoginDialog` props and `WorkingAuthState` callback behavior.

- [ ] **Step 1: Write the failing contract assertions**

  Replace the OAuth-only assertions with BDD assertions that the dialog source contains the native login form, login/register mode, forgot-password flow, and existing IPC calls, and that it does not contain `loginWorkingWithOAuth` or the OAuth-only copy.

- [ ] **Step 2: Run the focused contract test and verify RED**

  Run `bun test apps/electron/src/renderer/components/app-shell/CopisWorkingLoginPage.contract.test.ts`.

  Expected result: FAIL because the current dialog only renders the OAuth button and lacks the native form calls.

- [ ] **Step 3: Restore the minimal production implementation**

  Restore the component and stylesheet behavior from `4c6c19c0`, preserving the current file imports and callback props. Keep the existing full-page showcase and modal layout. The default view must be the login form; registration and password reset remain internal mode transitions.

- [ ] **Step 4: Run the focused contract test and verify GREEN**

  Run the same Bun test command and expect all assertions to pass.

- [ ] **Step 5: Run adjacent visual contract tests**

  Run `bun test apps/electron/src/renderer/components/app-shell/CopisWorkingLoginDialog.visual-contract.test.ts apps/electron/src/renderer/components/app-shell/CopisWorkingLoginPage.contract.test.ts` and confirm no existing layout contract regressed.

### Task 2: Validate the auth bridge and renderer bundle

**Files:**
- No production file changes expected.
- Test: `apps/electron/src/main/lib/working-api-client.test.ts`
- Test: `apps/electron/src/main/lib/working-oidc-client.test.ts`

**Interfaces:**
- Consumes: the restored renderer's existing IPC method names and the current Auth backend contract.
- Produces: evidence that legacy-looking form actions still use the new Auth-backed API and that OIDC refresh remains intact.

- [ ] **Step 1: Run Working API and OIDC tests**

  Run `bun test apps/electron/src/main/lib/working-api-client.test.ts apps/electron/src/main/lib/working-oidc-client.test.ts`.

- [ ] **Step 2: Run typecheck and renderer build**

  Run `bun run typecheck` and `bun run --filter='@copis/electron' build:renderer`.

- [ ] **Step 3: Review the diff and report UI confirmation status**

  Inspect `git diff --check` and the scoped diff. Confirm no credentials are exposed to renderer code. Report that the final in-app visual interaction must be confirmed by the user in the Electron window.
