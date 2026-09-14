import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./BrowserAgentPanel.tsx', import.meta.url), 'utf8')

test('Given Composer 提供高级授权图标 When 渲染网页 Agent 面板 Then 不再提供独立的页面授权切换', () => {
  expect(source).not.toContain('browserWorkflow.setControlMode')
  expect(source).not.toContain('aria-label="页面控制模式"')
  expect(source).toContain('aria-label="选择网页 Agent 项目"')
})

test('Given 网页 Agent Header When 渲染项目切换 Then 使用第一行单个项目图标', () => {
  expect(source).not.toContain('CopisAgentLogo')
  expect(source).not.toContain('h-9 items-center justify-end')
  expect(source).not.toContain('SelectValue')
  expect(source).toContain('<FolderKanban className="size-4" />')
  expect(source).toContain('[&>svg:last-child]:hidden')
})

test('Given 切换网页 Agent 项目 When 面板发起切换 Then 由宿主创建或切换目标工作区会话，不再迁移当前会话', () => {
  expect(source).toContain('onSwitchProject')
  expect(source).not.toContain('moveAgentSessionToWorkspace')
})

test('Given Workflow 审核功能已移除 When 渲染面板 Then 不再渲染人工审核条', () => {
  expect(source).not.toContain('自动化流程草稿')
  expect(source).not.toContain('取消（不做更新）')
  expect(source).not.toContain('确认（更新为确认后版本）')
  expect(source).not.toContain('draft.variables.length')
  expect(source).not.toContain('draftOrigins(draft)')
  expect(source).not.toContain("step.type === 'manual'")
})

test('Given 网页 Agent 会话表面 When 嵌入面板 Then 传入 variant="browser" 以激活专用快捷入口', () => {
  expect(source).toContain('<AgentConversationSurface sessionId={sessionId} variant="browser" />')
})
