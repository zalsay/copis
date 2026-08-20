import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Glasses, Globe2, LoaderCircle, Plus, X } from 'lucide-react'
import type { WebTabsSnapshot } from '@copis/shared'
import { activeWebTabIdAtom, webTabsAtom } from '@/atoms/web-tabs'
import { cn } from '@/lib/utils'
import {
  attachWebTabDragMouseListeners,
  getWebTabDragOffset,
  getWebTabDragMovePhase,
  getWebTabDropIndex,
  hasWebTabDragStarted,
  type WebTabDragOffset,
  type WebTabDropRect,
} from './web-tab-drag'
import {
  detectIsMac,
  detectIsWindows,
  WINDOW_CONTROLS_INSET_RIGHT,
  WINDOW_CONTROLS_PADDING_RIGHT,
} from '@/lib/platform'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CopisLogo } from '@/lib/model-logo'

function applySnapshot(
  snapshot: WebTabsSnapshot,
  setTabs: (tabs: WebTabsSnapshot['tabs']) => void,
  setActiveTabId: (tabId: string | null) => void,
): void {
  setTabs(snapshot.tabs)
  setActiveTabId(snapshot.activeTabId)
}

interface PendingWebTabDrag {
  tabId: string
  startX: number
  startY: number
}

interface ActiveWebTabDrag extends PendingWebTabDrag {
  dropIndex: number | null
}

const WEB_TAB_DRAG_THRESHOLD = 6

function logWebTabDrag(message: string, details?: Record<string, unknown>): void {
  console.info(`[网页页签拖动] ${message}`, details ?? '')
}

