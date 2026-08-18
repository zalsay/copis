import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const rendererRoot = join(import.meta.dir, '../..')
const activeViewSource = readFileSync(join(rendererRoot, 'atoms/active-view.ts'), 'utf8')
const mainAreaSource = readFileSync(join(rendererRoot, 'components/tabs/MainArea.tsx'), 'utf8')
const planningViewSource = readFileSync(join(rendererRoot, 'components/planning/PlanningView.tsx'), 'utf8')
const sidebarSource = readFileSync(join(rendererRoot, 'components/app-shell/CopisWorkingSidebar.tsx'), 'utf8')
const messageRendererSource = readFileSync(join(rendererRoot, 'components/agent/SDKMessageRenderer.tsx'), 'utf8')

describe('定时任务独立页面导航', () => {
  test('Given 侧边栏的定时任务入口 When 用户打开任务页 Then 主内容区显示独立任务页面', () => {
    expect(activeViewSource).toContain("'automations'")
    expect(mainAreaSource).toContain("activeView === 'automations'")
    expect(mainAreaSource).toContain('<AutomationsListView />')
    expect(sidebarSource).toContain('aria-label="定时任务"')
    expect(sidebarSource).toContain("activeView === 'automations' && 'active'")
    expect(sidebarSource).toContain("setActiveView('automations')")
  })

  test('Given 用户打开日程表 When 查看可选 Tab Then 不再显示定时任务', () => {
    expect(planningViewSource).not.toContain('AutomationsListView')
    expect(planningViewSource).not.toContain("{ id: 'automations', label: '定时任务' }")
  })

  test('Given 定时任务生成的会话 When 点击来源标记 Then 在独立任务页打开设置', () => {
    expect(messageRendererSource).toContain("setActiveView('automations')")
    expect(messageRendererSource).not.toContain("setPlanningTab('automations')")
  })
})
