# Browser Agent Pi Worker CDP Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Browser Agent 抽屉经 Rust/Pi Worker 运行时也能观察和受控操作当前 Copis 内部网页页签，并恢复停止录制后的 JSONL 总结链路。

**Architecture:** Browser/CDP、页面绑定、Origin 授权、敏感字段拒绝和高风险单次确认继续只存在于 Electron 主进程。每个 Pi Worker run 只获得一个短期、单 session/单 tab 的 opaque capability，并通过 Rust HTTP 服务转发到 Electron 内部处理器；Worker 绝不接收 `WebContents`、函数、全局内部令牌、CDP method 或任意脚本执行能力。页面工具与 Browser Workflow 工具的模型 schema 保持在 Worker，但最终动作必须由主进程的 allowlist dispatcher 执行。

**Tech Stack:** Bun、TypeScript、Electron `webContents.debugger`、Pi Agent SDK、Rust HTTP API bridge、Jotai 既有权限 UI、Bun test、Cargo test。

---

## Scope and non-goals

- 修复范围包括 `BrowserPageObserve`、`BrowserPageClick`、`BrowserPageType`、`BrowserPageSelect`、`BrowserPagePress`、`BrowserPageScroll`、`BrowserPageNavigate`，以及工具栏录制停止后实际需要的 `BrowserWorkflowRecordingGet` 和 `BrowserWorkflowDraft`。
- 同时通过同一个 allowlist 保留现有 `BrowserWorkflowRecord`、`BrowserWorkflowStop`、`BrowserWorkflowSave`、`BrowserWorkflowRepair`、`BrowserWorkflowList`、`BrowserWorkflowGet`、`BrowserWorkflowRun` 的 Worker 路径，避免系统 prompt 暴露出不存在的 Browser 工具。
- Browser 抽屉会话继续使用 Pi 的 `permissionMode: 'bypassPermissions'` 运行，不进入 `plan`；这是 Copis/Pi 的现有权限模式，不是 Claude 参数。网页写操作仍由 Header 的“询问/授权”和主进程单次确认控制。
- 不改 Renderer Drawer 的布局、Header、授权按钮、录制按钮或 IPC 契约；这次问题发生在 Renderer 发送消息之后。
- 不修改 `AGENTS.md` 或 `README.md`。若后续需要更改这两个文件，必须先取得用户许可。
- 不把网页截图当作验证依据。Electron 窗口中的 UI 与交互由用户最终确认。

## Current failure path

`WebBrowserSurface` 已通过 `bindBrowserAgentContext(sessionId, { tabId })` 绑定抽屉会话。旧的 `AgentOrchestrator` 会读取该绑定，向 `buildSystemPrompt()` 传入 `browserContext`，追加 `browser-page-control` Skill，并通过 `buildPiBuiltinTools()` 注册 Browser 工具。

当前实际发送路径为 `agent-service.ts -> agent-rpc-gateway.ts -> Rust /api/agent -> Pi Worker -> prepareAgentRpcRun()`。`prepareAgentRpcRun()` 当前既不读取 `getBrowserAgentContext()`，也不传 Browser prompt/Skill/工具；`pi-rpc-worker.ts` 只创建文件工具。因此模型没有 `BrowserPageObserve` schema，CDP 服务本身也从未被调用。

## File map

