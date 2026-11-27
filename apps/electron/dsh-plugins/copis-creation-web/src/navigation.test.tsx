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
  Object.assign(win, { location: { pathname: '/' }, copisBridge: { switchMode, getPinnedMenuItems: async () => ['search', 'schedule', 'automations'] } })
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
  expect(ids()).toHaveLength(8)
  expect(toggle().textContent).toContain('收起')
  await act(async () => toggle().click())
  expect(ids()).toHaveLength(3)
  const settings = sidebar.querySelector<HTMLButtonElement>('[aria-label="Copis 设置"]')!
  expect(sidebar.querySelector('.regionArea')?.previousElementSibling?.querySelector('[aria-label="Copis 设置"]')).toBe(settings)
  await act(async () => settings.click())
  expect(openSettings).toHaveBeenCalledTimes(1)
})

test('Given 已固定项与展开项 When 固定或取消固定 Then 更新常驻项且重载后保留', async () => {
  let stored = ['search', 'schedule', 'automations']
  const navigate = mock(() => {})
  const save = mock(async (ids: string[]) => { stored = ids })
  Object.assign(window.copisBridge!, { getPinnedMenuItems: async () => stored, setPinnedMenuItems: save, navigate })
  const ids = () => Array.from(sidebar.querySelectorAll('[data-copis-menu-id]'), el => el.getAttribute('data-copis-menu-id'))
  const toggle = () => sidebar.querySelector<HTMLButtonElement>('button[aria-expanded]')!
  const pin = (label: string) => sidebar.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!

  await renderSidebar(true)
  expect(navigate.mock.calls.every(call => JSON.stringify(call) === JSON.stringify(['group-chat','sidebar-sync']))).toBe(true)
  navigate.mockClear()
  expect(ids()).toEqual(stored)
  await act(async () => toggle().click())
  expect(pin('固定显示记忆')).not.toBeNull()
  expect(pin('固定显示记忆').closest('button [type="button"]')).toBeNull()
  await act(async () => pin('固定显示记忆').click())
  await act(async () => toggle().click())
  expect(ids()).toEqual(['search', 'schedule', 'automations', 'memory'])
  expect(save).toHaveBeenLastCalledWith(['search', 'schedule', 'automations', 'memory'])
  expect(navigate).not.toHaveBeenCalled()

  await act(async () => pin('取消固定日程表').click())
  expect(ids()).toEqual(['search', 'automations', 'memory'])
  await act(async () => root!.render(<div />))
  await renderSidebar(true)
  expect(ids()).toEqual(['search', 'automations', 'memory'])
  await act(async () => toggle().click())
  expect(pin('固定显示日程表')).not.toBeNull()
  await act(async () => toggle().click())
})

test('Given 没有固定项 When 展开菜单 Then 功能均可找回且窄栏保留设置', async () => {
  Object.assign(window.copisBridge!, { getPinnedMenuItems: async () => [] })
  await renderSidebar(false)
  expect(sidebar.querySelectorAll('[data-copis-menu-id]')).toHaveLength(0)
  const toggle = sidebar.querySelector<HTMLButtonElement>('button[aria-expanded]')!
  await act(async () => toggle.click())
  expect(sidebar.querySelectorAll('[data-copis-menu-id]')).toHaveLength(8)
  expect(sidebar.querySelector('[aria-label="Copis 设置"]')).not.toBeNull()
  await act(async () => toggle.click())
})

