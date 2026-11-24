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

async function runMoreCases() {
  const emptySource = { getSnapshot: () => ({}), subscribe: () => () => {} }
  apply({ effect: fn => fn(), sessions: { list: emptySource }, sidebarRight: { mounted: { ...emptySource, getSnapshot: () => undefined } }, documentPreviews: { register: () => () => {} }, slots: { inject: (_name, register) => register(), register: () => {} } } as unknown as Parameters<typeof apply>[0])
  const cases = []
  try {
    for (const wide of [true, false]) {
      root.render(<Sidebar key={String(wide)} wide={wide} />)
      await tick()
      const metrics = (selector: string) => {
        const el = document.querySelector(selector)
        const icon = el?.querySelector('svg')?.getBoundingClientRect()
        return el ? { font: getComputedStyle(el).fontSize, iconWidth: icon?.width, iconLeft: icon?.left, textLeft: el.querySelector('span')?.getBoundingClientRect().left } : null
      }
      const heading = metrics('.copis-menu-heading'), settings = metrics('.copis-settings-entry')
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect()
      const menuBounds = box('[aria-label="Copis功能"]'), workspaceBounds = box('[data-workspaces]')
      const menuFitsWorkspace = Math.abs(menuBounds.width - workspaceBounds.width) < 1 && menuBounds.bottom <= workspaceBounds.top
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
      cases.push({ wide, menuFitsWorkspace, heading, settings, item: metrics('[data-copis-menu-id="search"]'), toggle: metrics('.copis-menu-toggle'), nativeOpenedOnce: nativeOpens === before + 1, prevented: click.defaultPrevented, menuVisible, panelVisible: visible(panel), overlayVisible: visible(overlay), copisSubviewActive: document.body.classList.contains('copis-subview-active') })
    }
    // 明确的 Copis 设置 API 不应随原生接管逻辑一起被删除。
    ;(window as any).copisBridge.openSettings()
    await tick()
    return cases
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

Object.assign(window, { runMoreCases, mountNavigationFixture })