export function WebTabBar(): React.ReactElement {
  const tabs = useAtomValue(webTabsAtom)
  const activeTabId = useAtomValue(activeWebTabIdAtom)
  const setTabs = useSetAtom(webTabsAtom)
  const setActiveTabId = useSetAtom(activeWebTabIdAtom)
  const isMac = React.useMemo(() => detectIsMac(), [])
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  const [isCreating, setIsCreating] = React.useState(false)
  const [draggingTabId, setDraggingTabId] = React.useState<string | null>(null)
  const [dragOffset, setDragOffset] = React.useState<WebTabDragOffset | null>(null)
  const pendingDragRef = React.useRef<PendingWebTabDrag | null>(null)
  const activeDragRef = React.useRef<ActiveWebTabDrag | null>(null)
  const pointerListenersCleanupRef = React.useRef<(() => void) | null>(null)
  const suppressedClickTabIdRef = React.useRef<string | null>(null)
  const tabButtonRefs = React.useRef(new Map<string, HTMLButtonElement>())

  const apply = React.useCallback((snapshot: WebTabsSnapshot): void => {
    applySnapshot(snapshot, setTabs, setActiveTabId)
  }, [setActiveTabId, setTabs])

  React.useEffect(() => {
    let mounted = true
    const load = async (): Promise<void> => {
      try {
        const snapshot = await window.electronAPI.webTabs.list()
        if (mounted) apply(snapshot)
      } catch (error) {
        console.error('[网页页签] 初始化失败:', error)
      }
    }
    void load()

    const unsubscribe = window.electronAPI.webTabs.onChanged((snapshot) => {
      if (mounted) apply(snapshot)
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [apply])

  const activate = React.useCallback(async (tabId: string | null): Promise<void> => {
    setActiveTabId(tabId)
    try {
      apply(await window.electronAPI.webTabs.activate(tabId))
    } catch (error) {
      console.error('[网页页签] 切换失败:', error)
    }
  }, [apply, setActiveTabId])

  const create = React.useCallback(async (): Promise<void> => {
    if (isCreating) return
    setIsCreating(true)
    try {
      apply(await window.electronAPI.webTabs.create({ url: 'about:blank', activate: true }))
    } catch (error) {
      console.error('[网页页签] 创建失败:', error)
    } finally {
      setIsCreating(false)
    }
  }, [apply, isCreating])

  const close = React.useCallback(async (tabId: string): Promise<void> => {
    try {
      apply(await window.electronAPI.webTabs.close(tabId))
    } catch (error) {
      console.error('[网页页签] 关闭失败:', error)
    }
  }, [apply])

  const setTabButtonRef = React.useCallback((tabId: string, element: HTMLButtonElement | null): void => {
    if (element) tabButtonRefs.current.set(tabId, element)
    else tabButtonRefs.current.delete(tabId)
  }, [])

  const getDropIndexAt = React.useCallback((tabId: string, pointerX: number): number | null => {
    const rects: WebTabDropRect[] = tabs.flatMap((tab) => {
      const element = tabButtonRefs.current.get(tab.id)
      if (!element) return []
      const rect = element.getBoundingClientRect()
      return [{ id: tab.id, left: rect.left, right: rect.right }]
    })
    return getWebTabDropIndex(pointerX, rects, tabId)
  }, [tabs])

  const clearDragState = React.useCallback((): void => {
    logWebTabDrag('清理 React 拖动状态', {
      pendingTabId: pendingDragRef.current?.tabId ?? null,
      activeTabId: activeDragRef.current?.tabId ?? null,
    })
    pointerListenersCleanupRef.current?.()
    pointerListenersCleanupRef.current = null
    pendingDragRef.current = null
    activeDragRef.current = null
    setDraggingTabId(null)
    setDragOffset(null)
  }, [])

  const handleTabMouseMove = React.useCallback((tabId: string, event: MouseEvent): void => {
    const pending = pendingDragRef.current
    const active = activeDragRef.current
    const phase = getWebTabDragMovePhase(tabId, pending?.tabId ?? null, active?.tabId ?? null)

    if (phase === 'active' && active) {
      event.preventDefault()
      const nextDropIndex = getDropIndexAt(tabId, event.clientX)
      activeDragRef.current = { ...active, dropIndex: nextDropIndex }
      setDragOffset(getWebTabDragOffset(active.startX, event.clientX))
      logWebTabDrag('处理已激活移动', {
        tabId,
        clientX: event.clientX,
        clientY: event.clientY,
        dropIndex: nextDropIndex,
      })
      return
    }

    if (phase !== 'pending' || !pending) {
      logWebTabDrag('收到移动但没有匹配的待处理拖动', {
        tabId,
        pendingTabId: pending?.tabId ?? null,
        clientX: event.clientX,
        clientY: event.clientY,
      })
      return
    }

    const started = hasWebTabDragStarted(pending.startX, pending.startY, event.clientX, event.clientY, WEB_TAB_DRAG_THRESHOLD)
    logWebTabDrag('处理待开始移动', {
      tabId,
      startX: pending.startX,
      startY: pending.startY,
      clientX: event.clientX,
      clientY: event.clientY,
      distance: Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY),
      threshold: WEB_TAB_DRAG_THRESHOLD,
      started,
    })
    if (!started) return
    const nextDropIndex = getDropIndexAt(tabId, event.clientX)
    if (nextDropIndex === null) {
      logWebTabDrag('达到拖动阈值但无法计算落点', { tabId, clientX: event.clientX })
      return
    }
    event.preventDefault()
    activeDragRef.current = { ...pending, dropIndex: nextDropIndex }
    pendingDragRef.current = null
    setDraggingTabId(tabId)
    setDragOffset(getWebTabDragOffset(pending.startX, event.clientX))
    logWebTabDrag('拖动已激活', { tabId, clientX: event.clientX, dropIndex: nextDropIndex })
  }, [getDropIndexAt])

  const finishTabMouse = React.useCallback(async (
    tabId: string,
    event: MouseEvent,
  ): Promise<void> => {
    logWebTabDrag('处理 mouseup', {
      tabId,
      clientX: event.clientX,
      clientY: event.clientY,
      pendingTabId: pendingDragRef.current?.tabId ?? null,
      activeTabId: activeDragRef.current?.tabId ?? null,
    })
    const pending = pendingDragRef.current
    if (pending?.tabId === tabId) {
      pendingDragRef.current = null
      return
    }

    const active = activeDragRef.current
    if (!active || active.tabId !== tabId) return

    event.preventDefault()

    const targetIndex = active.dropIndex
    suppressedClickTabIdRef.current = tabId
    clearDragState()
    if (targetIndex === null) return

    try {
      apply(await window.electronAPI.webTabs.reorder({ tabId, targetIndex }))
    } catch (error) {
      console.error('[网页页签] 拖动排序失败:', error)
    }
  }, [apply, clearDragState])

  const handleTabPointerDown = React.useCallback((tabId: string, event: React.PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0 || event.isPrimary === false) return
    pointerListenersCleanupRef.current?.()
    pointerListenersCleanupRef.current = null

    pendingDragRef.current = {
      tabId,
      startX: event.clientX,
      startY: event.clientY,
    }
    logWebTabDrag('记录 pointerdown，开始等待拖动阈值', {
      tabId,
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      pointerType: event.pointerType,
      buttons: event.buttons,
    })

    pointerListenersCleanupRef.current = attachWebTabDragMouseListeners(
      document,
      (moveEvent) => handleTabMouseMove(tabId, moveEvent),
      (endEvent) => { void finishTabMouse(tabId, endEvent) },
    )
  }, [finishTabMouse, handleTabMouseMove])

  React.useEffect(() => {
    return () => {
      pointerListenersCleanupRef.current?.()
      pointerListenersCleanupRef.current = null
    }
  }, [])

  const handleTabActivate = React.useCallback((tabId: string): void => {
    if (suppressedClickTabIdRef.current === tabId) {
      suppressedClickTabIdRef.current = null
      return
    }
    void activate(tabId)
  }, [activate])

  return (
    <>
      <div className="relative z-[70] flex h-[38px] shrink-0 items-end border-b border-border/70 bg-[hsl(var(--tabbar-surface))] text-foreground">
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-y-0 left-0 titlebar-drag-region',
          isWindows ? WINDOW_CONTROLS_INSET_RIGHT : 'right-0',
        )}
      />
      <div
        className={cn(
          'relative flex h-full min-w-0 flex-1 items-end gap-0.5 overflow-x-auto px-1 scrollbar-none',
          isMac && 'pl-[96px]',
          isWindows && WINDOW_CONTROLS_PADDING_RIGHT,
        )}
      >
        <WebHomeTab active={activeTabId === null} onClick={() => void activate(null)} />

        {tabs.map((tab) => (
          <WebTabItem
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            isDragging={tab.id === draggingTabId}
            dragOffset={tab.id === draggingTabId ? dragOffset : null}
            buttonRef={(element) => setTabButtonRef(tab.id, element)}
            onActivate={() => handleTabActivate(tab.id)}
            onClose={() => void close(tab.id)}
            onPointerDown={(event) => handleTabPointerDown(tab.id, event)}
          />
        ))}

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="新建网页"
              className="titlebar-no-drag mb-1 ml-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              onClick={() => void create()}
              disabled={isCreating}
            >
              {isCreating ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">新建网页</TooltipContent>
        </Tooltip>
      </div>
      </div>
    </>
  )
}

