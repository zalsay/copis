# AI Browser Simulated Cursor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Copis 内嵌网页中为 Agent 的 CDP 页面操作显示短暂、不可交互的模拟鼠标指针，并在视觉反馈失败时保持原操作可用。

**Architecture:** 主进程新增纯脚本生成模块，使用现有 `Runtime.evaluate` 在 `WebContentsView` 页面 DOM 中创建或更新一个 `data-copis-ai-browser-cursor` 节点。`browser-page-control-service` 负责从目标元素获取页面视口坐标，在 CDP 输入事件前后调用该模块；不新增 renderer 浮层、IPC、持久化状态或外部依赖。

**Tech Stack:** Electron `WebContentsView`、Chrome DevTools Protocol `Runtime.evaluate`/`Input.*`、TypeScript、Bun test。

---

### Task 1: 建立模拟鼠标脚本的失败测试

**Files:**
- Create: `apps/electron/src/main/lib/browser-page-cursor.test.ts`
- Create: `apps/electron/src/main/lib/browser-page-cursor.ts`（测试首次运行时尚不存在）

- [ ] **Step 1: 写出脚本生成器的行为测试**

测试先导入待实现的 `buildBrowserPageCursorSource`，覆盖以下输入和断言：

```ts
import { describe, expect, test } from 'bun:test'
import { buildBrowserPageCursorSource } from './browser-page-cursor'

describe('AI 浏览器模拟鼠标脚本', () => {
  test('Given 有效坐标 When 移动指针 Then 生成固定定位且不可交互的页面节点', () => {
    const source = buildBrowserPageCursorSource({ phase: 'move', x: 120, y: 80 })

    expect(source).toContain('data-copis-ai-browser-cursor')
    expect(source).toContain('pointer-events')
    expect(source).toContain('position:fixed')
    expect(source).toContain('120')
    expect(source).toContain('80')
  })

  test('Given 按下状态 When 生成脚本 Then 脚本包含按下视觉状态', () => {
    expect(buildBrowserPageCursorSource({ phase: 'press', x: 10, y: 20 })).toContain('press')
  })

  test('Given 非有限或越界坐标 When 生成脚本 Then 坐标被限制为页面安全数值', () => {
    const source = buildBrowserPageCursorSource({ phase: 'move', x: Number.POSITIVE_INFINITY, y: -20 })

    expect(source).toContain('0')
    expect(source).not.toContain('Infinity')
  })

  test('Given hide 阶段 When 生成脚本 Then 删除已有指针节点', () => {
    expect(buildBrowserPageCursorSource({ phase: 'hide' })).toContain('.remove()')
  })
})
```

- [ ] **Step 2: 运行测试确认按预期失败**

Run:

```bash
cd /Volumes/RC500/dev/copis/apps/electron
bun test ./src/main/lib/browser-page-cursor.test.ts
```

Expected: FAIL because `browser-page-cursor.ts` and `buildBrowserPageCursorSource` do not yet exist. Do not modify production code before observing this missing-module failure.

### Task 2: 实现可复用的网页指针脚本生成器

**Files:**
- Modify: `apps/electron/src/main/lib/browser-page-cursor.ts`
- Test: `apps/electron/src/main/lib/browser-page-cursor.test.ts`

- [ ] **Step 1: 定义最小类型和脚本生成 API**

实现以下稳定接口：

```ts
export type BrowserPageCursorPhase = 'move' | 'press' | 'type' | 'select' | 'key' | 'scroll' | 'hide'

export interface BrowserPageCursorInput {
  phase: BrowserPageCursorPhase
  x?: number
  y?: number
}

export function buildBrowserPageCursorSource(input: BrowserPageCursorInput): string
```

- [ ] **Step 2: 实现坐标约束和网页节点脚本**

`buildBrowserPageCursorSource` 必须在主进程生成不依赖网页输入的表达式：

```ts
const x = Number.isFinite(input.x) ? Math.max(0, Math.min(100000, input.x!)) : 0
const y = Number.isFinite(input.y) ? Math.max(0, Math.min(100000, input.y!)) : 0
```

脚本使用固定定位节点、`pointer-events:none`、唯一 `data-copis-ai-browser-cursor` 标识和页面内高层级；新动作复用节点并递增 token，隐藏定时器只删除自己对应的节点状态。不要把 selector、网页文本或未经限制的字符串注入脚本。

- [ ] **Step 3: 运行生成器测试确认通过**

Run:

```bash
bun test ./src/main/lib/browser-page-cursor.test.ts
```

Expected: 4 pass, 0 fail。

### Task 3: 将指针接入页面控制动作

**Files:**
- Modify: `apps/electron/src/main/lib/browser-page-control-service.ts`
- Test: `apps/electron/src/main/lib/browser-page-control-service.test.ts`

- [ ] **Step 1: 先补充页面控制服务的失败回归测试**

