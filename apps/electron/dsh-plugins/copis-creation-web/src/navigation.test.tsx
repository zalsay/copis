import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { parseHTML } from 'linkedom'
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
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

test('Given DSH 侧栏 When 展开或折叠 Then 保留官方更多且不再挂载返回 Agent 入口', async () => {
  for (const wide of [true, false]) {
    await renderSidebar(wide)
    expect(sidebar.querySelector('[class*="settingsArea"]')?.textContent).toContain('更多')
    expect(sidebar.querySelector('.copis-return-agent-host, .copis-return-agent-button')).toBeNull()
    expect(sidebar.textContent).not.toContain('返回 Agent 模式')
  }
  expect(switchMode).not.toHaveBeenCalled()
})

test('Given 官方详情侧栏 When Copis 插件注册 Then 不再注入重复的自定义右上角操作项', () => {
  const slots: string[] = []
  const emptySource = { getSnapshot: () => ({}), subscribe: () => () => {} }
  apply({ effect: (fn: () => unknown) => fn(), sessions: { list: emptySource }, sidebarRight: { mounted: { ...emptySource, getSnapshot: () => undefined } }, documentPreviews: { register: () => () => {} }, slots: { inject: (name: string, register: () => void) => { slots.push(name); register() }, register: () => {} } } as any)
  expect(slots).toEqual(['sidebar.footer.action', 'shell.overlay', 'sidebar.right.tab.document'])
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

test('Given 会话页启动或重载 When 就绪后重投未确认命令 Then 每条命令只新建一次且重复回执不丢失', async () => {
  const startSession = mock(() => {})
  const navigate = mock((_view: string, _tab?: string) => {})
  Object.assign(window.copisBridge!, { navigate })
  const values = new Map<string, string>()
  Object.assign(window, { sessionStorage: { getItem: (k: string) => values.get(k), setItem: (k: string, v: string) => values.set(k, v) } })
  const mount = (key: string) => act(async () => { root!.render(<CopisShellOverlayManager key={key} ctx={{ uiWorkspace: { startSession } } as any} />) })
  const send = (id: string) => act(async () => { window.dispatchEvent(Object.assign(new window.Event('message'), { data: { type: 'COPIS_DSH_NEW_SESSION', requestId: id } })) })
  await mount('初次启动')
  expect(navigate).toHaveBeenCalledWith('conversations', 'dsh-client-ready')
  await send('one'); await mount('重载'); await send('one'); await send('two')
  expect(startSession).toHaveBeenCalledTimes(2)
  expect(navigate.mock.calls.map(([, tag]) => tag)).toEqual(['dsh-client-ready', 'dsh-session-accepted:one', 'dsh-client-ready', 'dsh-session-accepted:one', 'dsh-session-accepted:two'])
  expect(switchMode).not.toHaveBeenCalled()
})

test('Copis功能默认前三项，可展开和收起，工作区前的设置始终走 Copis 入口', async () => {
  const openSettings = mock(() => {})
  Object.assign(window.copisBridge!, { openSettings })
  await renderSidebar(true)
  const ids = () => Array.from(sidebar.querySelectorAll('[data-copis-menu-id]'), el => el.getAttribute('data-copis-menu-id'))
  const toggle = () => sidebar.querySelector<HTMLButtonElement>('button[aria-expanded]')!
  expect(sidebar.querySelector('[aria-label="Copis功能"]')?.textContent).toContain('Copis功能')
  expect(ids()).toEqual(['search', 'schedule', 'automations'])
  expect(toggle().textContent).toContain('展开显示')
  await act(async () => toggle().click())
  expect(ids()).toHaveLength(9)
  expect(toggle().textContent).toContain('收起')
  await act(async () => toggle().click())
  expect(ids()).toHaveLength(3)
  const settings = sidebar.querySelector<HTMLButtonElement>('[aria-label="Copis 设置"]')!
  expect(sidebar.querySelector('.regionArea')?.previousElementSibling?.querySelector('[aria-label="Copis 设置"]')).toBe(settings)
  await act(async () => settings.click())
  expect(openSettings).toHaveBeenCalledTimes(1)
})

test('已隐藏的项目不占名额，剩余仅三项时隐藏展开按钮，窄栏保留设置', async () => {
  Object.assign(window.copisBridge!, { getHiddenMenuItems: () => ['search', 'knowledge', 'expert-team', 'group-chat', 'agent-skills', 'fund-stock'] })
  await renderSidebar(false)
  expect(Array.from(sidebar.querySelectorAll('[data-copis-menu-id]'), el => el.getAttribute('data-copis-menu-id'))).toEqual(['schedule', 'automations', 'memory'])
  expect(sidebar.querySelector('button[aria-expanded]')).toBeNull()
  expect(sidebar.querySelector('[aria-label="Copis 设置"]')).not.toBeNull()
})


test('RC2 将工作区嵌套在滚动容器时，Copis 菜单仍在其前，卸载时不留节点', async () => {
  await act(async () => root!.render(<>
    <div className="hHd-Xa_scrollArea"><div className="regionArea" /></div>
    <div className="hHd-Xa_footArea"><CreationSidebarNavigation wide /></div>
  </>))
  const region = sidebar.querySelector('.regionArea')!
  expect(region.firstElementChild?.querySelector('[aria-label="Copis功能"]')).toBeTruthy()
  await act(async () => root!.render(<div className="hHd-Xa_scrollArea"><div className="regionArea" /></div>))
  expect(sidebar.querySelector('[aria-label="Copis功能"]')).toBeNull()
})
