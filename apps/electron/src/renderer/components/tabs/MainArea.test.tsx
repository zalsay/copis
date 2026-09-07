import { describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { appModeAtom } from '@/atoms/app-mode'
import { tabsAtom, activeTabIdAtom } from '@/atoms/tab-atoms'
import { activeViewAtom } from '@/atoms/active-view'

mock.module('@/components/creation/CopisCreationWebView', () => ({
  CopisCreationWebView: () => <div data-testid="copis-creation-web-view" />,
}))

mock.module('./TabBar', () => ({
  TabBar: () => <div data-testid="tab-bar" />,
}))

mock.module('./TabContent', () => ({
  TabContent: ({ tabId }: { tabId: string }) => <div data-testid={`tab-content-${tabId}`} />,
}))

mock.module('@/hooks/useTrackSessionView', () => ({
  useTrackSessionView: () => {},
}))

mock.module('@/components/welcome/WelcomeView', () => ({
  WelcomeView: () => <div data-testid="welcome-view" />,
}))

mock.module('@/components/diff/PreviewPanel', () => ({
  PreviewPanel: () => <div data-testid="preview-panel" />,
}))

mock.module('@/components/working/WorkingSessionHistoryView', () => ({
  WorkingSessionHistoryView: () => <div data-testid="working-session-history-view" />,
}))

mock.module('@/components/agent-skills/AgentSkillsView', () => ({
  AgentSkillsView: () => <div data-testid="agent-skills-view" />,
}))

mock.module('@/components/planning/PlanningView', () => ({
  PlanningView: () => <div data-testid="planning-view" />,
}))

mock.module('@/components/automation/AutomationFormView', () => ({
  AutomationFormView: () => <div data-testid="automation-form-view" />,
}))

mock.module('@/components/automation/AutomationsListView', () => ({
  AutomationsListView: () => <div data-testid="automations-list-view" />,
}))

mock.module('@/components/memory/MemoryView', () => ({
  MemoryView: () => <div data-testid="memory-view" />,
}))

mock.module('@/components/knowledge/KnowledgeView', () => ({
  KnowledgeView: () => <div data-testid="knowledge-view" />,
}))

mock.module('@/components/expert-team/ExpertTeamView', () => ({
  ExpertTeamView: () => <div data-testid="expert-team-view" />,
}))

mock.module('@/components/trading/FundStockTerminalView', () => ({
  FundStockTerminalView: () => <div data-testid="fund-stock-terminal-view" />,
}))

const { MainArea } = await import('./MainArea')

describe('MainArea 视图分发与模式对齐', () => {
  test('Given appMode 为 creation When 渲染 MainArea Then 直接挂载 CopisCreationWebView 且不渲染普通 TabBar', () => {
    const store = createStore()
    store.set(appModeAtom, 'creation')
    store.set(activeViewAtom, 'conversations')

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <MainArea />
      </Provider>,
    )

    expect(html).toContain('data-testid="copis-creation-web-view"')
    expect(html).not.toContain('data-testid="tab-bar"')
  })

  test('Given appMode 为 agent 且存在激活会话 Tab When 渲染 MainArea Then 挂载 TabBar 与 TabContent 且不挂载 CopisCreationWebView', () => {
    const store = createStore()
    store.set(appModeAtom, 'agent')
    store.set(activeViewAtom, 'conversations')
    store.set(tabsAtom, [
      { id: 'tab-1', type: 'agent', sessionId: 'sess-1', title: 'Agent Session' },
    ])
    store.set(activeTabIdAtom, 'tab-1')

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <MainArea />
      </Provider>,
    )

    expect(html).toContain('data-testid="tab-bar"')
    expect(html).toContain('data-testid="tab-content-tab-1"')
    expect(html).not.toContain('data-testid="copis-creation-web-view"')
  })

  test('Given appMode 为 creation 无论 activeView 为何值 When 渲染 MainArea Then 始终挂载 CopisCreationWebView 保持原生 Chromium 视图不被卸载', () => {
    const store = createStore()
    store.set(appModeAtom, 'creation')
    store.set(activeViewAtom, 'memory')

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <MainArea />
      </Provider>,
    )

    expect(html).toContain('data-testid="copis-creation-web-view"')
    expect(html).not.toContain('data-testid="tab-bar"')
  })

  test('Given appMode 为 agent 且 activeView 为 memory When 渲染 MainArea Then 挂载 MemoryView 且不挂载 CopisCreationWebView', () => {
    const store = createStore()
    store.set(appModeAtom, 'agent')
    store.set(activeViewAtom, 'memory')

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <MainArea />
      </Provider>,
    )

    expect(html).toContain('data-testid="memory-view"')
    expect(html).not.toContain('data-testid="copis-creation-web-view"')
  })

  test('Given appMode 为 agent 且 activeView 为 knowledge When 渲染 MainArea Then 挂载 KnowledgeView', () => {
    const store = createStore()
    store.set(appModeAtom, 'agent')
    store.set(activeViewAtom, 'knowledge')

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <MainArea />
      </Provider>,
    )

    expect(html).toContain('data-testid="knowledge-view"')
    expect(html).not.toContain('data-testid="copis-creation-web-view"')
  })

  test('Given appMode 为 agent 且 activeView 为 planning When 渲染 MainArea Then 挂载 PlanningView', () => {
    const store = createStore()
    store.set(appModeAtom, 'agent')
    store.set(activeViewAtom, 'planning')

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <MainArea />
      </Provider>,
    )

    expect(html).toContain('data-testid="planning-view"')
    expect(html).not.toContain('data-testid="copis-creation-web-view"')
  })
})
