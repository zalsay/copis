import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { appModeAtom } from '@/atoms/app-mode'
import { FileTypeIcon } from './FileTypeIcon'

describe('FileTypeIcon 模式主题变量契约测试', () => {
  test('Given Agent 模式 When 渲染目录图标 Then 接入 --ui-primary 变量值且闭合态使用折叠路径', () => {
    const store = createStore()
    store.set(appModeAtom, 'agent')

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <FileTypeIcon name="my-folder" isDirectory isOpen={false} />
      </Provider>,
    )

    expect(html).toContain('stroke="var(--ui-primary, #f09a43)"')
    expect(html).toContain('M20 20a2 2 0 0 0 2-2V8')
    expect(html).not.toContain('#64748B')
  })

  test('Given Agent 模式 When 展开目录图标 Then 接入 --ui-primary 变量值且展开态使用开放路径', () => {
    const store = createStore()
    store.set(appModeAtom, 'agent')

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <FileTypeIcon name="my-folder" isDirectory isOpen={true} />
      </Provider>,
    )

    expect(html).toContain('stroke="var(--ui-primary, #f09a43)"')
    expect(html).toContain('M22 19a2 2 0 0 1-2 2H4')
  })

  test('Given 创造模式 When 渲染目录图标 Then 接入 --creation-ui-primary 变量值', () => {
    const store = createStore()
    store.set(appModeAtom, 'creation')

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <FileTypeIcon name="workspace-dir" isDirectory isOpen={false} />
      </Provider>,
    )

    expect(html).toContain('stroke="var(--creation-ui-primary, #6C00CC)"')
    expect(html).toContain('M20 20a2 2 0 0 0 2-2V8')
    expect(html).not.toContain('#64748B')
  })

  test('Given 显式传入 mode 参数 When 渲染目录图标 Then 优先以传入 mode 为准', () => {
    const store = createStore()
    store.set(appModeAtom, 'agent')

    const htmlCreation = renderToStaticMarkup(
      <Provider store={store}>
        <FileTypeIcon name="sub-dir" isDirectory isOpen={true} mode="creation" />
      </Provider>,
    )
    expect(htmlCreation).toContain('stroke="var(--creation-ui-primary, #6C00CC)"')

    store.set(appModeAtom, 'creation')
    const htmlAgent = renderToStaticMarkup(
      <Provider store={store}>
        <FileTypeIcon name="sub-dir" isDirectory isOpen={false} mode="agent" />
      </Provider>,
    )
    expect(htmlAgent).toContain('stroke="var(--ui-primary, #f09a43)"')
  })

  test('Given 文件条目 (isDirectory 为 false) When 渲染 Then 输出普通文件图标而非目录 SVG', () => {
    const store = createStore()
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <FileTypeIcon name="app.tsx" isDirectory={false} />
      </Provider>,
    )

    expect(html).not.toContain('M20 20a2 2 0 0 0 2-2V8')
    expect(html).not.toContain('M22 19a2 2 0 0 1-2 2H4')
  })
})
