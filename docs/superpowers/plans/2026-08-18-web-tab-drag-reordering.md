# Web Tab Drag Reordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让内嵌浏览器网页 Tab 支持拖动排序，拖动结束后激活被拖动 Tab，并持久化新的顺序。

**Architecture:** renderer 使用 Pointer Events 负责拖动手势、插入位置提示和防止拖动后的 click 误激活；主进程通过新增 `web-tabs:reorder` IPC 作为公开 Tab 顺序的唯一来源，完成重排、激活、持久化和状态广播。排序计算拆成无副作用纯函数，主进程和 renderer 测试分别保护业务状态与交互边界。

**Tech Stack:** Bun test, TypeScript, React, Jotai, Electron IPC, `WebContentsView`。

## Global Constraints

- 不新增第三方拖拽依赖；使用 Pointer Events。
- 状态管理继续使用 Jotai；网页 Tab 的真实顺序继续由主进程维护。
- 注释和日志优先采用中文。
- 遵守 Electron UI 最终由用户在实际应用窗口确认，Agent 不使用截图代替验收。
- 不修改 `AGENTS.md` 或 `README.md`，因为本次未获得文档同步授权。
- 遵守 BDD/TDD：每个行为先写失败测试并确认失败，再写最小实现。

---

### Task 1: 提取并测试网页 Tab 顺序移动逻辑

**Files:**
- Create: `apps/electron/src/main/lib/web-tab-order.ts`
- Create: `apps/electron/src/main/lib/web-tab-order.test.ts`
- Modify: `apps/electron/src/renderer/components/web-browser/WebTabBar.tsx`
- Create: `apps/electron/src/renderer/components/web-browser/web-tab-drag.ts`
- Create: `apps/electron/src/renderer/components/web-browser/web-tab-drag.test.ts`

**Interfaces:**
- `moveWebTab<T>(items: readonly T[], fromIndex: number, targetIndex: number): T[]`：从公开 Tab 数组中移除源项并插入目标位置；无效输入返回原顺序副本。
- `getWebTabDropIndex(pointerX: number, rects: readonly WebTabDropRect[], draggedTabId: string): number | null`：根据 Tab 中线返回移除源 Tab 后的目标索引。
- `WebTabDropRect = { id: string; left: number; right: number }`。

- [ ] **Step 1: Write the failing tests**

在 `web-tab-order.test.ts` 添加 BDD 测试：A 拖到 C 后为 B、C、A；C 拖到 A 前为 C、A、B；源和目标相同、负索引、超出索引时保持顺序。在 `web-tab-drag.test.ts` 添加按指针位移计算阈值、忽略源 Tab 后按中线得到首位/中间/末位的测试。

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun test apps/electron/src/main/lib/web-tab-order.test.ts
bun test apps/electron/src/renderer/components/web-browser/web-tab-drag.test.ts
```

Expected: FAIL because the new modules and exported functions do not exist.

- [ ] **Step 3: Write minimal pure implementations**

实现如下契约，不引入 DOM 或 Electron 依赖：

```ts
export function moveWebTab<T>(items: readonly T[], fromIndex: number, targetIndex: number): T[] {
  if (!Number.isInteger(fromIndex) || !Number.isInteger(targetIndex)) return [...items]
  if (fromIndex < 0 || fromIndex >= items.length || targetIndex < 0 || targetIndex >= items.length) return [...items]
  if (fromIndex === targetIndex) return [...items]
  const next = [...items]
  const [item] = next.splice(fromIndex, 1)
  next.splice(targetIndex, 0, item)
  return next
}
```

`getWebTabDropIndex` 先过滤 `draggedTabId`，再按 `pointerX < (left + right) / 2` 查找插入位置，未命中时返回剩余数量。

- [ ] **Step 4: Run tests to verify they pass**

Run the two Bun test commands from Step 2. Expected: all new pure logic tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/electron/src/main/lib/web-tab-order.ts apps/electron/src/main/lib/web-tab-order.test.ts apps/electron/src/renderer/components/web-browser/web-tab-drag.ts apps/electron/src/renderer/components/web-browser/web-tab-drag.test.ts
git commit -m "test: cover web tab drag ordering logic"
```

### Task 2: Add main-process reorder state and persistence

**Files:**
- Modify: `apps/electron/src/main/lib/web-tab-manager.ts`
- Modify: `apps/electron/src/main/lib/web-tab-manager.test.ts`

**Interfaces:**
- `reorderWebTab(input: ReorderWebTabInput): WebTabsSnapshot`：只接受公开 Tab，按公开 Tab 顺序移动，激活被移动 Tab，保存恢复状态并返回快照。
- 工作流专用 Tab 保留在 manager 内部但不参与公开目标索引和公开快照。

- [ ] **Step 1: Write the failing integration tests**

扩展现有 Electron stub 测试：创建 A、B、C 后调用 `reorderWebTab`，断言公开快照顺序和 `activeTabId`；断言 `persistedSessions` 保存新顺序和激活索引；为无效 Tab、无效索引和 workflow-owned Tab 增加拒绝测试。

- [ ] **Step 2: Run the focused test to verify it fails**

```bash
bun test apps/electron/src/main/lib/web-tab-manager.test.ts
```

Expected: FAIL because `reorderWebTab` and `ReorderWebTabInput` are not present.

- [ ] **Step 3: Implement main-process reorder**

在 shared 类型准备前，使用后续定义的 `ReorderWebTabInput` 接口接入 `web-tab-order.ts`。从 `records` 找出公开 Tab，校验源 Tab 和目标索引，计算公开顺序并重建 Map 的可见记录顺序；workflow-owned 记录继续保留但不参与排序。设置 `activeTabId`，调用已有 `applyActiveView()`、`persistTabs()`、`emitSnapshot()`，最后返回 `getSnapshot()`。任何校验失败抛出中文错误并不改变 Map。

