# Browser Agent Current Page Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Copis 右侧 Browser Agent 抽屉通过对话观察并在授权后操作当前内部网页页签。

**Architecture:** Browser 专属授权由 Electron 主进程按 session 和 Origin 强制执行。Renderer 只展示 Header 分段按钮并调用高层授权 IPC；Pi 工具调用受限页面控制服务，所有 CDP 仍封装在主进程内部。

**Tech Stack:** Bun、TypeScript、Electron `webContents.debugger`、React、Jotai、Pi Agent custom tools、Bun test。

---

### Task 1: 授权状态契约

**Files:**
- Modify: `packages/shared/src/types/browser-workflow.ts`
- Create: `apps/electron/src/main/lib/browser-page-control-policy.ts`
- Create: `apps/electron/src/main/lib/browser-page-control-policy.test.ts`

- [x] 先写测试，声明默认`ask`、同 Origin 授权和跨 Origin 撤权行为。
- [x] 运行测试并确认因实现缺失而失败。
- [x] 实现纯策略函数与共享类型。
- [x] 运行测试并确认通过。

### Task 2: 当前页面高层控制服务

**Files:**
- Create: `apps/electron/src/main/lib/browser-page-control-service.ts`
- Create: `apps/electron/src/main/lib/browser-page-control-service.test.ts`
- Modify: `apps/electron/src/main/lib/web-tab-manager.ts`

- [x] 先写观察结果脱敏、敏感字段拒绝和高风险动作分类测试。
- [x] 运行测试并确认失败原因正确。
- [x] 实现高层 observe/click/type/select/press/scroll/navigate API，并只在内部调用 CDP。
- [x] 运行策略和服务测试。

### Task 3: IPC 与 Pi Browser 工具

**Files:**
- Modify: `packages/shared/src/types/browser-workflow.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/preload/index.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts`
- Modify: `apps/electron/src/main/lib/agent-prompt-builder.ts`

- [x] 先扩展共享 IPC 契约测试并确认失败。
- [x] 增加授权模式 get/set 高层 IPC，保持 CDP 不可见。
- [x] 注册页面观察与操作 Pi 工具，页面内容标记为 untrusted。
- [x] 为高风险动作接入现有单次权限请求，敏感输入直接拒绝。
- [x] 更新 Browser Agent 系统提示词。

### Task 4: 抽屉 Header

**Files:**
- Create: `apps/electron/src/renderer/components/web-browser/browser-agent-header-policy.ts`
- Create: `apps/electron/src/renderer/components/web-browser/browser-agent-header-policy.test.ts`
- Modify: `apps/electron/src/renderer/components/web-browser/BrowserAgentPanel.tsx`
- Modify: `apps/electron/src/renderer/components/agent/AgentConversationSurface.tsx`

- [x] 先写 Header 模式与跨 Origin 展示逻辑测试并确认失败。
- [x] 实现`询问 | 授权`分段按钮、域名状态和现有控制按钮重排。
- [x] Browser variant 隐藏通用 `PermissionModeSelector`。
- [x] 运行组件逻辑测试和 renderer build。

### Task 5: 集成验证

**Files:**
- Modify: `apps/electron/scripts/browser-workflow-e2e-main.ts`
- Modify: `apps/electron/scripts/browser-workflow-e2e.ts`

- [x] 扩展 E2E：询问模式观察成功、写操作拒绝、授权后交互成功、跨 Origin 自动撤权。
- [x] 运行 Browser Workflow E2E。
- [x] 运行 focused tests、shared/electron typecheck 和 main/preload/renderer builds。
- [x] 在 Electron 实际窗口检查 Header、页面控制和权限横幅。
- [x] 检查 diff、日志、注释、敏感数据和 `git diff --check`；不提交未获授权的改动。
