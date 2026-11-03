import { Bot } from 'lucide-react'
import { useLayoutEffect, useState, type ReactElement, type RefObject } from 'react'
import { createPortal } from 'react-dom'

interface CreationReturnToAgentControlProps {
  wide: boolean
  menuRef: RefObject<HTMLElement>
  onReturn: () => void
}

/** 在已有侧栏中托管入口，避免依赖官方 bundle 的内部组件或被旧 Header 隐藏规则遮住。 */
export function CreationReturnToAgentControl({ wide, menuRef, onReturn }: CreationReturnToAgentControlProps): ReactElement | null {
  const [host, setHost] = useState<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    // 与现有导航锚点一致：新版 DSH 的侧栏根是带 CSS Module root 类的 div。
    const sidebar = menuRef.current?.closest(
      '[class*="_root"], [class*="SidebarRoot"], [class*="_sidebarCol"], [class*="sidebarCol"], aside',
    )
    // 官方 footer 中 settingsArea 承载底部“更多”，入口紧邻其上，不随工作区列表滚动。
    const settings = sidebar?.querySelector('[class*="settingsArea"], [class*="SettingsArea"]')
    if (!settings?.parentElement) return
    const element = document.createElement('div')
    element.className = 'copis-return-agent-host'
    settings.before(element)
    setHost(element)
    return () => { element.remove() }
  }, [menuRef])

  if (!host) return null
  return createPortal(
    <button
      type="button"
      className={`${wide ? 'copis-menu-item' : 'copis-rail-menu-item'} copis-return-agent-button`}
      title="返回 Agent 模式"
      aria-label="返回 Agent 模式"
      onClick={onReturn}
    >
      <Bot size={wide ? 16 : 18} strokeWidth={1.8} />
      {wide && <span>返回 Agent 模式</span>}
    </button>,
    host,
  )
}
