# Browser Workflow 草稿审核条 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Browser Agent 的 Workflow 草稿审核条精简为 URL、步骤数、无人值守开关和确认操作。

**Architecture:** 仅修改 Renderer 的 `BrowserAgentPanel`。审批 IPC 已接收 `unattendedAllowed`，因此组件在草稿审核开始时将本地开关初始化为 `true`，并将该值原样传给现有审批调用；拒绝操作继续走既有 IPC。

**Tech Stack:** React 18、TypeScript、Jotai、Tailwind CSS、Bun Test。

## Global Constraints

- 仅调整 `awaiting_review` 的展示与组件契约测试，不修改草稿、审批 IPC、持久化和录制目录。
- 所有用户可见文案使用中文；注释和日志保持中文。
- 勾选状态必须使用 `var(--ui-primary)`，不引入新主题 token 或依赖。
- 在当前 `main` 工作区直接修改，不创建提交。
- Electron UI 的最终交互与视觉由用户在实际应用窗口确认；自动化验证不使用截图替代。

---

### Task 1: 更新 Workflow 草稿审核条

**Files:**
- Modify: `apps/electron/src/renderer/components/web-browser/BrowserAgentPanel.test.ts`
- Modify: `apps/electron/src/renderer/components/web-browser/BrowserAgentPanel.tsx`

**Interfaces:**
- Consumes: `BrowserWorkflowVersion.start.url`、`BrowserWorkflowVersion.steps.length`，以及现有 `approveDraft(sessionId, name, description, unattendedAllowed)` 和 `rejectDraft(sessionId)` IPC。
- Produces: 精简的审核提示条；确认时继续将布尔值传给已有审批 IPC。

- [x] **Step 1: 写入失败的组件契约测试**

在 `BrowserAgentPanel.test.ts` 新增以下 BDD 测试，断言目标文案、仅保留步骤数、默认无人值守和主题色，并排除已删除的草稿明细：

```ts
test('Given Workflow 草稿待审核 When 渲染审核条 Then 仅显示 URL、步骤数和确认操作', () => {
  expect(source).toContain('{draft.start.url}自动化流程草稿')
  expect(source).toContain('{draft.steps.length} 步')
  expect(source).toContain('useState(true)')
  expect(source).toContain('setUnattendedAllowed(true)')
  expect(source).toContain('accent-[var(--ui-primary)]')
  expect(source).toContain('取消（不做更新）')
  expect(source).toContain('确认（更新为确认后版本）')
  expect(source).not.toContain('draft.variables.length')
  expect(source).not.toContain('draftOrigins(draft)')
  expect(source).not.toContain("step.type === 'manual'")
})
```

- [x] **Step 2: 运行测试并确认它因旧审核条而失败**

Run: `bun test apps/electron/src/renderer/components/web-browser/BrowserAgentPanel.test.ts`

Expected: FAIL，因为旧组件使用 `useState(false)`、`Workflow 草稿待审核`、变量数、Origin 和步骤明细，且没有新操作文案或 `ui-primary` 勾选色。

- [x] **Step 3: 最小化修改审核条实现**

在 `BrowserAgentPanel.tsx`：

```tsx
const [unattendedAllowed, setUnattendedAllowed] = React.useState(true)

<div className="flex items-center justify-between gap-2 font-medium">
  <span className="min-w-0 truncate">{draft.start.url}自动化流程草稿</span>
  <span className="shrink-0">{draft.steps.length} 步</span>
</div>
```

删除 `draftOrigins`、变量数、Origin 和步骤列表；在 `sessionId` 更新与 `awaiting_review` 草稿加载开始时将无人值守状态重置为 `true`。给原生复选框加入 `accent-[var(--ui-primary)]`，并将两个按钮的可见文案改为“取消（不做更新）”和“确认（更新为确认后版本）”，但保留现有回调。

- [x] **Step 4: 运行组件测试确认通过**

Run: `bun test apps/electron/src/renderer/components/web-browser/BrowserAgentPanel.test.ts`

Expected: PASS，包含既有头部项目切换契约和新增审核条契约。

- [x] **Step 5: 验证 Renderer 可构建**

Run: `bun run --filter='@copis/electron' build:renderer`

Expected: PASS，Vite 成功产出 Renderer 构建，无 TypeScript 或 Tailwind class 解析错误。

- [x] **Step 6: 复核改动范围**

Run: `git diff --check -- apps/electron/src/renderer/components/web-browser/BrowserAgentPanel.tsx apps/electron/src/renderer/components/web-browser/BrowserAgentPanel.test.ts`

Expected: PASS，无空白错误；差异仅包含审核条状态、文案、展示和测试契约。