| File | Change | Responsibility |
| --- | --- | --- |
| `apps/electron/src/main/lib/agent-rpc-protocol.ts` | Modify | 定义可序列化的 Browser capability 和严格 request shape。 |
| `apps/electron/src/main/lib/browser-agent-worker-capability.ts` | Create | 生成、校验、撤销每个 session/tab/run 的 opaque token。 |
| `apps/electron/src/main/lib/browser-agent-tool-service.ts` | Create | Electron 主进程的 Browser 工具 allowlist、既有策略复用与单次确认。 |
| `apps/electron/src/main/lib/browser-workflow-service.ts` | Modify | 解绑或更换 tab 时立即撤销 capability。 |
| `apps/electron/src/main/lib/http-api-handler.ts` | Modify | 接收 Worker 的内部 Browser tool request 并交给主进程 service。 |
| `apps/electron/src/main/lib/agent-rpc-service.ts` | Modify | 在 prepare/queue/finalize 中恢复 Browser context、权限、Skill 和 capability 生命周期。 |
| `apps/electron/src/main/lib/adapters/pi-browser-agent-tools.ts` | Create | Pi Worker 中的 Browser 工具 schema 与受限 HTTP client。 |
| `apps/electron/src/main/lib/adapters/pi-agent-adapter.ts` | Modify | Browser capability 存在时注册 Worker Browser tools。 |
| `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts` | Modify | 改为复用主进程 Browser tool service，保持旧直连 Agent 路径的同一安全语义。 |
| `apps/electron/src/main/pi-rpc-worker.ts` | Modify | 只将已序列化的 capability 传给 adapter；不创建 Electron/CDP 依赖。 |
| `apps/electron/package.json` | Modify | 按仓库规则将 `@copis/electron` patch 从 `0.0.24` 升至 `0.0.25`。 |

测试文件在各任务的 **Files** 小节中逐一列出；不新增未列出的测试路径。

### Task 1: Define the opaque capability protocol and its lifetime

**Files:**
- Modify: `apps/electron/src/main/lib/agent-rpc-protocol.ts`
- Modify: `apps/electron/src/main/lib/agent-rpc-protocol.test.ts`
- Create: `apps/electron/src/main/lib/browser-agent-worker-capability.ts`
- Create: `apps/electron/src/main/lib/browser-agent-worker-capability.test.ts`
- Modify: `apps/electron/src/main/lib/browser-workflow-service.ts`
- Modify: `apps/electron/src/main/lib/browser-workflow-service.test.ts`

- [x] **Step 1: Write protocol and lifetime tests before implementation.**

Add cases that serialize a Browser run config, reject a malformed tool request, reject a wrong token/session/tab, and prove that unbind or rebinding from `tab-1` to `tab-2` invalidates the old token.

```ts
expect(parseBrowserAgentToolRequest({
  sessionId: 'session-1',
  capabilityToken: 'token-1',
  toolCallId: 'call-1',
  toolName: 'BrowserPageObserve',
  toolInput: {},
})).toEqual({
  sessionId: 'session-1',
  capabilityToken: 'token-1',
  toolCallId: 'call-1',
  toolName: 'BrowserPageObserve',
  toolInput: {},
})

expect(parseBrowserAgentToolRequest({
  sessionId: 'session-1',
  capabilityToken: 'token-1',
  toolCallId: 'call-1',
  toolName: 'Runtime.evaluate',
  toolInput: { expression: 'document.cookie' },
})).toBeUndefined()
```

- [x] **Step 2: Run the focused tests and confirm the missing symbols fail.**

Run: `bun test apps/electron/src/main/lib/agent-rpc-protocol.test.ts apps/electron/src/main/lib/browser-agent-worker-capability.test.ts`

Expected: FAIL because the Browser capability/request symbols do not exist yet.

- [x] **Step 3: Add serializable protocol types and a process-local capability store.**

In `agent-rpc-protocol.ts`, introduce only opaque transport data. Do not include a URL, Origin authorization decision, CDP command, selector, JavaScript expression, `WebContents`, or callback.

```ts
export const BROWSER_AGENT_TOOL_NAMES = [
  'BrowserPageObserve', 'BrowserPageClick', 'BrowserPageType',
  'BrowserPageSelect', 'BrowserPagePress', 'BrowserPageScroll',
  'BrowserPageNavigate', 'BrowserWorkflowRecord',
  'BrowserWorkflowRecordingGet', 'BrowserWorkflowDraft',
  'BrowserWorkflowSave', 'BrowserWorkflowRepair',
  'BrowserWorkflowList', 'BrowserWorkflowGet', 'BrowserWorkflowRun',
  'BrowserWorkflowStop',
] as const

export type BrowserAgentToolName = (typeof BROWSER_AGENT_TOOL_NAMES)[number]

export interface PiWorkerBrowserCapability {
  endpoint: '/api/internal/agent/browser-tool'
  token: string
}

export interface BrowserAgentToolRequest {
  sessionId: string
  capabilityToken: string
  toolCallId: string
  toolName: BrowserAgentToolName
  toolInput: Record<string, unknown>
}
```

