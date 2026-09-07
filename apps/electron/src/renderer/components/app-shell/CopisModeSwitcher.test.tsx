import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { appModeAtom } from '@/atoms/app-mode'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CopisModeSwitcher } from './CopisModeSwitcher'

describe('CopisModeSwitcher', () => {
  test('Given 展开状态 When 渲染模式切换器 Then 渲染 Agent 模式 与 创造模式，且绝对不包含 (PTC)', () => {
    const store = createStore()
    store.set(appModeAtom, 'agent')

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <TooltipProvider>
          <CopisModeSwitcher isCollapsed={false} />
        </TooltipProvider>
      </Provider>
    )

    expect(html).toContain('Agent 模式')
    expect(html).toContain('创造模式')
    expect(html).not.toContain('(PTC)')
    expect(html).not.toContain('PTC')
  })

  test('Given 创造模式激活 When 展开渲染 Then 创造模式处于激活状态', () => {
    const store = createStore()
    store.set(appModeAtom, 'creation')

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <TooltipProvider>
          <CopisModeSwitcher isCollapsed={false} />
        </TooltipProvider>
      </Provider>
    )

    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('创造模式')
  })

  test('Given 折叠状态 When 渲染模式切换器 Then 呈现紧凑图标按钮', () => {
    const store = createStore()
    store.set(appModeAtom, 'agent')

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <TooltipProvider>
          <CopisModeSwitcher isCollapsed={true} />
        </TooltipProvider>
      </Provider>
    )

    expect(html).toContain('copis-working-sidebar-icon-button')
    expect(html).toContain('当前：Agent 模式（点击切换为创造模式）')
  })

  test('Given 未跳过确认 When 模式切换器就绪 Then 内嵌进入创造模式确认弹窗组件', () => {
    const store = createStore()
    store.set(appModeAtom, 'agent')

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <TooltipProvider>
          <CopisModeSwitcher isCollapsed={false} />
        </TooltipProvider>
      </Provider>
    )

    expect(html).toContain('role="radiogroup"')
    expect(html).toContain('创造模式')
  })

  test('Given 模式切换器 When 渲染 Agent 模式与创造模式 Then 分别使用 ui-primary 与 creation-ui-primary 强调色', () => {
    const store = createStore()
    store.set(appModeAtom, 'agent')

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <TooltipProvider>
          <CopisModeSwitcher isCollapsed={false} />
        </TooltipProvider>
      </Provider>
    )

    // Agent 模式 icon 使用 ui-primary
    expect(html).toContain('text-[var(--ui-primary)]')
    // 创造模式 icon 使用 creation-ui-primary
    expect(html).toContain('text-[var(--creation-ui-primary)]')
  })

  test('Given 创造模式激活 When 展开渲染 Then 创造模式处于激活状态并具有 creation-ui-primary 文字强调色', () => {
    const store = createStore()
    store.set(appModeAtom, 'creation')

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <TooltipProvider>
          <CopisModeSwitcher isCollapsed={false} />
        </TooltipProvider>
      </Provider>
    )

    expect(html).toContain('text-[var(--creation-ui-primary)]')
  })

  test('Given 折叠状态 When 分别处于 Agent 模式与创造模式 Then 状态指示器使用对应主题强调色', () => {
    const agentStore = createStore()
    agentStore.set(appModeAtom, 'agent')
    const agentHtml = renderToStaticMarkup(
      <Provider store={agentStore}>
        <TooltipProvider>
          <CopisModeSwitcher isCollapsed={true} />
        </TooltipProvider>
      </Provider>
    )
    expect(agentHtml).toContain('bg-[var(--ui-primary)]')

    const creationStore = createStore()
    creationStore.set(appModeAtom, 'creation')
    const creationHtml = renderToStaticMarkup(
      <Provider store={creationStore}>
        <TooltipProvider>
          <CopisModeSwitcher isCollapsed={true} />
        </TooltipProvider>
      </Provider>
    )
    expect(creationHtml).toContain('bg-[var(--creation-ui-primary)]')
    expect(creationHtml).toContain('text-[var(--creation-ui-primary)]')
  })
})