test('群聊协作在工作区下方独立显示，折叠与旧固定配置都不重复入口', async () => {
  const navigate = mock(() => {})
  Object.assign(window.copisBridge!, { navigate, getPinnedMenuItems: async () => ['group-chat'] })
  for (const wide of [true, false]) {
    await act(async () => root!.render(<><div className="hHd-Xa_scrollArea"><div className="regionArea">工作区</div></div>
      <div className="hHd-Xa_footArea"><CreationSidebarNavigation wide={wide} collapsed={!wide}/></div></>))
    const entry = sidebar.querySelector<HTMLButtonElement>('button[aria-label="群聊协作"]')!
    expect(entry).toBeTruthy()
    expect(entry.closest('[aria-label="Copis功能"]')).toBeNull()
    expect(sidebar.querySelector('.regionArea')?.nextElementSibling?.contains(entry)).toBe(true)
    expect(sidebar.querySelectorAll('button[aria-label="群聊协作"]')).toHaveLength(1)
  }
  navigate.mockClear()
  await act(async () => sidebar.querySelector<HTMLButtonElement>('button[aria-label="群聊协作"]')!.click())
  expect(navigate).toHaveBeenCalledTimes(1)
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

test('群聊分组可收起而不导航；子项和标题操作分别选择群、创建或加入', async () => {
  const navigate = mock(() => {})
  Object.assign(window.copisBridge!, { navigate })
  await renderSidebar(true)
  await act(async () => window.dispatchEvent(Object.assign(new window.Event('message'), {data: {
    type:'COPIS_SHARED_ROOM_SIDEBAR', rooms:[{id:'r7',name:'产品讨论'}], selected:'r7', status:'ready', busy:false,
  }})))
  const byLabel = (label: string) => sidebar.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
  expect(byLabel('产品讨论')).toBeTruthy()
  await act(async () => byLabel('产品讨论').click())
  expect(navigate).toHaveBeenLastCalledWith('group-chat','room:r7')
  const count = navigate.mock.calls.length
  await act(async () => byLabel('群聊协作').click())
  expect(byLabel('产品讨论')).toBeNull()
  expect(navigate.mock.calls.length).toBe(count)
  Object.assign(window.HTMLElement.prototype, { showPopover() {} })
  const trigger = byLabel('群聊操作')
  expect(trigger).toBeTruthy()
  expect(sidebar.querySelector('[role="menu"]')).toBeNull()
  await act(async () => trigger.click())
  expect(navigate.mock.calls.length).toBe(count)
  expect(sidebar.querySelectorAll('[role="menuitem"]')).toHaveLength(2)
  await act(async () => trigger.click())
  expect(sidebar.querySelector('[role="menu"]')).toBeNull()
  await act(async () => trigger.click())
  await act(async () => document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true })))
  expect(sidebar.querySelector('[role="menu"]')).toBeNull()
  await act(async () => trigger.click())
  await act(async () => byLabel('创建群聊').dispatchEvent(Object.assign(new window.Event('keydown', { bubbles: true }), { key: 'Escape' })))
  expect(sidebar.querySelector('[role="menu"]')).toBeNull()
  expect(navigate.mock.calls.length).toBe(count)
  await act(async () => trigger.click())
  await act(async () => byLabel('创建群聊').click())
  expect(navigate).toHaveBeenLastCalledWith('group-chat','create')
  expect(sidebar.querySelector('[role="menu"]')).toBeNull()
  await act(async () => trigger.click())
  await act(async () => byLabel('加入群聊').click())
  expect(navigate).toHaveBeenLastCalledWith('group-chat','join')
})

test('Given RC2 抽屉仍报告宽栏 When 点击 Copis 功能后原生布局收起侧栏 Then 恢复左栏交互且不重复切换', async () => {
  const frame = document.createElement('div')
  frame.className = 'pI_x6G_frame'
  sidebar.before(frame)
  const column = document.createElement('div')
  column.className = 'pI_x6G_sidebarCol'
  frame.append(column)
  column.append(sidebar)
  const toggleSidebar = mock(() => {
    frame.removeAttribute('data-sidebar-collapsed')
    column.removeAttribute('inert')
  })
  const ctx = { layout: { toggleSidebar } } as NonNullable<Parameters<typeof CreationSidebarNavigation>[0]['ctx']>
  await act(async () => root!.render(<><CreationSidebarNavigation wide ctx={ctx} /><div className="regionArea">工作区</div></>))
  await act(async () => sidebar.querySelector<HTMLButtonElement>('[data-copis-menu-id="schedule"]')!.click())
  expect(toggleSidebar).not.toHaveBeenCalled()

  await act(async () => {
    // RC2 宿主缩至侧栏宽度后，drawer 的 wide 仍为 true，但原生栏实际被设成 inert。
    frame.setAttribute('data-sidebar-drawer', 'true')
    frame.setAttribute('data-sidebar-collapsed', 'true')
    column.setAttribute('inert', '')
  })
  expect(toggleSidebar).toHaveBeenCalledTimes(1)
  expect(column.hasAttribute('inert')).toBe(false)
  await act(async () => sidebar.querySelector<HTMLButtonElement>('[data-copis-menu-id="automations"]')!.click())
  expect(toggleSidebar).toHaveBeenCalledTimes(1)
  expect(sidebar.textContent).toContain('工作区')

  await act(async () => window.dispatchEvent(Object.assign(new window.Event('message'), { data: { type: 'COPIS_SUBVIEW_CHANGE', subview: null } })))
  await act(async () => frame.setAttribute('data-sidebar-collapsed', 'true'))
  expect(toggleSidebar).toHaveBeenCalledTimes(1)
})