Add `browserPageControl?: PiWorkerBrowserCapability` to `PiWorkerQueryConfig`. The parser must accept only the fixed endpoint, nonblank bounded strings, an allowlisted tool name, and a plain-object `toolInput`.

In the new store, use `randomBytes(32).toString('base64url')` and `timingSafeEqual` after equal-length validation. Retain `{ sessionId, tabId, token, triggeredBy, expiresAt }` only in Electron memory. Set `expiresAt` to `Date.now() + 30 * 60_000`, and revoke earlier during run finalization, unbind, tab replacement or capability mismatch. Expose:

```ts
issueBrowserAgentWorkerCapability(input: {
  sessionId: string
  tabId: string
  triggeredBy: 'user' | 'automation' | 'delegation'
}): PiWorkerBrowserCapability

assertBrowserAgentWorkerCapability(input: {
  sessionId: string
  tabId: string
  token: string
}): { triggeredBy: 'user' | 'automation' | 'delegation' }

revokeBrowserAgentWorkerCapability(sessionId: string): void
```

- [x] **Step 4: Revoke stale authority at the binding boundary.**

Call `revokeBrowserAgentWorkerCapability(sessionId)` before replacing an existing binding with a different `tabId`, and at the beginning of `unbindBrowserAgentContext()`. Keep same-tab rebinds valid only until the active Worker run completes.

- [x] **Step 5: Run the capability tests.**

Run: `bun test apps/electron/src/main/lib/agent-rpc-protocol.test.ts apps/electron/src/main/lib/browser-agent-worker-capability.test.ts apps/electron/src/main/lib/browser-workflow-service.test.ts`

Expected: PASS. The serialized Worker command retains only `{ endpoint, token }`; stale, cross-session and cross-tab tokens are denied.

### Task 2: Centralize main-process Browser tool execution

**Files:**
- Create: `apps/electron/src/main/lib/browser-agent-tool-service.ts`
- Create: `apps/electron/src/main/lib/browser-agent-tool-service.test.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts`

- [x] **Step 1: Write the failing dispatcher tests.**

Use dependency injection around `browserPageControl`, `browser-workflow-service`, `browser-workflow-runner`, `permissionService`, and `agentEventBus`. Cover the exact security behavior below.

```ts
await expect(service.executeWorker({
  sessionId: 'browser-session',
  capabilityToken: 'wrong-token',
  toolCallId: 'call-1',
  toolName: 'BrowserPageObserve',
  toolInput: {},
})).rejects.toMatchObject({ code: 'browser_capability_invalid' })

await expect(service.executeWorker({
  sessionId: 'browser-session',
  capabilityToken: validToken,
  toolCallId: 'call-2',
  toolName: 'BrowserPageClick',
  toolInput: { ref: 'e-danger' },
})).resolves.toEqual(expect.objectContaining({ kind: 'json' }))
expect(requestSingleApproval).toHaveBeenCalledWith(
  'browser-session', 'BrowserPageClick', expect.any(Object), expect.any(Object), expect.any(Function),
)
```

Also assert: ask-mode mutation is rejected; sensitive fields never reach `typeText`; cross-Origin navigation waits for approval; a `BrowserWorkflowRecordingGet` response is marked untrusted; automation/delegation cannot invoke user-only record/draft/save actions.

- [x] **Step 2: Run the new service test and verify it fails.**

Run: `bun test apps/electron/src/main/lib/browser-agent-tool-service.test.ts`

Expected: FAIL because the Browser tool dispatcher does not exist.

