import { describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { activeWebTabIdAtom } from '@/atoms/web-tabs'
import { workingSettingsOpenAtom } from '@/atoms/working-atoms'

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
}: {
  workingSettingsOpen?: boolean
}): string {
  const store = createStore()
  store.set(activeWebTabIdAtom, 'web-google')
  store.set(workingSettingsOpenAtom, workingSettingsOpen)

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
})
