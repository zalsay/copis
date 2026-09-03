import { describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createStore, Provider } from 'jotai'
import type { WebTabState } from '@copis/shared'
import { webTabsAtom } from '@/atoms/web-tabs'

mock.module('@/lib/platform', () => ({
  detectIsMac: () => false,
  detectIsWindows: () => true,
  WINDOW_CONTROLS_INSET_RIGHT: 'right-[126px]',
  WINDOW_CONTROLS_PADDING_RIGHT: 'pr-[126px]',
}))

mock.module('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

mock.module('@/lib/model-logo', () => ({
  CopisLogo: 'copis-logo.png',
  CopisTemplateLogo: 'copis-template-logo.png',
}))

const { WebTabBar } = await import('./WebTabBar')

describe('WebTabBar Windows 标题栏', () => {
  test('Given Windows 自定义窗口控制按钮 When 渲染网页页签栏 Then 右上角保留为非拖拽区域', () => {
    const html = renderToStaticMarkup(
      <Provider>
        <WebTabBar />
      </Provider>,
    )

    expect(html).toContain('pointer-events-none absolute inset-y-0 left-0 titlebar-drag-region right-[126px]')
    expect(html).toContain('pr-[126px]')
    expect(html).not.toContain('text-foreground titlebar-drag-region')
  })

  test('Given 网页 Tab When 渲染 Then 具备 Chrome 风格弹性自适应尺寸与拖动语义', () => {
    const store = createStore()
    const tab: WebTabState = {
      id: 'web-tab-1',
      title: '示例网页',
      url: 'https://example.com/',
      faviconUrl: null,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      isIncognito: false,
      canActivateIncognito: false,
    }
    store.set(webTabsAtom, [tab])

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <WebTabBar />
      </Provider>,
    )

    expect(html).toContain('data-web-tab-id="web-tab-1"')
    expect(html).toContain('touch-none')
    expect(html).toContain('flex-1')
    expect(html).toContain('min-w-[36px]')
    expect(html).toContain('max-w-[240px]')
    expect(html).toContain('truncate')
  })

  test('Given Copis 首页页签 When 渲染 Then 具备弹性自适应尺寸并使用熊猫 Logo', () => {
    const html = renderToStaticMarkup(
      <Provider>
        <WebTabBar />
      </Provider>,
    )

    expect(html).toContain('src="copis-logo.png"')
    expect(html).not.toContain('copis-template-logo.png')
    expect(html).toContain('min-w-[36px]')
    expect(html).toContain('max-w-[180px]')
    expect(html).toContain('flex-1')
  })

  test('Given 网页 Tab 与首页 Tab When 渲染 Then 包含 hover Tooltip 仅展示完整标题且不展示地址', () => {
    const store = createStore()
    const tab: WebTabState = {
      id: 'web-tab-2',
      title: '非常长的一个网页标题用于测试悬浮展示',
      url: 'https://developer.mozilla.org/zh-CN/docs/Web/HTML',
      faviconUrl: null,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      isIncognito: false,
      canActivateIncognito: false,
    }
    store.set(webTabsAtom, [tab])

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <WebTabBar />
      </Provider>,
    )

    expect(html).toContain('非常长的一个网页标题用于测试悬浮展示')
    expect(html).not.toContain('https://developer.mozilla.org/zh-CN/docs/Web/HTML')
    expect(html).toContain('Copis 首页')
  })
})