- [x] **Step 3: Implement an exhaustive Browser tool allowlist in the Electron main process.**

Create one service with this public boundary:

```ts
export interface BrowserAgentToolResult {
  kind: 'json' | 'text'
  value: unknown
}

export interface BrowserAgentToolService {
  executeWorker(input: BrowserAgentToolRequest): Promise<BrowserAgentToolResult>
  executeDirect(input: {
    sessionId: string
    toolCallId: string
    toolName: BrowserAgentToolName
    toolInput: Record<string, unknown>
    requestSingleApproval: PiBuiltinToolsContext['requestSingleApproval']
    triggeredBy?: 'user' | 'automation' | 'delegation'
  }): Promise<BrowserAgentToolResult>
}
```

`executeWorker()` first validates the opaque token, expiry, session and bound `tabId`; `executeDirect()` is used only by the legacy in-process Pi adapter and does not accept a token from a model. Both methods then load `getBrowserAgentContext(sessionId)` and invoke only the existing high-level APIs:

- `browserPageControl.observe/click/typeText/select/press/scroll/navigate`
- `startBrowserWorkflowRecording`, `stopBrowserWorkflowRecording`, `getBrowserWorkflowRecording`, `getBrowserWorkflowDraft`, `submitBrowserWorkflowDraft`, `approveBrowserWorkflowDraft`, `submitBrowserWorkflowRepairDraft`, `listBrowserWorkflows`, `getBrowserWorkflow`
- `runBrowserWorkflow` and `stopBrowserWorkflowRun`

For page mutations, preserve the current `pi-builtin-tools.ts` order exactly: evaluate ask/authorized mode, fetch the last observed element if needed, identify high-risk click/select/key/navigation, request a non-whitelistable `permissionService.requestSingleApproval()`, emit the resulting `permission_request` through `agentEventBus`, then execute the existing page-control method. Return `kind: 'json'` for snapshots/action results and wrap recording JSONL as the existing untrusted Browser result. There must be no default switch case that runs an unknown action.

- [x] **Step 4: Make the legacy direct Agent path use the same executor.**

Keep `buildBrowserPageControlTools()` and `buildBrowserWorkflowTools()` as the direct Pi schema registrations, but replace their duplicated side-effect bodies with calls to `browserAgentToolService.executeDirect()` through a trusted in-process adapter. The direct path supplies `requestSingleApproval` as a callback, not an opaque token; it must retain the same event behavior and tool labels/descriptions.

- [x] **Step 5: Run service and legacy regression tests.**

Run: `bun test apps/electron/src/main/lib/browser-agent-tool-service.test.ts apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts apps/electron/src/main/lib/browser-page-control-service.test.ts apps/electron/src/main/lib/browser-page-control-policy.test.ts`

Expected: PASS. The old direct adapter and the new dispatcher yield the same authorization, sensitive-field, high-risk and untrusted-data behavior.

### Task 3: Add the Worker-to-Electron internal HTTP bridge

**Files:**
- Modify: `apps/electron/src/main/lib/http-api-handler.ts`
- Modify: `apps/electron/src/main/lib/http-api-server.test.ts`
- Create: `apps/electron/src/main/lib/browser-agent-tool-http.test.ts`

- [x] **Step 1: Write HTTP contract tests.**

Inject a fake `getBrowserAgentToolApi` dependency and prove that only a POST body with the exact request contract reaches it.

```ts
const response = await handleHttpApiRequest({
  method: 'POST',
  path: '/api/internal/agent/browser-tool',
  body: JSON.stringify({
    sessionId: 'session-1', capabilityToken: 'capability',
    toolCallId: 'call-1', toolName: 'BrowserPageObserve', toolInput: {},
  }),
}, dependencies)

expect(response).toEqual({ status: 200, body: { kind: 'json', value: { kind: 'untrusted_browser_page' } } })
```

Assert a GET returns `405`, malformed JSON returns `400`, a non-allowlisted action returns `400`, and a bad/stale capability maps to `403` without revealing the actual token.

