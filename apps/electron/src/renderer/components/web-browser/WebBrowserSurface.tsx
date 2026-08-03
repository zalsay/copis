import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { ArrowLeft, ArrowRight, ExternalLink, Globe2, RotateCw, ShieldCheck } from 'lucide-react'
import type { WebTabsSnapshot } from '@proma/shared'
import { activeWebTabAtom, activeWebTabIdAtom, webTabsAtom } from '@/atoms/web-tabs'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

function applySnapshot(
  snapshot: WebTabsSnapshot,
  setTabs: (tabs: WebTabsSnapshot['tabs']) => void,
  setActiveTabId: (tabId: string | null) => void,
): void {
  setTabs(snapshot.tabs)
  setActiveTabId(snapshot.activeTabId)
}

export function WebBrowserSurface(): React.ReactElement {
  const activeTab = useAtomValue(activeWebTabAtom)
  const activeTabId = useAtomValue(activeWebTabIdAtom)
  const setTabs = useSetAtom(webTabsAtom)
  const setActiveTabId = useSetAtom(activeWebTabIdAtom)
  const hostRef = React.useRef<HTMLDivElement>(null)
  const addressInputRef = React.useRef<HTMLInputElement>(null)
  const [address, setAddress] = React.useState('')

  React.useEffect(() => {
    setAddress(activeTab?.url ?? '')
    if (activeTab?.url === 'about:blank') {
      requestAnimationFrame(() => addressInputRef.current?.focus())
    }
  }, [activeTab?.id, activeTab?.url])

  React.useLayoutEffect(() => {
    const host = hostRef.current
    if (!host || !activeTabId) return

    const updateBounds = (): void => {
      const rect = host.getBoundingClientRect()
      void window.electronAPI.webTabs.updateBounds({
        tabId: activeTabId,
        bounds: {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        },
      }).catch((error) => {
        console.error('[网页页签] 更新视图尺寸失败:', error)
      })
    }

    updateBounds()
    const observer = new ResizeObserver(updateBounds)
    observer.observe(host)
    window.addEventListener('resize', updateBounds)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateBounds)
    }
  }, [activeTabId])

  const apply = React.useCallback((snapshot: WebTabsSnapshot): void => {
    applySnapshot(snapshot, setTabs, setActiveTabId)
  }, [setActiveTabId, setTabs])

  const handleNavigate = React.useCallback(async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!activeTabId) return
    try {
      apply(await window.electronAPI.webTabs.navigate({ tabId: activeTabId, url: address }))
    } catch (error) {
      const message = error instanceof Error ? error.message : '网页地址无效'
      toast.error(message)
    }
  }, [activeTabId, address, apply])

  const handleBack = React.useCallback(async (): Promise<void> => {
    if (!activeTabId || !activeTab?.canGoBack) return
    apply(await window.electronAPI.webTabs.goBack(activeTabId))
  }, [activeTab?.canGoBack, activeTabId, apply])

  const handleForward = React.useCallback(async (): Promise<void> => {
    if (!activeTabId || !activeTab?.canGoForward) return
    apply(await window.electronAPI.webTabs.goForward(activeTabId))
  }, [activeTab?.canGoForward, activeTabId, apply])

  const handleReload = React.useCallback(async (): Promise<void> => {
    if (!activeTabId) return
    apply(await window.electronAPI.webTabs.reload(activeTabId))
  }, [activeTabId, apply])

  const handleOpenExternal = React.useCallback((): void => {
    if (!activeTab || activeTab.url === 'about:blank') return
    void window.electronAPI.openExternal(activeTab.url).catch((error) => {
      console.error('[网页页签] 打开系统浏览器失败:', error)
    })
  }, [activeTab])

  if (!activeTab) {
    return <div className="hidden" aria-hidden="true" />
  }

  return (
    <div className="absolute inset-0 flex min-h-0 flex-col overflow-hidden bg-content-area text-foreground">
      <div className="titlebar-no-drag flex h-11 shrink-0 items-center gap-1 border-b border-border/60 bg-content-area px-2">
        <BrowserToolbarButton label="后退" disabled={!activeTab.canGoBack} onClick={() => void handleBack()}>
          <ArrowLeft className="size-4 text-foreground" strokeWidth={2} />
        </BrowserToolbarButton>
        <BrowserToolbarButton label="前进" disabled={!activeTab.canGoForward} onClick={() => void handleForward()}>
          <ArrowRight className="size-4 text-foreground" strokeWidth={2} />
        </BrowserToolbarButton>
        <BrowserToolbarButton label="刷新" onClick={() => void handleReload()}>
          <RotateCw className={cn('size-3 text-foreground', activeTab.isLoading && 'animate-spin')} strokeWidth={2} />
        </BrowserToolbarButton>

        <form className="ml-1 flex min-w-0 flex-1 items-center" onSubmit={(event) => void handleNavigate(event)}>
          <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-border/70 bg-input-surface px-3 shadow-xs focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-ring/20">
            {activeTab.url.startsWith('https://') ? (
              <ShieldCheck className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <Globe2 className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <input
              ref={addressInputRef}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              aria-label="网页地址"
              className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
              placeholder="输入网址或搜索内容"
              spellCheck={false}
            />
          </div>
        </form>

        <Tooltip>
          <TooltipTrigger asChild>
            <span className="ml-1 inline-flex h-7 items-center gap-1 rounded-md px-2 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              CDP
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{activeTab.cdpAttached ? 'CDP 已连接' : 'CDP 未连接'}</TooltipContent>
        </Tooltip>

        <BrowserToolbarButton label="在系统浏览器打开" disabled={activeTab.url === 'about:blank'} onClick={handleOpenExternal}>
          <ExternalLink className="size-4" />
        </BrowserToolbarButton>
      </div>
      <div ref={hostRef} className="relative min-h-0 flex-1 bg-white dark:bg-zinc-950" />
    </div>
  )
}

function BrowserToolbarButton({
  label,
  disabled = false,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}
