import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { ArrowLeft, ArrowRight, CircleStop, ExternalLink, Globe2, RotateCw, ShieldCheck } from 'lucide-react'
import type { WebTabsSnapshot } from '@copis/shared'
import { browserAgentPanelOpenAtom, browserAgentPanelWidthAtom, browserAgentSessionIdAtom, browserWorkflowStatusAtom } from '@/atoms/browser-agent'
import { activeWebTabAtom, activeWebTabIdAtom, webTabsAtom } from '@/atoms/web-tabs'
import { agentChannelIdAtom, agentModelIdAtom, agentSessionsAtom, agentWorkspacesAtom, currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import { draftSessionIdsAtom } from '@/atoms/draft-session-atoms'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { CopisTemplateLogo } from '@/lib/model-logo'
import { getBrowserWorkflowToolbarAction } from './browser-workflow-toolbar'
import { toast } from 'sonner'
import { WebBookmarksPopover } from './WebBookmarksPopover'
import { BrowserAgentPanel } from './BrowserAgentPanel'

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
  const agentChannelId = useAtomValue(agentChannelIdAtom)
  const agentModelId = useAtomValue(agentModelIdAtom)
  const agentWorkspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const agentSessions = useAtomValue(agentSessionsAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const setDraftSessionIds = useSetAtom(draftSessionIdsAtom)
  const browserAgentSessionId = useAtomValue(browserAgentSessionIdAtom)
  const setBrowserAgentSessionId = useSetAtom(browserAgentSessionIdAtom)
  const browserAgentPanelOpen = useAtomValue(browserAgentPanelOpenAtom)
  const [browserAgentPanelWidth, setBrowserAgentPanelWidth] = useAtom(browserAgentPanelWidthAtom)
  const setBrowserAgentPanelOpen = useSetAtom(browserAgentPanelOpenAtom)
  const browserWorkflowStatus = useAtomValue(browserWorkflowStatusAtom)
  const setBrowserWorkflowStatus = useSetAtom(browserWorkflowStatusAtom)
  const browserAgentSession = agentSessions.find((session) => session.id === browserAgentSessionId)
  const addressInputRef = React.useRef<HTMLInputElement>(null)
  const hostRef = React.useRef<HTMLDivElement>(null)
  const [address, setAddress] = React.useState('')
  const [browserWorkflowEnabled, setBrowserWorkflowEnabled] = React.useState<boolean | null>(null)
  const [browserActionPending, setBrowserActionPending] = React.useState(false)
  const browserActionPendingRef = React.useRef(false)

  React.useEffect(() => {
    let active = true
    void window.electronAPI.getSettings().then((settings) => {
      if (active) setBrowserWorkflowEnabled(settings.browserWorkflowEnabled !== false)
    }).catch((error) => {
      console.error('[Browser Workflow] 读取功能开关失败:', error)
    })
    return () => {
      active = false
    }
  }, [])

  React.useEffect(() => {
    if (!browserWorkflowEnabled && browserAgentPanelOpen) setBrowserAgentPanelOpen(false)
  }, [browserAgentPanelOpen, browserWorkflowEnabled, setBrowserAgentPanelOpen])

  React.useEffect(() => {
    return window.electronAPI.browserWorkflow.onStatusChanged((event) => {
      if (event.sessionId === browserAgentSessionId) setBrowserWorkflowStatus(event.status)
    })
  }, [browserAgentSessionId, setBrowserWorkflowStatus])

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

  const ensureBrowserAgentSession = React.useCallback(async (): Promise<string> => {
    if (!activeTabId || !activeTab) throw new Error('当前没有可用的网页页签')
    if (!/^https?:\/\//i.test(activeTab.url)) throw new Error('请先打开 HTTP(S) 网页')
    if (browserAgentSessionId) {
      await window.electronAPI.browserWorkflow.bindContext(browserAgentSessionId, { tabId: activeTabId })
      return browserAgentSessionId
    }
    if (!agentChannelId) throw new Error('请先配置 Agent 渠道')
    try {
      const association = await window.electronAPI.webTabs.getProjectAssociation(activeTab.url)
      const associatedWorkspace = association
        ? agentWorkspaces.find((workspace) => workspace.id === association.workspaceId)
        : undefined
      const defaultWorkspace = agentWorkspaces.find((workspace) => workspace.slug === 'default') ?? agentWorkspaces[0]
      const workspaceId = associatedWorkspace?.id ?? defaultWorkspace?.id ?? currentWorkspaceId
      if (!workspaceId) throw new Error('没有可用的 Agent 项目')

      const session = await window.electronAPI.createAgentSession(
        '网页 Browser Agent',
        agentChannelId ?? undefined,
        workspaceId,
        agentModelId ?? undefined,
      )
      await window.electronAPI.browserWorkflow.bindContext(session.id, { tabId: activeTabId })
      setAgentSessions((sessions) => [...sessions, session])
      setDraftSessionIds((previous) => {
        const next = new Set(previous)
        next.add(session.id)
        return next
      })
      setBrowserAgentSessionId(session.id)
      setBrowserWorkflowStatus({ sessionId: session.id, state: 'idle' })
      return session.id
    } catch (error) {
      throw error instanceof Error ? error : new Error('无法打开网页 Agent')
    }
  }, [activeTabId, activeTab, agentChannelId, agentModelId, agentWorkspaces, browserAgentSessionId, currentWorkspaceId, setAgentSessions, setDraftSessionIds, setBrowserAgentSessionId, setBrowserWorkflowStatus])

  const summarizeBrowserRecording = React.useCallback((sessionId: string): void => {
    const session = agentSessions.find((item) => item.id === sessionId)
    const channelId = session?.channelId ?? agentChannelId
    if (!channelId) {
      toast.error('录制已停止，但当前没有可用的 Agent 渠道')
      return
    }
    void window.electronAPI.sendAgentMessage({
      sessionId,
      userMessage: '请读取刚刚完成的网页操作 JSONL，并总结为待审核的 Browser Workflow 草稿。先调用 BrowserWorkflowRecordingGet，再调用 BrowserWorkflowDraft；不要直接保存。',
      channelId,
      modelId: session?.modelId ?? agentModelId ?? undefined,
      agentRuntime: 'pi',
      workspaceId: session?.workspaceId ?? currentWorkspaceId ?? undefined,
      triggeredBy: 'user',
    }).catch((error) => {
      console.error('[Browser Workflow] 请求 Agent 总结录制失败:', error)
      toast.error(error instanceof Error ? error.message : '无法请求 Agent 总结网页操作')
    })
  }, [agentChannelId, agentModelId, agentSessions, currentWorkspaceId])

  const handleStartRecording = React.useCallback(async (): Promise<void> => {
    if (!browserWorkflowEnabled || browserActionPendingRef.current) return
    const session = browserAgentSessionId
      ? agentSessions.find((item) => item.id === browserAgentSessionId)
      : undefined
    if (!session?.channelId && !agentChannelId) {
      toast.error('请先配置 Agent 渠道')
      return
    }
    browserActionPendingRef.current = true
    setBrowserActionPending(true)
    try {
      const sessionId = await ensureBrowserAgentSession()
      setBrowserAgentPanelOpen(true)
      const status = await window.electronAPI.browserWorkflow.startRecording(sessionId)
      setBrowserWorkflowStatus(status)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法开始记录网页操作')
    } finally {
      browserActionPendingRef.current = false
      setBrowserActionPending(false)
    }
  }, [agentChannelId, agentSessions, browserAgentSessionId, browserWorkflowEnabled, ensureBrowserAgentSession, setBrowserAgentPanelOpen, setBrowserWorkflowStatus])

  const handleStopRecording = React.useCallback(async (): Promise<void> => {
    if (!browserAgentSessionId || browserActionPendingRef.current) return
    browserActionPendingRef.current = true
    setBrowserActionPending(true)
    try {
      await window.electronAPI.browserWorkflow.stopRecording(browserAgentSessionId)
      const status = await window.electronAPI.browserWorkflow.getStatus(browserAgentSessionId)
      setBrowserWorkflowStatus(status)
      setBrowserAgentPanelOpen(true)
      summarizeBrowserRecording(browserAgentSessionId)
      toast.success('网页操作已停止，Agent 正在总结录制内容')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法停止网页操作记录')
    } finally {
      browserActionPendingRef.current = false
      setBrowserActionPending(false)
    }
  }, [browserAgentSessionId, setBrowserAgentPanelOpen, setBrowserWorkflowStatus, summarizeBrowserRecording])

  const handleBrowserToolbarClick = React.useCallback((): void => {
    const action = getBrowserWorkflowToolbarAction(browserWorkflowStatus)
    if (action === 'stop-recording') {
      void handleStopRecording()
      return
    }
    if (action === 'open-agent') {
      setBrowserAgentPanelOpen(true)
      return
    }
    void handleStartRecording()
  }, [browserWorkflowStatus, handleStartRecording, handleStopRecording, setBrowserAgentPanelOpen])

  const handleCloseBrowserAgent = React.useCallback((): void => {
    setBrowserAgentPanelOpen(false)
  }, [setBrowserAgentPanelOpen])

  const handlePanelResizeStart = React.useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId)
    const handleMove = (moveEvent: PointerEvent): void => {
      const nextWidth = Math.min(560, Math.max(320, window.innerWidth - moveEvent.clientX))
      setBrowserAgentPanelWidth(nextWidth)
    }
    const handleUp = (): void => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp, { once: true })
  }, [setBrowserAgentPanelWidth])

  React.useEffect(() => {
    const workspaceId = browserAgentSession?.workspaceId
    if (!browserAgentSessionId || !workspaceId || !activeTab?.url || activeTab.url === 'about:blank') return
    void window.electronAPI.webTabs.saveProjectAssociation({ url: activeTab.url, workspaceId }).catch((error) => {
      console.error('[网页项目关联] 保存当前页面关联失败:', error)
    })
  }, [activeTab?.url, browserAgentSession?.workspaceId, browserAgentSessionId])

  React.useEffect(() => {
    if (!browserAgentSessionId || !activeTabId) return
    void window.electronAPI.browserWorkflow.bindContext(browserAgentSessionId, { tabId: activeTabId }).catch((error) => {
      console.error('[Browser Workflow] 切换绑定页签失败:', error)
    })
  }, [activeTabId, browserAgentSessionId])

  const browserAgentSessionIdRef = React.useRef<string | null>(null)
  React.useEffect(() => {
    browserAgentSessionIdRef.current = browserAgentSessionId
  }, [browserAgentSessionId])

  React.useEffect(() => {
    return () => {
      const sessionId = browserAgentSessionIdRef.current
      if (sessionId) {
        void window.electronAPI.browserWorkflow.unbindContext(sessionId).catch((error) => {
          console.error('[Browser Workflow] 页面宿主卸载时解除绑定失败:', error)
        })
      }
      setBrowserAgentSessionId(null)
      setBrowserAgentPanelOpen(false)
      setBrowserWorkflowStatus({ state: 'idle' })
    }
  }, [setBrowserAgentPanelOpen, setBrowserAgentSessionId, setBrowserWorkflowStatus])


  const handleBookmarkNavigate = React.useCallback(async (url: string): Promise<void> => {
    if (!activeTabId) return
    try {
      apply(await window.electronAPI.webTabs.navigate({ tabId: activeTabId, url }))
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '打开收藏失败'
      toast.error(message)
    }
  }, [activeTabId, apply])

  const browserToolbarAction = getBrowserWorkflowToolbarAction(browserWorkflowStatus)
  const browserToolbarIsRecording = browserToolbarAction === 'stop-recording'
  const browserToolbarLabel = browserToolbarIsRecording
    ? '停止记录网页操作'
    : browserToolbarAction === 'start-recording'
      ? '开始记录网页操作'
      : '打开 Copis 网页 Agent'

  if (!activeTab) {
    return <div className="hidden" aria-hidden="true" />
  }

  return (
    <div className="absolute inset-0 flex min-h-0 flex-col overflow-hidden bg-content-area text-foreground">
      <div className="titlebar-no-drag flex h-11 shrink-0 items-center gap-1 border-b border-border/60 bg-muted px-2">
        <BrowserToolbarButton label="后退" disabled={!activeTab.canGoBack} onClick={() => void handleBack()}>
          <ArrowLeft className="size-4 text-foreground" strokeWidth={2} />
        </BrowserToolbarButton>
        <BrowserToolbarButton label="前进" disabled={!activeTab.canGoForward} onClick={() => void handleForward()}>
          <ArrowRight className="size-4 text-foreground" strokeWidth={2} />
        </BrowserToolbarButton>
        <BrowserToolbarButton label="刷新" showTooltip={false} onClick={() => void handleReload()}>
          <RotateCw className={cn('size-3 text-foreground', activeTab.isLoading && 'animate-spin')} strokeWidth={2} />
        </BrowserToolbarButton>

        <WebBookmarksPopover activeTab={activeTab} onNavigate={handleBookmarkNavigate} />

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

        {browserWorkflowEnabled ? (
          <BrowserToolbarButton
            label={browserToolbarLabel}
            showTooltip={false}
            disabled={browserActionPending}
            onClick={handleBrowserToolbarClick}
          >
            {browserToolbarIsRecording ? (
              <CircleStop className="size-4 text-destructive" />
            ) : (
              <img
                src={CopisTemplateLogo}
                alt=""
                className={cn('size-4 rounded object-cover', browserAgentSessionId && 'ring-2 ring-primary/40')}
              />
            )}
          </BrowserToolbarButton>
        ) : null}

        <BrowserToolbarButton label="在系统浏览器打开" disabled={activeTab.url === 'about:blank'} onClick={handleOpenExternal}>
          <ExternalLink className="size-4" />
        </BrowserToolbarButton>
      </div>
      <div className="flex min-h-0 flex-1">
        <div ref={hostRef} className="relative min-w-0 flex-1 bg-white dark:bg-zinc-950" />
        {browserWorkflowEnabled && browserAgentSessionId && browserAgentPanelOpen && activeTabId ? (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整网页 Agent 面板宽度"
              className="z-10 w-1 shrink-0 cursor-col-resize bg-border/30 transition-colors hover:bg-primary/50"
              onPointerDown={handlePanelResizeStart}
            />
            <BrowserAgentPanel
              sessionId={browserAgentSessionId}
              tabId={activeTabId}
              pageUrl={activeTab.url}
              tabTitle={activeTab.title}
              workspaceId={browserAgentSession?.workspaceId}
              width={browserAgentPanelWidth}
              onStartRecording={handleStartRecording}
              onStopRecording={handleStopRecording}
              onClose={handleCloseBrowserAgent}
            />
          </>
        ) : null}
      </div>
    </div>
  )
}

function BrowserToolbarButton({
  label,
  disabled = false,
  showTooltip = true,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  showTooltip?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.ReactElement {
  const button = (
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
  )

  if (!showTooltip) return button

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {button}
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}