- [x] **Step 2: Run the HTTP tests and confirm the route is absent.**

Run: `bun test apps/electron/src/main/lib/http-api-server.test.ts apps/electron/src/main/lib/browser-agent-tool-http.test.ts`

Expected: FAIL because `/api/internal/agent/browser-tool` is not implemented.

- [x] **Step 3: Add the thin internal action route.**

Extend `HttpApiDependencies` with an optional `getBrowserAgentToolApi`, resolving the production singleton lazily like `getDefaultAgentApi()`. The injected API is the narrow service boundary, not the whole Browser workflow module:

```ts
export interface BrowserAgentToolHttpApi {
  executeWorker(input: BrowserAgentToolRequest): Promise<BrowserAgentToolResult>
}

export interface HttpApiDependencies {
  // existing dependencies...
  getBrowserAgentToolApi?: () => BrowserAgentToolHttpApi | Promise<BrowserAgentToolHttpApi>
}
```

In `handleAgentRpcInternalRequest()`, add only this action:

```ts
if (action === 'browser-tool') {
  const input = parseBrowserAgentToolRequest(bodyRecord)
  if (!input) throw new HttpApiRequestError('Browser Agent 工具参数不正确', 400, 'invalid_browser_tool_request')
  return { status: 200, body: await (await getBrowserAgentToolApi(dependencies)).executeWorker(input) }
}
```

Map capability validation errors to `403` (`browser_capability_invalid` or `browser_capability_stale`) and page-policy refusal to `409`; retain the existing `sendError()` shape. The request carries the scoped token in its JSON body because the Rust bridge protocol transports method/path/body, not arbitrary headers. Do not add `X-Copis-Internal-Token` to the Worker environment and do not add a browser route to Rust's privileged `internal agent files` handler: unknown non-file internal Agent routes already reach Electron's bridge.

- [x] **Step 4: Run the bridge tests.**

Run: `bun test apps/electron/src/main/lib/http-api-server.test.ts apps/electron/src/main/lib/browser-agent-tool-http.test.ts`

Expected: PASS. The endpoint is an allowlisted bridge and neither accepts arbitrary CDP nor exposes a global administrative token.

### Task 4: Restore Browser context, permission mode, prompt and Skill during RPC preparation

**Files:**
- Modify: `apps/electron/src/main/lib/agent-rpc-service.ts`
- Modify: `apps/electron/src/main/lib/agent-rpc-service.test.ts`
- Modify: `apps/electron/src/main/lib/browser-agent-skill.test.ts`
- Modify: `apps/electron/src/main/lib/agent-rpc-protocol.test.ts`

- [x] **Step 1: Add failing Browser RPC preparation tests.**

Mock `getBrowserAgentContext()` with `{ tabId: 'tab-1' }`, `getWebTabState()` with an HTTP(S) tab, and the capability issuer. Assert that a Browser run has the prompt context, `bypassPermissions`, the `browser-page-control` Skill, and a capability. Assert a normal workspace session has none of them.

```ts
const run = await prepareAgentRpcRun({
  sessionId: 'session-1', userMessage: '这个页面是什么？',
  channelId: 'channel-1', modelId: 'model-1', agentRuntime: 'pi',
  permissionModeOverride: 'plan',
})

expect(run.query.permissionMode).toBe('bypassPermissions')
expect(run.query.skillMentions).toContain('browser-page-control')
expect(run.query.systemPrompt).toContain('tab-1')
expect(run.query.browserPageControl).toEqual({
  endpoint: '/api/internal/agent/browser-tool', token: expect.any(String),
})
```

Add a queue test that starts a Browser run, calls `prepareAgentRpcQueue()` with no explicit Skill mention, and expects `browser-page-control` in the queue config. Add finalization coverage proving the capability is revoked after `finalizeAgentRpcRun()`.

- [x] **Step 2: Run the preparation test and confirm the current regression.**

Run: `bun test apps/electron/src/main/lib/agent-rpc-service.test.ts`

