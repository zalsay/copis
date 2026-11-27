import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { apply, CopisShellOverlayManager, CreationSidebarNavigation } from '../client'

const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
const root = createRoot(document.getElementById('root')!)
let nativeOpens = 0

// 只使用测试宿主模拟官方 click → 弹层链路；Copis 插件和隔离 preload 都执行真实源码。
function Sidebar({ wide }: { wide: boolean }) {
  const [open, setOpen] = React.useState(false)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  return <>
    <CreationSidebarNavigation wide={wide} collapsed={!wide} />
    <div className="hHd-Xa_scrollArea" style={wide ? { display: 'grid', gridTemplateColumns: '4px minmax(0, 1fr) 6px', gridTemplateRows: '8px max-content 2px max-content' } : undefined}>
      <nav style={{ gridArea: '2 / 2' }}>插件</nav>
      <div className="hHd-Xa_regionArea" style={{ gridArea: '4 / 2', display: 'flex', flexDirection: 'column', minWidth: 0 }}><div data-workspaces>工作区</div></div>
    </div>
    <div className="hHd-Xa_footArea">
      <div className="hHd-Xa_settingsArea">
        <button data-native-more aria-haspopup="menu" aria-label="更多" onClick={() => { nativeOpens++; setOpen(true) }}>
          <svg><path data-more-icon /></svg>更多
        </button>
        {open && <div role="menu"><button role="menuitem" onClick={() => { setOpen(false); setSettingsOpen(true) }}>设置</button></div>}
        {settingsOpen && <><div className="VOzbGW_overlay" data-native-overlay /><div className="VOzbGW_panel" role="dialog">DSH 原生设置</div></>}
      </div>
    </div>
  </>
}

function measureSubviewSidebar() {
  // RC2 的抽屉列和内层 sidebar 都是 div，并分别带有原生的 viewport - 48px 内联宽度。
  const host = document.createElement('div')
  host.style.width = '280px'
  host.innerHTML = `
    <div class="pI_x6G_frame" data-sidebar-drawer="true">
      <div class="pI_x6G_sidebarCol" style="width:232px">
        <div class="hHd-Xa_root copis-creation-sidebar" style="box-sizing:border-box;width:232px;--dsh-sidebar-inline-padding:8px;padding:6px 8px">
          <button class="hHd-Xa_newSession">
            <span class="hHd-Xa_newSessionLabelMask"><span class="hHd-Xa_newSessionContent">
              <span class="hHd-Xa_newSessionLabel hHd-Xa_wide">新会话</span>
            </span></span>
          </button>
        </div>
      </div>
    </div>`
  document.body.append(host)
  document.body.classList.add('copis-subview-active')
  try {
    const hostRect = host.getBoundingClientRect()
    const sidebar = host.querySelector('.hHd-Xa_root')!.getBoundingClientRect()
    const button = host.querySelector('button')!.getBoundingClientRect()
    const textAfter = (selector: string) => getComputedStyle(host.querySelector(selector)!, '::after').content
    return {
      sidebarWidth: sidebar.width, leftInset: button.left - hostRect.left, rightInset: hostRect.right - button.right,
      returnLabel: textAfter('.hHd-Xa_newSessionLabel'), maskLabel: textAfter('.hHd-Xa_newSessionLabelMask'), shortcut: textAfter('button'),
    }
  } finally {
    document.body.classList.remove('copis-subview-active')
    host.remove()
  }
}

// 使用当前实际注入的 preload 与插件样式，比较两种行在同一主题下的最终绘制色。
function mountRoomPaintFixture() {
  const host = document.createElement('div')
  host.innerHTML = `<button class="YDXeBa_sessionRow YDXeBa_selected">工作区会话</button>
    <section class="copis-room-section"><div class="copis-room-heading">
      <button class="copis-menu-item copis-room-toggle">群聊协作</button><div><button class="copis-room-action" aria-expanded="false">+</button></div>
    </div><div class="copis-room-children"><div class="copis-room-row">
      <button class="copis-menu-item" data-active="true"><span class="copis-room-unread-slot"><span class="copis-room-unread-dot"></span></span><span>群聊</span></button><div><button class="copis-room-action copis-room-more">···</button></div>
    </div></div></section>`
  for (const el of host.querySelectorAll('button')) el.style.setProperty('transition', 'none', 'important')
  host.id = 'room-paint'
  host.style.cssText = 'position:fixed;left:10px;top:10px;width:260px;z-index:99999'
  document.body.append(host)
  const selectors = ['.copis-room-toggle','.copis-room-heading .copis-room-action','.copis-room-row > button','.copis-room-more']
  return selectors.map(selector => {
    const rect = host.querySelector(selector)!.getBoundingClientRect()
    return { x:rect.left + rect.width / 2, y:rect.top + rect.height / 2 }
  })
}

