import { afterEach, describe, expect, mock, test } from 'bun:test'
import { parseHTML } from 'linkedom'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot, type Root } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import { activeWebTabIdAtom } from '@/atoms/web-tabs'
import { workingAuthStateAtom, workingSettingsOpenAtom, workingVipStatusAtom } from '@/atoms/working-atoms'
import { workingPaymentStateAtom } from '@/atoms/working-payment-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { activeViewAtom } from '@/atoms/active-view'

mock.module('./CopisWorkingSidebar', () => ({
  CopisWorkingSidebar: () => <div data-testid="sidebar" />,
}))
mock.module('./RightSidePanel', () => ({
  RightSidePanel: () => <div data-testid="right-panel" />,
}))
mock.module('@/components/tabs/MainArea', () => ({
  MainArea: () => <div data-testid="main-area" />,
}))
mock.module('@/components/WindowControls', () => ({
  WindowControls: () => null,
}))
mock.module('./CopisWorkingSettingsPanel', () => ({
  CopisWorkingSettingsPanel: () => <div data-testid="working-settings-panel" />,
}))
mock.module('./CopisWorkingPaymentModal', () => ({
  CopisWorkingPaymentModal: ({ vipStatus }: { vipStatus: { upgradeAmount?: string } | null }) => (
    <div data-testid="working-payment-modal" data-upgrade-amount={vipStatus?.upgradeAmount ?? ''} />
  ),
}))
mock.module('./SearchDialog', () => ({
  SearchDialog: () => null,
}))
mock.module('@/components/web-browser', () => ({
  WebBrowserSurface: () => <div data-testid="web-browser-surface" />,
  WebTabBar: () => <div data-testid="web-tab-bar" />,
}))

const {
  AppShell,
  MIN_LEFT_SIDEBAR_WIDTH,
  MAX_LEFT_SIDEBAR_WIDTH,
  DEFAULT_LEFT_SIDEBAR_WIDTH,
  clampLeftSidebarWidth,
} = await import('./AppShell')

const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act
let root: Root | null = null

afterEach(async () => {
  if (!root) return
  await act(async () => root?.unmount())
  root = null
})


function renderAppShell({
  workingSettingsOpen = false,
  workingPaymentOpen = false,
  vipUpgradeAmount,
  appMode = 'agent',
  activeWebTabId = 'web-google',
}: {
  workingSettingsOpen?: boolean
  workingPaymentOpen?: boolean
  vipUpgradeAmount?: string
  appMode?: 'agent' | 'creation'
  activeWebTabId?: string | null
}): string {
  const store = createStore()
  store.set(appModeAtom, appMode)
  store.set(activeWebTabIdAtom, activeWebTabId)
  store.set(workingSettingsOpenAtom, workingSettingsOpen)
  store.set(workingAuthStateAtom, {
    authenticated: true,
    backendUrl: 'https://edu-api.example.test',
    user: { id: 7, isVip: false },
  })
  store.set(workingPaymentStateAtom, {
    open: workingPaymentOpen,
    mode: 'vip',
    phase: 'selecting',
    packages: [],
  })
  if (vipUpgradeAmount) {
    store.set(workingVipStatusAtom, {
      isVip: false,
      tokens: 0,
      diamonds: 0,
      upgradeAmount: vipUpgradeAmount,
      upgradeDays: 30,
      quotaBytes: 0,
      quotaLabel: '',
    })
  }

  return renderToStaticMarkup(
    <Provider store={store}>
      <AppShell contextValue={{}} />
    </Provider>,
  )
}

describe('AppShell 网页标签与设置层', () => {
  test('Given Working 设置已打开 When 切换到网页标签 Then 设置层不可见且不可交互', () => {
    const html = renderAppShell({ workingSettingsOpen: true })

    expect(html).toContain(
      'class="absolute inset-0 z-[60] invisible pointer-events-none" aria-hidden="true"><div data-testid="working-settings-panel"',
    )
  })

  test('Given 设置页未打开且 VIP 支付状态已触发 When 渲染应用 Then 仍挂载支付弹窗', () => {
    const html = renderAppShell({ workingPaymentOpen: true, vipUpgradeAmount: '49.90' })

    expect(html).toContain('data-testid="working-payment-modal"')
    expect(html).toContain('data-upgrade-amount="49.90"')
  })
})