Expected: FAIL: current Worker query has neither `browserPageControl` nor Browser system prompt/Skill.

- [x] **Step 3: Implement Browser-aware run preparation.**

Immediately after loading the session/workspace, resolve the Browser binding and current tab. The effective values must be calculated once and used consistently:

```ts
const browserBinding = getBrowserAgentContext(input.sessionId)
const browserTab = browserBinding ? getWebTabState(browserBinding.tabId) : undefined
const hasBrowserContext = Boolean(browserBinding && browserTab)
const effectivePermissionMode = resolveBrowserAgentPermissionMode(
  hasBrowserContext,
  input.permissionModeOverride ?? session.permissionMode ?? COPIS_DEFAULT_PERMISSION_MODE,
)
const effectiveSkillMentions = resolveBrowserAgentSkillMentions(
  input.mentionedSkills,
  hasBrowserContext,
)
const browserPageControl = hasBrowserContext
  ? issueBrowserAgentWorkerCapability({
      sessionId: input.sessionId,
      tabId: browserBinding!.tabId,
      triggeredBy: input.triggeredBy ?? 'user',
    })
  : undefined
```

Pass `{ tabId, title: browserTab.title, url: browserTab.url }` to `buildSystemPrompt()`, use `effectivePermissionMode` for the Rust file policy and `query.permissionMode`, set `query.skillMentions` to `effectiveSkillMentions`, and set `query.browserPageControl` only when issued. `prepareAgentRpcQueue()` must call `resolveBrowserAgentSkillMentions()` against the current binding so an in-flight Browser conversation retains the control Skill on every queued or interrupted message. `finalizeAgentRpcRun()` must revoke the capability in both normal and missing-session cleanup paths.

- [x] **Step 4: Run focused RPC preparation tests.**

Run: `bun test apps/electron/src/main/lib/agent-rpc-service.test.ts apps/electron/src/main/lib/browser-agent-skill.test.ts apps/electron/src/main/lib/agent-rpc-protocol.test.ts`

Expected: PASS. Browser sessions cannot fall back to `plan`, and normal Agent sessions remain unchanged.

### Task 5: Register serializable Browser tools inside Pi Worker

**Files:**
- Create: `apps/electron/src/main/lib/adapters/pi-browser-agent-tools.ts`
- Create: `apps/electron/src/main/lib/adapters/pi-browser-agent-tools.test.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-agent-adapter.ts`
- Modify: `apps/electron/src/main/pi-rpc-worker.ts`

- [x] **Step 1: Write worker tool client tests.**

Use a fake `fetch` and fake Pi SDK `defineTool()` collector. Verify `BrowserPageObserve` posts exactly the opaque request body to the fixed endpoint, all 16 allowlisted tool definitions are registered only when a capability exists, and neither a query config nor a request contains a CDP method, JavaScript expression, Origin authorization value, file roots, or internal token.

```ts
expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
  sessionId: 'session-1',
  capabilityToken: 'capability-1',
  toolCallId: 'tool-call-1',
  toolName: 'BrowserPageObserve',
  toolInput: {},
})
expect(new URL(String(requests[0]?.url)).pathname).toBe('/api/internal/agent/browser-tool')
```

- [x] **Step 2: Run the worker tool tests and confirm they fail.**

Run: `bun test apps/electron/src/main/lib/adapters/pi-browser-agent-tools.test.ts`

Expected: FAIL because Pi Worker has no Browser tool factory.

- [x] **Step 3: Implement `pi-browser-agent-tools.ts`.**

Build the same fixed schemas, labels, descriptions and prompt snippets that the direct path already exposes. Each `execute(toolCallId, params, signal)` calls one client method:

```ts
await fetch(`${baseUrl}/api/internal/agent/browser-tool`, {
  method: 'POST', signal,
  headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  body: JSON.stringify({
    sessionId, capabilityToken: capability.token,
    toolCallId, toolName, toolInput: params as Record<string, unknown>,
  }),
})
```