扩展测试 runtime 记录 `sendCommand` 的完整输入，而不只记录 method。新增断言：

```ts
test('Given 授权模式和有效元素引用 When Agent 点击 Then 先移动网页指针再派发鼠标事件', async () => {
  const { runtime, commands } = createRuntime('authorized')
  const service = createBrowserPageControlService(runtime)
  await service.observe('session-1')

  await service.click('session-1', 'e1')

  expect(commands).toEqual([
    'Runtime.enable',
    'Runtime.evaluate',
    'Runtime.evaluate',
    'Runtime.evaluate',
    'Input.dispatchMouseEvent',
    'Input.dispatchMouseEvent',
  ])
})
```

另加一个 runtime 在指针注入表达式上抛错、但鼠标事件正常返回的测试，证明视觉反馈是 best-effort，不降低页面操作可用性。

- [ ] **Step 2: 让目标解析同时返回操作坐标**

保持 `clickTargetSource` 的 `{ ok, x, y }` 返回结构；修改 `focusTargetSource` 在 `focus()` 后返回目标中心坐标：

```ts
const rect = target.getBoundingClientRect()
return { ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
```

对于 `select`，在确认选项有效后仍返回同一坐标；对于输入和按键，使用该坐标显示指针后再继续当前的聚焦/键盘序列。

- [ ] **Step 3: 增加 best-effort 指针调用**

在 `createBrowserPageControlService` 内增加局部异步 helper，调用：

```ts
await runtime.sendCommand({
  tabId,
  method: 'Runtime.evaluate',
  params: {
    expression: buildBrowserPageCursorSource({ phase, x, y }),
    returnByValue: true,
  },
})
```

helper 捕获 `Runtime.evaluate` 错误，使用现有日志约定输出 `console.warn('[AI浏览器][主进程] 页面指针注入失败', { tabId, phase, error })`，不向上抛出。视觉调用只接收有限数字坐标；点击在 `mousePressed` 前显示 `move`，按下后显示 `press`；输入、选择、按键在聚焦后对应显示 `type`/`select`/`key`；滚动以 viewport 中心显示 `scroll` 后再执行 `window.scrollBy`。

- [ ] **Step 4: 保持原有安全门禁和 CDP 顺序**

所有动作仍先执行 `assertBrowserPageMutationAllowed`、缓存引用校验、敏感字段校验，再注入指针。询问模式或敏感字段被拒绝时不得发送任何指针脚本。导航只在已有授权检查后尽力隐藏指针，再调用 `runtime.navigate`。

- [ ] **Step 5: 运行服务回归测试确认通过**

Run:

```bash
bun test ./src/main/lib/browser-page-control-service.test.ts
```

Expected: 原有安全策略测试和新增时序/降级测试全部 pass；询问模式测试的 CDP 命令列表仍不包含页面写操作或指针注入。

### Task 4: 版本与静态验证

**Files:**
- Modify: `apps/electron/package.json`

- [ ] **Step 1: 递增 Electron patch 版本**

将当前 `0.0.30` 递增为 `0.0.31`，不修改依赖版本和 lockfile。

- [ ] **Step 2: 运行完整定向验证**

按顺序执行：

```bash
cd /Volumes/RC500/dev/copis/apps/electron
bun test ./src/main/lib/browser-page-cursor.test.ts
bun test ./src/main/lib/browser-page-control-service.test.ts
bun run typecheck
bun run build:main
bun run build:renderer
cd /Volumes/RC500/dev/copis
git diff --check
```

Expected: 所有测试命令退出码为 0；构建成功。允许报告现有 Browserslist 和 chunk size warning，但不能有 TypeScript 错误或测试失败。

### Task 5: 主对话审阅与 Electron 用户验收

**Files:**
- Review only: `apps/electron/src/main/lib/browser-page-cursor.ts`
- Review only: `apps/electron/src/main/lib/browser-page-control-service.ts`
- Review only: `apps/electron/src/main/lib/browser-page-cursor.test.ts`
- Review only: `apps/electron/src/main/lib/browser-page-control-service.test.ts`

- [ ] **Step 1: 检查最终差异**

确认没有新增 renderer 浮层、任意 CDP 暴露、外部资源、敏感页面内容写入指针节点或与本任务无关的重构；确认现有未提交 Browser Agent 改动仍保留。

- [ ] **Step 2: 由用户在实际 Electron 窗口确认视觉行为**

用户在当前开发窗口打开普通 HTTP(S) 网页，授权 AI 浏览器后发送一个点击或输入请求，确认网页内能看到模拟鼠标移动/按下反馈，并确认指针不会拦截用户点击。Agent 不使用截图、截图对比或截图分析替代该确认。

- [ ] **Step 3: 交付验证证据**

报告修改文件、定向测试和构建结果；将 UI 视觉确认明确标记为用户已确认或待确认，不把自动化结果当作 Electron 视觉验收。
