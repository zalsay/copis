# OfficeCLI Error Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OfficeCLI release, checksum, and binary download failures expose enough HTTP and network context to diagnose proxy and GitHub API problems directly from the build log.

**Architecture:** Keep the existing three fetch call sites and add one local request helper in `scripts/prepare-officecli-module.ts`. The helper preserves each existing Chinese error prefix, reads bounded response diagnostics for non-2xx responses, and wraps thrown fetch errors with a redacted URL and cause details. Tests continue to exercise the real script in child processes against a local Bun HTTP server.

**Tech Stack:** Bun, TypeScript, `fetch`, Bun test, local `Bun.serve` fixtures.

## Global Constraints

- Do not change proxy environment-variable behavior, retry behavior, authentication, or download sources.
- Do not print proxy credentials or complete response headers.
- Keep response-body diagnostics bounded and single-line.
- Preserve successful download, cache reuse, and SHA256 validation behavior.
- Keep comments and logs in Chinese where comments or logs are needed.
- Do not modify `README.md`.

---

### Task 1: Add failing HTTP and network diagnostic scenarios

**Files:**
- Modify: `scripts/prepare-officecli-module.test.ts`
- Test target: `scripts/prepare-officecli-module.test.ts`

**Interfaces:**
- Consumes: the existing child-process fixture pattern and `COPIS_OFFICECLI_RELEASE_API` override.
- Produces: assertions that require URL, status, content type, GitHub rate-limit fields, response body, and network exception details.

- [ ] **Step 1: Add a release API 403 scenario**

Add a test that serves `/release` with status `403`, `content-type: application/json`, headers `x-ratelimit-limit: 60`, `x-ratelimit-remaining: 0`, `x-ratelimit-used: 60`, `x-ratelimit-reset: 1786934746`, and `x-github-request-id: test-request-id`, with body `{"message":"API rate limit exceeded"}`. Spawn the script with the local `/release` URL and assert the non-zero exit log contains:

```text
读取 OfficeCLI GitHub release 失败: HTTP 403
URL: <local release URL>
响应类型: application/json
GitHub rate limit: remaining=0/60, used=60, reset=1786934746
GitHub request id: test-request-id
响应体: {"message":"API rate limit exceeded"}
```

- [ ] **Step 2: Add a network exception scenario**

Use a local URL on an unused port, spawn the script with that URL, and assert the non-zero log contains the existing release error prefix, the URL, `请求异常:` and a fetch exception message. Do not assert a platform-specific `cause` string; assert only stable diagnostic labels and the URL.

- [ ] **Step 3: Run only the new scenarios to verify RED**

Run:

```bash
bun test scripts/prepare-officecli-module.test.ts
```

Expected: the new diagnostic assertions fail because current errors only contain the HTTP status or the generic fetch failure; existing tests may pass.

### Task 2: Implement shared detailed request errors

**Files:**
- Modify: `scripts/prepare-officecli-module.ts`
- Test: `scripts/prepare-officecli-module.test.ts`

**Interfaces:**
- Produces: a private `fetchWithDiagnostics(url: string, failurePrefix: string, init: RequestInit): Promise<Response>` helper used by `fetchGitHubRelease`, `fetchBinary`, and `fetchText`.
- Produces: bounded formatting helpers for response headers, response bodies, redacted URLs, and unknown thrown errors.

- [ ] **Step 1: Add bounded diagnostic constants and helpers**

Add a maximum response-body length of `2000` characters. Normalize the response body to one line, append an explicit truncation marker when needed, and display `(empty)` for an empty body. Redact URL username/password before printing it. Format `Error` values as `name: message` and include `cause` only as `name: message` when it is an `Error`.

- [ ] **Step 2: Implement non-2xx response formatting**

`fetchWithDiagnostics` should call `fetch` in a `try/catch`. On a thrown fetch error, throw an `Error` containing the supplied existing prefix, `请求异常:`, the redacted `URL:`, and formatted error details. On a non-OK response, read the body and throw an `Error` containing the supplied prefix plus `HTTP <status>`, `URL:`, `响应类型:` when available, `GitHub rate limit: remaining=<remaining>/<limit>, used=<used>, reset=<reset>` when any rate-limit headers exist, `Retry-After:` when present, `GitHub request id:` when present, and `响应体:`.

If reading a failed response body itself throws, include `响应体读取失败:` instead of masking the original HTTP status and URL.

- [ ] **Step 3: Route all three existing fetch call sites through the helper**

Use these unchanged failure prefixes:

```text
读取 OfficeCLI GitHub release 失败
下载 OfficeCLI 失败: <asset name>
下载 OfficeCLI 校验文件失败: <asset name>
```

Do not alter response parsing, checksum logic, cache behavior, or file writes.

- [ ] **Step 4: Run the focused test file to verify GREEN**

Run:

```bash
bun test scripts/prepare-officecli-module.test.ts
```

Expected: all existing and new scenarios pass.

### Task 3: Final verification and review

**Files:**
- Review: `scripts/prepare-officecli-module.ts`
- Review: `scripts/prepare-officecli-module.test.ts`

- [ ] **Step 1: Run type checking**

Run:

```bash
bun run typecheck
```

Expected: exit code `0` with no TypeScript errors caused by the change.

- [ ] **Step 2: Review the diff for scope and secret handling**

Run:

```bash
git diff --check
git diff -- scripts/prepare-officecli-module.ts scripts/prepare-officecli-module.test.ts
```

Confirm that no proxy URL, authorization header, or unbounded response body is printed, and that no unrelated files changed.

- [ ] **Step 3: Run the focused tests one final time**

Run:

```bash
bun test scripts/prepare-officecli-module.test.ts
```

Expected: all tests pass.
