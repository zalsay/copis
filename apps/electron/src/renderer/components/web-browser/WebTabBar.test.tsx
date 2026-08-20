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

  test('Given网页 Tab When渲染 Then暴露拖动语义并保持固定 Tab 尺寸', () => {
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
    expect(html).toContain('min-w-[144px]')
    expect(html).toContain('max-w-[240px]')
  })

  test('Given Copis 首页页签 When 渲染 Logo Then 使用熊猫 Logo', () => {
    const html = renderToStaticMarkup(
      <Provider>
        <WebTabBar />
      </Provider>,
    )

    expect(html).toContain('src="copis-logo.png"')
    expect(html).not.toContain('copis-template-logo.png')
  })
})
