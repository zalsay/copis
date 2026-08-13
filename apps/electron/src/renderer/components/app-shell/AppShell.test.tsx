import { describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { activeWebTabIdAtom } from '@/atoms/web-tabs'
import { workingAuthStateAtom, workingSettingsOpenAtom, workingVipStatusAtom } from '@/atoms/working-atoms'
import { workingPaymentStateAtom } from '@/atoms/working-payment-atoms'

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

const { AppShell } = await import('./AppShell')

function renderAppShell({
  workingSettingsOpen = false,
  workingPaymentOpen = false,
  vipUpgradeAmount,
}: {
  workingSettingsOpen?: boolean
  workingPaymentOpen?: boolean
  vipUpgradeAmount?: string
}): string {
  const store = createStore()
  store.set(activeWebTabIdAtom, 'web-google')
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