The client converts `{ kind: 'json', value }` and `{ kind: 'text', value }` back into the Pi tool-result format. It must surface `error` and `code` returned by the bridge, rather than silently treating denial as success. It must not use `eval`, `webContents`, `debugger`, `COPIS_HTTP_API_INTERNAL_TOKEN`, or the Rust file token.

- [x] **Step 4: Wire the factory into the Worker adapter.**

Extend `PiAgentQueryOptions` with `browserPageControl?: PiWorkerBrowserCapability`. Extend `buildBuiltinToolDefinitions()` to receive that field and append `buildPiBrowserAgentTools()` only when present. Preserve `session.agent.toolExecution = 'sequential'`; that ensures a fresh observation/action sequence cannot run in parallel. In `pi-rpc-worker.ts`, continue spreading the serialized query only; add a fatal guard if a Browser capability is malformed, but do not import Electron or main-process Browser services.

- [x] **Step 5: Run worker-level tests.**

Run: `bun test apps/electron/src/main/lib/adapters/pi-browser-agent-tools.test.ts apps/electron/src/main/lib/adapters/pi-rust-file-tools.test.ts apps/electron/src/main/lib/agent-rpc-protocol.test.ts`

Expected: PASS. Browser tools are available only to bound Browser sessions and use the scoped bridge request shape.

### Task 6: Exercise the complete regression path and preserve security boundaries

**Files:**
- Modify: `apps/electron/src/main/lib/agent-rpc-service.test.ts`
- Modify: `apps/electron/src/main/lib/browser-agent-tool-service.test.ts`
- Modify: `apps/electron/src/main/lib/http-api-server.test.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-browser-agent-tools.test.ts`
- Modify: `apps/electron/package.json`

- [x] **Step 1: Add the end-to-end unit-level BDD regression.**

Drive the three local boundaries with fakes: `prepareAgentRpcRun()` emits a Browser capability, the Worker tool client calls the internal endpoint, and the endpoint dispatcher calls `browserPageControl.observe()`. Assert the result contains `kind: 'untrusted_browser_page'` and the final model-facing tool result is page data, not generic workspace text.

```text
Given Browser Agent session session-1 is bound to HTTP(S) tab tab-1
When the user asks “这个页面是什么” through the Pi Worker route
Then the Worker registers and calls BrowserPageObserve
And Electron dispatches Runtime.evaluate only through browserPageControl.observe
And the model receives the untrusted page snapshot before forming its answer
```

Add negative BDD cases for: no binding; a stale capability after tab change; ask mode click/type/select/press/scroll/navigate; password/OTP/payment/file/Captcha/secret fields; delete/submit/send/Enter/cross-Origin navigation single approval; and queue messages retaining `browser-page-control`.

- [x] **Step 2: Run all focused checks.**

Run:

```bash
bun test apps/electron/src/main/lib/agent-rpc-protocol.test.ts
bun test apps/electron/src/main/lib/browser-agent-worker-capability.test.ts
bun test apps/electron/src/main/lib/browser-agent-tool-service.test.ts
bun test apps/electron/src/main/lib/browser-agent-tool-http.test.ts
bun test apps/electron/src/main/lib/agent-rpc-service.test.ts
bun test apps/electron/src/main/lib/adapters/pi-browser-agent-tools.test.ts
bun test apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts
bun test apps/electron/src/main/lib/browser-page-control-policy.test.ts
bun test apps/electron/src/main/lib/browser-page-control-service.test.ts
bun test apps/electron/src/main/lib/browser-workflow-service.test.ts
bun test apps/electron/src/main/lib/http-api-server.test.ts
cd native/http-api-server && cargo test
```

Expected: all commands PASS. The Rust test proves the existing bridge and Worker process boundary remains compatible; this plan does not broaden Rust's privileged file endpoint.

- [x] **Step 3: Typecheck and build each changed runtime boundary.**

Run:

```bash
bun run typecheck
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:preload
bun run --filter='@copis/electron' build:agent-rpc-worker
bun run --filter='@copis/electron' build:renderer
git diff --check
```