describe('AppShell 左侧主菜单栏宽度契约', () => {
  test('Given 左侧边栏宽度限制 When 检查区间与默认值 Then 默认宽度为 260px，区间为 200px~400px', () => {
    expect(DEFAULT_LEFT_SIDEBAR_WIDTH).toBe(260)
    expect(MIN_LEFT_SIDEBAR_WIDTH).toBe(200)
    expect(MAX_LEFT_SIDEBAR_WIDTH).toBe(400)
    expect(clampLeftSidebarWidth(150)).toBe(200)
    expect(clampLeftSidebarWidth(260)).toBe(260)
    expect(clampLeftSidebarWidth(500)).toBe(400)
  })

  test('Given 侧边栏宽度 Atom When 获取初始值 Then 为 260px', async () => {
    const { leftSidebarWidthAtom } = await import('@/atoms/sidebar-atoms')
    const store = createStore()
    expect(store.get(leftSidebarWidthAtom)).toBe(260)
  })
})

describe('AppShell 模式自适应布局', () => {
  test('Given appMode 为 creation 且 activeView 为 conversations When 渲染 AppShell Then 外层侧边栏隐藏避免与 dsh 内置菜单双层嵌套', () => {
    const store = createStore()
    store.set(appModeAtom, 'creation')
    store.set(activeViewAtom, 'conversations')
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <AppShell contextValue={{}} />
      </Provider>,
    )
    expect(html).not.toContain('data-testid="sidebar"')
    expect(html).toContain('data-testid="main-area"')
  })

  test('Given appMode 为 creation 无论 activeView 处于何种状态 When 渲染 AppShell Then 外层 Agent 侧边栏始终保持隐藏杜绝割裂跳出', () => {
    const store = createStore()
    store.set(appModeAtom, 'creation')
    store.set(activeViewAtom, 'memory')
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <AppShell contextValue={{}} />
      </Provider>,
    )
    expect(html).not.toContain('data-testid="sidebar"')
    expect(html).toContain('data-testid="main-area"')
  })

  test('Given 创造模式与活动网页页签同时恢复 When 渲染 AppShell Then 主工作台保持可见且不渲染网页表面', () => {
    const html = renderAppShell({ appMode: 'creation' })

    expect(html).toContain('data-testid="main-area"')
    expect(html).not.toContain('data-testid="web-browser-surface"')
    expect(html).not.toContain('invisible pointer-events-none')
  })

  test('Given 创造模式恢复时存在活动网页页签 When AppShell 挂载 Then 清空页签状态并通知主进程隐藏原生网页视图', async () => {
    const { window: domWindow } = parseHTML('<html><body><div id="root"></div></body></html>')
    const activate = mock(() => Promise.resolve({ tabs: [], activeTabId: null }))
    Object.assign(globalThis, {
      window: domWindow,
      document: domWindow.document,
      navigator: domWindow.navigator,
      Event: domWindow.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    })
    Object.assign(domWindow, {
      electronAPI: {
        webTabs: { activate },
      },
    })

    const store = createStore()
    store.set(appModeAtom, 'creation')
    store.set(activeWebTabIdAtom, 'web-restored')
    root = createRoot(document.getElementById('root')!)

    await act(async () => {
      root?.render(
        <Provider store={store}>
          <AppShell contextValue={{}} />
        </Provider>,
      )
      await Promise.resolve()
    })

    expect(store.get(activeWebTabIdAtom)).toBeNull()
    expect(activate).toHaveBeenCalledWith(null)
  })

  test('Given appMode 为 agent When 渲染 AppShell Then 外层侧边栏正常显示', () => {
    const store = createStore()
    store.set(appModeAtom, 'agent')
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <AppShell contextValue={{}} />
      </Provider>,
    )
    expect(html).toContain('data-testid="sidebar"')
  })
})

