import * as React from 'react'
import type { WebTabState, WebTabsSnapshot } from '@copis/shared'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WebBookmarksPopover } from './WebBookmarksPopover'

/** 独立原生收藏夹浮层窗口的渲染入口。 */
export function WebBookmarksWindowApp(): React.ReactElement {
  const [snapshot, setSnapshot] = React.useState<WebTabsSnapshot | null>(null)

  React.useEffect(() => {
    let mounted = true
    window.electronAPI.webTabs.list().then((nextSnapshot) => {
      if (mounted) setSnapshot(nextSnapshot)
    }).catch((error: unknown) => {
      console.error('[网页收藏夹] 获取当前页签失败:', error)
    })

    const unsubscribe = window.electronAPI.webTabs.onChanged((nextSnapshot) => {
      if (mounted) setSnapshot(nextSnapshot)
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  React.useEffect(() => {
    const html = document.documentElement
    const body = document.body
    const previousHtmlBackground = html.style.backgroundColor
    const previousBodyBackground = body.style.backgroundColor
    html.style.backgroundColor = 'transparent'
    body.style.backgroundColor = 'transparent'
    return () => {
      html.style.backgroundColor = previousHtmlBackground
      body.style.backgroundColor = previousBodyBackground
    }
  }, [])

  React.useLayoutEffect(() => {
    let frameId: number | null = null
    let observer: ResizeObserver | null = null

    const syncWindowSize = (): void => {
      const panel = document.querySelector<HTMLElement>('[data-web-bookmarks-panel="true"]')
      if (!panel) {
        frameId = requestAnimationFrame(syncWindowSize)
        return
      }

      observer ??= new ResizeObserver(() => syncWindowSize())
      observer.observe(panel)
      // Popover 入场包含 scale 动画，布局尺寸不会被动画帧缩小。
      void window.electronAPI.webTabs.bookmarksResize({
        width: panel.offsetWidth,
        height: panel.offsetHeight,
      }).catch((error: unknown) => {
        console.error('[网页收藏夹] 调整浮层窗口尺寸失败:', error)
      })
    }

    frameId = requestAnimationFrame(syncWindowSize)
    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId)
      observer?.disconnect()
    }
  }, [snapshot?.activeTabId])

  const activeTab: WebTabState | undefined = snapshot?.tabs.find((tab) => tab.id === snapshot.activeTabId)
  const closeWindow = React.useCallback((): void => {
    void window.electronAPI.webTabs.bookmarksClose()
  }, [])
  const navigateToBookmark = React.useCallback(async (url: string): Promise<void> => {
    if (!activeTab) return
    await window.electronAPI.webTabs.navigate({ tabId: activeTab.id, url })
  }, [activeTab])

  return (
    <TooltipProvider delayDuration={200}>
      <div className="h-screen w-screen overflow-hidden bg-transparent">
        {activeTab ? (
          <WebBookmarksPopover
            activeTab={activeTab}
            onNavigate={navigateToBookmark}
            standalone
            onRequestClose={closeWindow}
          />
        ) : null}
        <Toaster position="bottom-right" />
      </div>
    </TooltipProvider>
  )
}