- [ ] **Step 4: Run the focused test to verify it passes**

```bash
bun test apps/electron/src/main/lib/web-tab-manager.test.ts
```

Expected: existing and new manager tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/electron/src/main/lib/web-tab-manager.ts apps/electron/src/main/lib/web-tab-manager.test.ts
git commit -m "feat: reorder web tabs in main process"
```

### Task 3: Expose reorder through shared IPC and preload

**Files:**
- Modify: `packages/shared/src/types/web.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/preload/index.ts`

**Interfaces:**

```ts
export interface ReorderWebTabInput {
  tabId: string
  targetIndex: number
}
```

Add `WEB_IPC_CHANNELS.REORDER = 'web-tabs:reorder'` and `window.electronAPI.webTabs.reorder(input): Promise<WebTabsSnapshot>`.

- [ ] **Step 1: Write the failing contract test**

在现有 shared/web 类型测试或新建最小 contract test 中断言 reorder channel 和 input 的结构；在 preload 类型编译边界中要求 `webTabs.reorder` 存在。若当前没有合适的 shared runtime test，则以 TypeScript 类型检查作为失败门槛，并先运行现有 WebTab manager test 确认主进程实现尚不能经 IPC 调用。

- [ ] **Step 2: Run the contract check to verify it fails**

```bash
bun run typecheck
```

Expected: FAIL at missing reorder channel/type/API surface.

- [ ] **Step 3: Implement the IPC bridge**

在 shared 类型导出输入和 channel；在 `ipc.ts` 导入并注册 `WEB_IPC_CHANNELS.REORDER`，校验输入为对象、`tabId` 为字符串、`targetIndex` 为整数后调用 `reorderWebTab`；在 preload 类型和实现中暴露同名 `reorder`。

- [ ] **Step 4: Run the contract check to verify it passes**

```bash
bun run typecheck
```

Expected: typecheck passes.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/web.ts apps/electron/src/main/ipc.ts apps/electron/src/preload/index.ts
git commit -m "feat: expose web tab reorder IPC"
```

### Task 4: Implement renderer Pointer Events drag interaction

**Files:**
- Modify: `apps/electron/src/renderer/components/web-browser/WebTabBar.tsx`
- Modify: `apps/electron/src/renderer/components/web-browser/WebTabBar.test.tsx`

**Interfaces:**
- `WebTabBar` 继续通过 Jotai 读取 `webTabsAtom`，拖动结束调用 `window.electronAPI.webTabs.reorder({ tabId, targetIndex })`。
- `WebTabItem` 接收 `onPointerDown`、`isDragging`、`isDropTarget` 和 `dropPosition` 等局部交互 props，不改变现有首页 Tab 和关闭按钮语义。

- [ ] **Step 1: Write the failing component contract tests**

扩展 `WebTabBar.test.tsx`：渲染网页 Tab 时断言 Tab 具备 `touch-action-none`/拖动语义标记，关闭按钮具备阻止拖动的 pointer-down 处理，且组件源码或测试替身能验证 reorder API 被调用；保留现有 Windows 标题栏和 Logo 测试。

- [ ] **Step 2: Run the focused renderer test to verify it fails**

```bash
bun test apps/electron/src/renderer/components/web-browser/WebTabBar.test.tsx
```

Expected: FAIL because the drag props and reorder behavior are not implemented.

- [ ] **Step 3: Implement the minimal drag interaction**

在 `WebTabBar` 使用 ref 保存 pending/active pointer 状态，按下后记录 Tab ID、pointerId 和起点；位移达到 6px 后调用 `setPointerCapture`、计算 drop index、更新 marker；pointer-up 对有效 drop index 调用 reorder IPC，返回快照后统一 `apply`，并通过 ref 抑制本次拖动产生的 click。pointer-cancel 清理状态但不调用 reorder。拖动 Tab 使用降低透明度，插入位置显示固定宽度的绿色竖向提示，确保 Tab 宽度不因状态变化而抖动。关闭控制 pointer-down 停止传播。

- [ ] **Step 4: Run focused renderer tests and build**

```bash
bun test apps/electron/src/renderer/components/web-browser/WebTabBar.test.tsx
bun run --filter='@copis/electron' build:renderer
```

Expected: tests and renderer build pass.

- [ ] **Step 5: Commit**

```bash
git add apps/electron/src/renderer/components/web-browser/WebTabBar.tsx apps/electron/src/renderer/components/web-browser/WebTabBar.test.tsx
git commit -m "feat: drag web tabs to reorder"
```

### Task 5: Full verification and review

**Files:**
- Review only: all files changed by Tasks 1-4

- [ ] **Step 1: Run the complete focused verification**

```bash
bun test apps/electron/src/main/lib/web-tab-order.test.ts
bun test apps/electron/src/main/lib/web-tab-manager.test.ts
bun test apps/electron/src/main/lib/web-tab-session-service.test.ts
bun test apps/electron/src/renderer/components/web-browser/web-tab-drag.test.ts
bun test apps/electron/src/renderer/components/web-browser/WebTabBar.test.tsx
bun run typecheck
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:renderer
```

- [ ] **Step 2: Review the diff**

检查只包含网页 Tab 拖动所需的 shared/main/preload/renderer、测试和设计/计划文档；确认没有新增依赖、调试输出、未处理的 Promise、错误的标题栏拖拽区域或 workflow Tab 泄露。

- [ ] **Step 3: User validation handoff**

交付时请用户在实际 Electron 窗口打开至少三个网页 Tab，分别拖到首位、中间和末位，确认拖动结束后目标 Tab 激活、刷新或重启后顺序保持，并确认普通点击、关闭按钮和标题栏拖拽区域仍正常。
