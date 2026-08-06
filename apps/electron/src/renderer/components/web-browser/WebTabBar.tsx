import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Globe2, LoaderCircle, Plus, X } from 'lucide-react'
import type { WebTabsSnapshot } from '@copis/shared'
import { activeWebTabIdAtom, webTabsAtom } from '@/atoms/web-tabs'
import { cn } from '@/lib/utils'
import {
  detectIsMac,
  detectIsWindows,
  WINDOW_CONTROLS_INSET_RIGHT,
  WINDOW_CONTROLS_PADDING_RIGHT,
} from '@/lib/platform'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CopisTemplateLogo } from '@/lib/model-logo'

function applySnapshot(
  snapshot: WebTabsSnapshot,
  setTabs: (tabs: WebTabsSnapshot['tabs']) => void,
  setActiveTabId: (tabId: string | null) => void,
): void {
  setTabs(snapshot.tabs)
  setActiveTabId(snapshot.activeTabId)
}

export function WebTabBar(): React.ReactElement {
  const tabs = useAtomValue(webTabsAtom)
  const activeTabId = useAtomValue(activeWebTabIdAtom)
  const setTabs = useSetAtom(webTabsAtom)
  const setActiveTabId = useSetAtom(activeWebTabIdAtom)
  const isMac = React.useMemo(() => detectIsMac(), [])
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  const [isCreating, setIsCreating] = React.useState(false)

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

  return (
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
            onActivate={() => void activate(tab.id)}
            onClose={() => void close(tab.id)}
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
      <img src={CopisTemplateLogo} alt="" className="size-3.5 shrink-0 rounded object-cover" />
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
  onActivate,
  onClose,
}: {
  tab: WebTabsSnapshot['tabs'][number]
  active: boolean
  onActivate: () => void
  onClose: () => void
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
      className={cn(
        'web-tab-shape titlebar-no-drag group relative mb-0 flex h-[34px] min-w-[144px] max-w-[240px] shrink-0 items-center gap-2 px-3 text-xs transition-colors',
        active
          ? 'bg-muted text-foreground shadow-[0_-1px_0_hsl(var(--border)/0.6)]'
          : 'bg-content-area text-muted-foreground hover:bg-accent/70 hover:text-foreground',
      )}
      onClick={onActivate}
    >
      {tab.isLoading ? (
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
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') handleClose(event as unknown as React.MouseEvent)
        }}
      >
        <X className="size-3" />
      </span>
    </button>
  )
}
