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