Expected: all commands exit `0`. The preload/renderer builds are regression checks only; this plan makes no Renderer or preload source edit.

- [x] **Step 4: Bump the affected package version and inspect the final diff.**

Change `apps/electron/package.json` from `"version": "0.0.24"` to `"version": "0.0.25"`. Inspect that the diff is limited to the Browser Worker bridge, tests, and this package version. Confirm no capability token, API key, page secret, recording value, generated output or unrelated user change is staged.

- [ ] **Step 5: Obtain user acceptance in the real Electron window.**

Start the existing development application, let the user perform these checks in a normal HTTP(S) `WebContentsView`, and record their result without screenshots:

1. Open the Copis drawer and ask “这个页面是什么”；the tool activity shows `BrowserPageObserve`, and the reply uses the visible page rather than generic Copis content.
2. In `询问` mode, ask for a page mutation; it is refused. Switch Header to `授权`; ordinary safe page actions work, while a submit/delete/send/Enter or cross-Origin navigation requests a one-time confirmation.
3. Start and stop a recording through the existing UI; the follow-up Agent message reads the Rust JSONL and produces a draft, not a direct save.
4. Switch the bound tab or navigate cross-Origin during an active run; the stale capability is refused and authorization returns to `询问`.

The implementing agent may inspect logs, tests and process state, but must not use screenshots or screenshot comparison in place of this user confirmation.

- [ ] **Step 6: Commit the scoped implementation after approval.**

```bash
git add apps/electron/package.json \
  apps/electron/src/main/lib/agent-rpc-protocol.ts \
  apps/electron/src/main/lib/agent-rpc-protocol.test.ts \
  apps/electron/src/main/lib/agent-rpc-service.ts \
  apps/electron/src/main/lib/agent-rpc-service.test.ts \
  apps/electron/src/main/lib/browser-agent-worker-capability.ts \
  apps/electron/src/main/lib/browser-agent-worker-capability.test.ts \
  apps/electron/src/main/lib/browser-agent-tool-service.ts \
  apps/electron/src/main/lib/browser-agent-tool-service.test.ts \
  apps/electron/src/main/lib/browser-agent-tool-http.test.ts \
  apps/electron/src/main/lib/browser-workflow-service.ts \
  apps/electron/src/main/lib/browser-workflow-service.test.ts \
  apps/electron/src/main/lib/http-api-handler.ts \
  apps/electron/src/main/lib/http-api-server.test.ts \
  apps/electron/src/main/lib/adapters/pi-browser-agent-tools.ts \
  apps/electron/src/main/lib/adapters/pi-browser-agent-tools.test.ts \
  apps/electron/src/main/lib/adapters/pi-agent-adapter.ts \
  apps/electron/src/main/lib/adapters/pi-builtin-tools.ts \
  apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts \
  apps/electron/src/main/pi-rpc-worker.ts \
  docs/superpowers/plans/2026-08-07-browser-agent-pi-worker-cdp-bridge.md
git commit -m "fix: bridge browser agent tools through pi worker"
```

Expected: one reviewable commit containing only the approved fix and its verification coverage. Do not push unless separately requested.

## Review checklist

- The only Worker authority is a random, short-lived session/tab capability. It is neither the Rust file token nor `COPIS_HTTP_API_INTERNAL_TOKEN`.
- A Worker cannot use the bridge for arbitrary CDP, JavaScript evaluation, other sessions or a replaced tab.
- Browser tool execution reuses the main-process page-control policy; `ask` remains read-only, sensitive values remain inaccessible, and high-impact actions are per-action confirmed.
- `browser-page-control` is loaded for initial, queued, interrupted and restored Browser conversation messages; non-Browser Agents receive no capability, prompt section, extra Skill or Browser tool.
- The existing Rust generic bridge is used without expanding Rust's privileged internal-file route.
- No UI acceptance is claimed until the user has confirmed it in the Electron app window.