async function runMoreCases() {
  const emptySource = { getSnapshot: () => ({}), subscribe: () => () => {} }
  apply({ effect: fn => fn(), sessions: { list: emptySource }, sidebarRight: { mounted: { ...emptySource, getSnapshot: () => undefined } }, documentPreviews: { register: () => () => {} }, slots: { inject: (_name, register) => register(), register: () => {} } } as unknown as Parameters<typeof apply>[0])
  const cases = []
  try {
    for (const wide of [true, false]) {
      root.render(<Sidebar key={String(wide)} wide={wide} />)
      await tick()
      if (wide) {
        // 原生拖动只改变布局宽度，不会改变 footer slot 的 wide 参数。
        document.getElementById('root')!.style.width = '400px'
        await tick()
      }
      const metrics = (selector: string) => {
        const el = document.querySelector(selector)
        const icon = el?.querySelector('svg')?.getBoundingClientRect()
        return el ? { font: getComputedStyle(el).fontSize, iconWidth: icon?.width, iconLeft: icon?.left, textLeft: el.querySelector('span')?.getBoundingClientRect().left } : null
      }
      const heading = metrics('.copis-menu-heading'), settings = metrics('.copis-settings-entry')
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect()
      const menuBounds = box('[aria-label="Copis功能"]'), workspaceBounds = box('[data-workspaces]')
      const groupEntry = box(wide ? '.copis-room-section' : 'button[aria-label="群聊协作"]')
      const groupBelowWorkspaces = groupEntry.top >= workspaceBounds.bottom && groupEntry.width > 0 && (!wide || Math.abs(groupEntry.width - workspaceBounds.width) < 1)
      const menuFitsWorkspace = Math.abs(menuBounds.width - workspaceBounds.width) < 1 && menuBounds.bottom <= workspaceBounds.top
      window.dispatchEvent(new MessageEvent('message', {data:{type:'COPIS_SHARED_ROOM_SIDEBAR',status:'ready',rooms:[{id:'one',name:'测试群',unread:true,actions:[]}]}}))
      await tick()
      const groupButton = document.querySelector<HTMLButtonElement>('button[aria-label="群聊协作"]')!
      if (wide) { groupButton.click(); await tick() }
      const dot = groupButton.querySelector('.copis-room-unread-dot')!.getBoundingClientRect()
      const titleLayout = []
      if (wide) {
        const host = document.getElementById('root')!
        const original = host.style.width
        for (const width of [264, 400]) {
          host.style.width = `${width}px`
          const title = document.createRange()
          title.selectNodeContents(groupButton.querySelector('.copis-room-heading-label')!.firstChild!)
          const label = title.getBoundingClientRect()
          const marker = groupButton.querySelector('.copis-room-unread-dot')!.getBoundingClientRect()
          titleLayout.push({gap:label.left-marker.right, lines:title.getClientRects().length,
            sameLine:marker.top+marker.height/2 >= label.top && marker.top+marker.height/2 <= label.bottom})
        }
        host.style.width = original
      }
      const aggregateDot = { width:dot.width, height:dot.height, titleLayout }
      const search = document.querySelector<HTMLButtonElement>('[data-copis-menu-id="search"]')!
      search.style.transition = 'none'
      search.focus()
      const { color: focusedMenuColor, backgroundColor: focusedMenuFill } = getComputedStyle(search)
      search.blur()
      const before = nativeOpens
      const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
      // 点击嵌套 SVG 路径，覆盖实际鼠标落点而非只测试 button 本身。
      document.querySelector('[data-more-icon]')!.dispatchEvent(click)
      await tick()
      const menu = document.querySelector<HTMLElement>('[role="menu"]')
      const menuVisible = !!menu && getComputedStyle(menu).display !== 'none' && getComputedStyle(menu).visibility !== 'hidden'
      document.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click()
      await tick()
      const panel = document.querySelector<HTMLElement>('[role="dialog"]')
      const overlay = document.querySelector<HTMLElement>('[data-native-overlay]')
      const visible = (node: HTMLElement | null) => {
        if (!node) return false
        const style = getComputedStyle(node)
        return style.display !== 'none' && style.visibility !== 'hidden' && style.pointerEvents !== 'none'
      }
      cases.push({ wide, aggregateDot, groupBelowWorkspaces, focusedMenuColor, focusedMenuFill, menuFitsWorkspace, heading, settings, item: metrics('[data-copis-menu-id="search"]'), toggle: metrics('.copis-menu-toggle'), nativeOpenedOnce: nativeOpens === before + 1, prevented: click.defaultPrevented, menuVisible, panelVisible: visible(panel), overlayVisible: visible(overlay), copisSubviewActive: document.body.classList.contains('copis-subview-active') })
    }
    // 明确的 Copis 设置 API 不应随原生接管逻辑一起被删除。
    ;(window as any).copisBridge.openSettings()
    await tick()
    return { cases, subviewSidebar: measureSubviewSidebar() }
  } finally {
    root.unmount()
  }
}

function mountNavigationFixture() {
  const ctx = { uiWorkspace: { startSession() {
    sessionStorage.setItem('fixtureStarts', String(Number(sessionStorage.getItem('fixtureStarts') || 0) + 1))
  } } }
  createRoot(document.body.appendChild(document.createElement('div'))).render(<CopisShellOverlayManager ctx={ctx as Parameters<typeof CopisShellOverlayManager>[0]['ctx']} />)
}

Object.assign(window, { runMoreCases, mountNavigationFixture, mountRoomPaintFixture })
