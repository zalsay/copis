import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { parseHTML } from 'linkedom'
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CreationSidebarNavigation, CopisShellOverlayManager, apply } from './client'

const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act
let root: Root | null = null
let sidebar: HTMLElement
const switchMode = mock((_mode: string) => {})

beforeEach(() => {
  const { window: win } = parseHTML('<html><body><div id="root" class="hHd-Xa_root"></div></body></html>')
  Object.assign(globalThis, { window: win, document: win.document, navigator: win.navigator, Event: win.Event, IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(win, { location: { pathname: '/' }, copisBridge: { switchMode, getHiddenMenuItems: () => [] } })
  win.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 280, bottom: 800, width: 280, height: 800, toJSON: () => ({}) })
  sidebar = document.getElementById('root')!
  root = createRoot(sidebar)
  switchMode.mockClear()
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = null
})

async function renderSidebar(wide: boolean) {
  await act(async () => {
    root!.render(<><div className="logoRow">官方头部</div><CreationSidebarNavigation wide={wide} collapsed={!wide} /><div className="regionArea" /><div className="hHd-Xa_footArea"><div className="hHd-Xa_footerActions" /><div className="hHd-Xa_settingsArea"><button>更多</button></div></div></>)
    await Promise.resolve()
  })
}

test('Given 新版 DSH 侧栏 When Copis 导航挂载 Then 底部更多上方常驻返回 Agent 入口且仅通过既有桥发送一次切换', async () => {
  await renderSidebar(true)
  const button = sidebar.querySelector<HTMLButtonElement>('.copis-return-agent-button')
  expect(button).not.toBeNull()
  expect(sidebar.querySelector('[class*="_settingsArea"]')?.previousElementSibling?.className).toBe('copis-return-agent-host')
  expect(sidebar.querySelector('.copis-return-agent-host')?.parentElement?.className).toBe('hHd-Xa_footArea')
  expect(button!.textContent).toContain('返回 Agent 模式')
  await act(async () => { button!.dispatchEvent(new window.Event('click', { bubbles: true })) })
  expect(switchMode).toHaveBeenCalledTimes(1)
  expect(switchMode).toHaveBeenCalledWith('agent')
})

test('Given 侧栏展开或折叠并卸载 When 导航更新 Then 入口保持可访问且没有重复或残留节点', async () => {
  await renderSidebar(true)
  await renderSidebar(false)
  expect(sidebar.querySelectorAll('.copis-return-agent-host')).toHaveLength(1)
  expect(sidebar.querySelector('.copis-return-agent-button')?.getAttribute('aria-label')).toBe('返回 Agent 模式')
  expect(sidebar.querySelector('.copis-return-agent-button span')).toBeNull()
  await act(async () => { root!.unmount() })
  root = null
  expect(sidebar.querySelector('.copis-return-agent-host')).toBeNull()
})

test('Given 保留旧版右上角按钮隐藏规则 When 检查插件和 preload Then 不误隐藏底部返回入口', () => {
  for (const file of [join(import.meta.dir, 'client.tsx'), join(import.meta.dir, '../../../src/preload/dsh-bridge-preload.ts')]) {
    const source = readFileSync(file, 'utf8')
    expect(source).toContain('button[title*="返回 Agent 模式"]:not(.copis-return-agent-button)')
    expect(source).toContain('button[aria-label*="返回 Agent 模式"]:not(.copis-return-agent-button)')
  }
})


test('Given 旧版语义化 aside 侧栏 When 返回入口挂载 Then 继续兼容既有宿主', async () => {
  await act(async () => { root!.unmount() })
  document.body.innerHTML = '<aside id="legacy-sidebar" class="SidebarRoot_root"></aside>'
  sidebar = document.getElementById('legacy-sidebar')!
  root = createRoot(sidebar)
  await renderSidebar(true)
  expect(sidebar.querySelector('[class*="_settingsArea"]')?.previousElementSibling?.className).toBe('copis-return-agent-host')
  expect(sidebar.querySelector('.copis-return-agent-host')?.parentElement?.className).toBe('hHd-Xa_footArea')
  expect(sidebar.querySelector('.copis-return-agent-button')).not.toBeNull()
})


test('Given 官方详情侧栏 When Copis 插件注册 Then 不再注入重复的自定义右上角操作项', () => {
  const slots: string[] = []
  apply({ slots: { inject: (name: string, register: () => void) => { slots.push(name); register() }, register: () => {} } } as any)
  expect(slots).toEqual(['sidebar.footer.action', 'shell.overlay'])
})

test('Given 创造模式根层 When 自定义侧栏移除 Then 不渲染抽屉且搜索仍可打开关闭', async () => {
  await act(async () => { root!.render(<CopisShellOverlayManager ctx={{} as any} />) })
  expect(document.querySelector('.copis-header-btn-workspace')).toBeNull()
  expect(document.querySelector('.copis-details-drawer-root')).toBeNull()
  await act(async () => { window.dispatchEvent(new window.Event('COPIS_OPEN_SEARCH_MODAL')) })
  expect(document.querySelector('.copis-search-modal-card')).not.toBeNull()
  await act(async () => { document.querySelector('.copis-search-modal-backdrop')!.dispatchEvent(new window.Event('click', { bubbles: true })) })
  expect(document.querySelector('.copis-search-modal-card')).toBeNull()
})