function WebHomeTab({ active, onClick }: { active: boolean; onClick: () => void }): React.ReactElement {
  return (
    <button
      type="button"
      aria-label="打开 Copis 首页"
      aria-current={active ? 'page' : undefined}
      className={cn(
        'web-tab-shape titlebar-no-drag group relative mb-0 flex h-[34px] min-w-[144px] max-w-[220px] shrink-0 items-center gap-2 px-3 text-xs transition-colors',
        active
          ? 'bg-muted text-foreground shadow-[0_-1px_0_hsl(var(--border)/0.6)]'
          : 'bg-content-area text-muted-foreground hover:bg-accent/70 hover:text-foreground',
      )}
      onClick={onClick}
    >
      <img src={CopisLogo} alt="" className="size-3.5 shrink-0 rounded object-cover" />
      <span className="min-w-0 flex-1 truncate text-left font-medium">Copis 首页</span>
    </button>
  )
}

function WebTabIcon({ tab }: { tab: WebTabsSnapshot['tabs'][number] }): React.ReactElement {
  const [failedFavicon, setFailedFavicon] = React.useState<string | null>(null)

  React.useEffect(() => {
    setFailedFavicon(null)
  }, [tab.faviconUrl])

  if (!tab.faviconUrl || failedFavicon === tab.faviconUrl) {
    return <Globe2 className="size-3.5 shrink-0" />
  }

  return (
    <img
      src={tab.faviconUrl}
      alt=""
      aria-hidden="true"
      className="size-3.5 shrink-0 rounded-sm object-contain"
      onError={() => setFailedFavicon(tab.faviconUrl)}
    />
  )
}

function WebTabItem({
  tab,
  active,
  isDragging,
  dragOffset,
  buttonRef,
  onActivate,
  onClose,
  onPointerDown,
}: {
  tab: WebTabsSnapshot['tabs'][number]
  active: boolean
  isDragging: boolean
  dragOffset: WebTabDragOffset | null
  buttonRef: (element: HTMLButtonElement | null) => void
  onActivate: () => void
  onClose: () => void
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void
}): React.ReactElement {
  const handleClose = (event: React.MouseEvent): void => {
    event.stopPropagation()
    onClose()
  }

  return (
    <button
      type="button"
      aria-label={`打开 ${tab.title}`}
      aria-current={active ? 'page' : undefined}
      aria-grabbed={isDragging}
      data-web-tab-id={tab.id}
      draggable={false}
      className={cn(
        'web-tab-shape titlebar-no-drag touch-none select-none group relative mb-0 flex h-[34px] min-w-[144px] max-w-[240px] shrink-0 items-center gap-2 px-3 text-xs transition-colors',
        active
          ? 'bg-muted text-foreground shadow-[0_-1px_0_hsl(var(--border)/0.6)]'
          : 'bg-content-area text-muted-foreground hover:bg-accent/70 hover:text-foreground',
        isDragging && 'z-20 shadow-xl',
      )}
      style={dragOffset ? { transform: `translate3d(${dragOffset.x}px, 0, 0)`, zIndex: 20 } : undefined}
      ref={buttonRef}
      onClick={onActivate}
      onPointerDown={onPointerDown}
    >
      {tab.isIncognito ? (
        <Glasses className="size-3.5 shrink-0 text-primary" />
      ) : tab.isLoading ? (
        <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" />
      ) : (
        <WebTabIcon tab={tab} />
      )}
      <span className="min-w-0 flex-1 truncate text-left">{tab.title || '新标签页'}</span>
      <span
        role="button"
        tabIndex={-1}
        aria-label={`关闭 ${tab.title}`}
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-colors hover:bg-muted-foreground/15 hover:text-foreground group-hover:opacity-100',
          active && 'opacity-70',
        )}
        onClick={handleClose}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') handleClose(event as unknown as React.MouseEvent)
        }}
      >
        <X className="size-3" />
      </span>
    </button>
  )
}
