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
import { CopisAgentLogo } from '@/lib/model-logo'
import {
  createBrowserAgentBindingQueue,
  getBrowserWorkflowToolbarAction,
  isCurrentBrowserAgentContextRequest,
  shouldFinalizeBrowserAgentUnmount,
  shouldCommitBrowserAgentAction,
  type BrowserAgentBindingQueue,
  type BrowserAgentBindingResult,
  type BrowserAgentContextRequest,
  type BrowserAgentTarget,
} from './browser-workflow-toolbar'
import {
  browserAgentUnmountPolicy,
  createAndSwitchBrowserAgentSession,
  resolveBrowserAgentWorkspaceId,
  selectBrowserAgentSession,
} from './browser-agent-session-policy'
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

interface BrowserAgentSessionBinding {
  sessionId: string
  binding: BrowserAgentBindingResult
  isNewSession: boolean
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
  const browserAgentContextRequestRef = React.useRef<BrowserAgentContextRequest | null>(null)
  const browserAgentActionRequestIdRef = React.useRef(0)
  const browserAgentMountedRef = React.useRef(true)
  const browserAgentLifecycleGenerationRef = React.useRef(0)
  const browserAgentSessionIdRef = React.useRef<string | null>(browserAgentSessionId)
  const browserAgentBindingQueueRef = React.useRef<BrowserAgentBindingQueue | null>(null)
  if (!browserAgentBindingQueueRef.current) {
    browserAgentBindingQueueRef.current = createBrowserAgentBindingQueue({
      bindContext: (sessionId, tabId) => window.electronAPI.browserWorkflow.bindContext(sessionId, { tabId }),
      unbindContext: (sessionId) => window.electronAPI.browserWorkflow.unbindContext(sessionId),
    })
  }
  const browserAgentBindingQueue = browserAgentBindingQueueRef.current
  const browserAgentTargetRef = React.useRef<BrowserAgentTarget>({
    tabId: activeTabId ?? '',
    pageUrl: activeTab?.url ?? '',
  })

  React.useLayoutEffect(() => {
    browserAgentTargetRef.current = {
      tabId: activeTabId ?? '',
      pageUrl: activeTab?.url ?? '',
    }
  }, [activeTab?.url, activeTabId])

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

  const resolveBrowserAgentProjectId = React.useCallback(async (): Promise<string> => {
    if (!activeTab) throw new Error('当前没有可用的网页页签')
    const association = await window.electronAPI.webTabs.getProjectAssociation(activeTab.url)
    const workspaceId = resolveBrowserAgentWorkspaceId(
      association?.workspaceId,
      agentWorkspaces,
      currentWorkspaceId,
    )
    if (!workspaceId) throw new Error('没有可用的 Agent 项目')
    return workspaceId
  }, [activeTab, agentWorkspaces, currentWorkspaceId])

  const createBrowserAgentDraftSession = React.useCallback(async (
    workspaceId: string,
    channelId: string | undefined,
    modelId: string | undefined,
  ) => {
    if (!channelId) throw new Error('请先配置 Agent 渠道')
    const session = await window.electronAPI.createAgentSession(
      '网页 AI浏览器',
      channelId,
      workspaceId,
      modelId,
    )
    setAgentSessions((sessions) => [...sessions, session])
    setDraftSessionIds((previous) => {
      const next = new Set(previous)
      next.add(session.id)
      return next
    })
    return session
  }, [setAgentSessions, setDraftSessionIds])

  const ensureBrowserAgentSession = React.useCallback(async (): Promise<BrowserAgentSessionBinding> => {
    if (!activeTabId || !activeTab) throw new Error('当前没有可用的网页页签')
    if (!/^https?:\/\//i.test(activeTab.url)) throw new Error('请先打开 HTTP(S) 网页')
    let sessions = agentSessions
    if (browserAgentSessionId && !sessions.some((session) => session.id === browserAgentSessionId)) {
      sessions = await window.electronAPI.listAgentSessions()
      setAgentSessions(sessions)
    }
    try {
      const workspaceId = await resolveBrowserAgentProjectId()
      const selection = selectBrowserAgentSession({
        persistedSessionId: browserAgentSessionId,
        projectId: workspaceId,
        availableWorkspaceIds: agentWorkspaces.map((workspace) => workspace.id),
        sessions,
      })
      if (selection.sessionId) {
        const binding = await browserAgentBindingQueue.bind(selection.sessionId, activeTabId)
        return { sessionId: selection.sessionId, binding, isNewSession: false }
      }

      const session = await createBrowserAgentDraftSession(
        workspaceId,
        agentChannelId ?? undefined,
        agentModelId ?? undefined,
      )
      const binding = await browserAgentBindingQueue.bind(session.id, activeTabId)
      if (browserAgentSessionId && browserAgentSessionId !== session.id) {
        await browserAgentBindingQueue.unbindAfterPending(browserAgentSessionId).catch((error) => {
          console.error('[Browser Workflow] 自动切换项目后旧页面绑定未能解除:', error)
        })
      }
      return { sessionId: session.id, binding, isNewSession: true }
    } catch (error) {
      throw error instanceof Error ? error : new Error('无法打开网页 Agent')
    }
  }, [activeTabId, activeTab, agentChannelId, agentModelId, agentSessions, agentWorkspaces, browserAgentBindingQueue, browserAgentSessionId, createBrowserAgentDraftSession, resolveBrowserAgentProjectId, setAgentSessions])

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
    const requestId = browserAgentActionRequestIdRef.current + 1
    browserAgentActionRequestIdRef.current = requestId
    const requestedTarget: BrowserAgentTarget = {
      tabId: activeTabId ?? '',
      pageUrl: activeTab?.url ?? '',
    }
    browserActionPendingRef.current = true
    setBrowserActionPending(true)
    try {
      const ensured = await ensureBrowserAgentSession()
      const canCommit = shouldCommitBrowserAgentAction(
        requestId,
        browserAgentActionRequestIdRef.current,
        browserAgentMountedRef.current,
        requestedTarget,
        browserAgentTargetRef.current,
      )
      if (!canCommit) {
        await browserAgentBindingQueue.unbindIfCurrent(ensured.binding).catch((error) => {
          console.error('[Browser Workflow] 失效的录制请求解除绑定失败:', error)
        })
        return
      }
      if (ensured.isNewSession) {
        browserAgentSessionIdRef.current = ensured.sessionId
        setBrowserAgentSessionId(ensured.sessionId)
        setBrowserWorkflowStatus({ sessionId: ensured.sessionId, state: 'idle' })
      }
      setBrowserAgentPanelOpen(true)
      const status = await browserAgentBindingQueue.runAfterPending(
        () => window.electronAPI.browserWorkflow.startRecording(ensured.sessionId),
      )
      if (!shouldCommitBrowserAgentAction(
        requestId,
        browserAgentActionRequestIdRef.current,
        browserAgentMountedRef.current,
        requestedTarget,
        browserAgentTargetRef.current,
      )) return
      setBrowserWorkflowStatus(status)
    } catch (error) {
      if (shouldCommitBrowserAgentAction(
        requestId,
        browserAgentActionRequestIdRef.current,
        browserAgentMountedRef.current,
        requestedTarget,
        browserAgentTargetRef.current,
      )) {
        toast.error(error instanceof Error ? error.message : '无法开始记录网页操作')
      }
    } finally {
      browserActionPendingRef.current = false
      if (browserAgentMountedRef.current) setBrowserActionPending(false)
    }
  }, [activeTab?.url, activeTabId, agentChannelId, agentSessions, browserAgentBindingQueue, browserAgentSessionId, browserWorkflowEnabled, ensureBrowserAgentSession, setBrowserAgentPanelOpen, setBrowserAgentSessionId, setBrowserWorkflowStatus])

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

  const handleOpenBrowserAgent = React.useCallback(async (): Promise<void> => {
    if (!browserWorkflowEnabled || browserActionPendingRef.current) return
    const requestId = browserAgentActionRequestIdRef.current + 1
    browserAgentActionRequestIdRef.current = requestId
    const requestedTarget: BrowserAgentTarget = {
      tabId: activeTabId ?? '',
      pageUrl: activeTab?.url ?? '',
    }
    browserActionPendingRef.current = true
    setBrowserActionPending(true)
    try {
      const ensured = await ensureBrowserAgentSession()
      const canCommit = shouldCommitBrowserAgentAction(
        requestId,
        browserAgentActionRequestIdRef.current,
        browserAgentMountedRef.current,
        requestedTarget,
        browserAgentTargetRef.current,
      )
      if (!canCommit) {
        await browserAgentBindingQueue.unbindIfCurrent(ensured.binding).catch((error) => {
          console.error('[Browser Workflow] 失效的打开请求解除绑定失败:', error)
        })
        return
      }
      if (ensured.isNewSession) {
        browserAgentSessionIdRef.current = ensured.sessionId
        setBrowserAgentSessionId(ensured.sessionId)
        setBrowserWorkflowStatus({ sessionId: ensured.sessionId, state: 'idle' })
      }
      setBrowserAgentPanelOpen(true)
    } catch (error) {
      if (shouldCommitBrowserAgentAction(
        requestId,
        browserAgentActionRequestIdRef.current,
        browserAgentMountedRef.current,
        requestedTarget,
        browserAgentTargetRef.current,
      )) {
        toast.error(error instanceof Error ? error.message : '无法打开网页 Agent')
      }
    } finally {
      browserActionPendingRef.current = false
      if (browserAgentMountedRef.current) setBrowserActionPending(false)
    }
  }, [activeTab?.url, activeTabId, browserAgentBindingQueue, browserWorkflowEnabled, ensureBrowserAgentSession, setBrowserAgentPanelOpen, setBrowserAgentSessionId, setBrowserWorkflowStatus])

  const handleStartNewBrowserAgentSession = React.useCallback(async (): Promise<void> => {
    if (!browserWorkflowEnabled || browserActionPendingRef.current || !activeTabId || !activeTab) return
    if (!/^https?:\/\//i.test(activeTab.url)) {
      toast.error('请先打开 HTTP(S) 网页')
      return
    }

    const requestId = browserAgentActionRequestIdRef.current + 1
    browserAgentActionRequestIdRef.current = requestId
    const requestedTarget: BrowserAgentTarget = {
      tabId: activeTabId,
      pageUrl: activeTab.url,
    }
    browserActionPendingRef.current = true
    setBrowserActionPending(true)
    try {
      let currentSession = browserAgentSessionId
        ? agentSessions.find((session) => session.id === browserAgentSessionId)
        : undefined
      if (browserAgentSessionId && !currentSession) {
        const sessions = await window.electronAPI.listAgentSessions()
        setAgentSessions(sessions)
        currentSession = sessions.find((session) => session.id === browserAgentSessionId)
      }
      let workspaceId: string
      try {
        workspaceId = await resolveBrowserAgentProjectId()
      } catch (error) {
        if (!currentSession?.workspaceId) throw error
        workspaceId = currentSession.workspaceId
      }
      const result = await createAndSwitchBrowserAgentSession(
        browserAgentSessionId,
        () => createBrowserAgentDraftSession(
          workspaceId,
          currentSession?.channelId ?? agentChannelId ?? undefined,
          currentSession?.modelId ?? agentModelId ?? undefined,
        ),
        async (sessionId) => {
          await browserAgentBindingQueue.bind(sessionId, activeTabId)
        },
        (sessionId) => browserAgentBindingQueue.unbindAfterPending(sessionId),
        () => shouldCommitBrowserAgentAction(
          requestId,
          browserAgentActionRequestIdRef.current,
          browserAgentMountedRef.current,
          requestedTarget,
          browserAgentTargetRef.current,
        ),
      )
      if (!shouldCommitBrowserAgentAction(
        requestId,
        browserAgentActionRequestIdRef.current,
        browserAgentMountedRef.current,
        requestedTarget,
        browserAgentTargetRef.current,
      )) return

      browserAgentSessionIdRef.current = result.sessionId
      setBrowserAgentSessionId(result.sessionId)
      setBrowserWorkflowStatus({ sessionId: result.sessionId, state: 'idle' })
      setBrowserAgentPanelOpen(true)
      if (!result.previousBindingReleased) {
        console.error('[Browser Workflow] 开启新会话后旧页面绑定未能解除:', result.previousSessionId)
      }
    } catch (error) {
      if (shouldCommitBrowserAgentAction(
        requestId,
        browserAgentActionRequestIdRef.current,
        browserAgentMountedRef.current,
        requestedTarget,
        browserAgentTargetRef.current,
      )) {
        toast.error(error instanceof Error ? error.message : '无法开启新的网页 Agent 会话')
      }
    } finally {
      browserActionPendingRef.current = false
      if (browserAgentMountedRef.current) setBrowserActionPending(false)
    }
  }, [activeTab, activeTabId, agentChannelId, agentModelId, agentSessions, browserAgentBindingQueue, browserAgentSessionId, browserWorkflowEnabled, createBrowserAgentDraftSession, resolveBrowserAgentProjectId, setAgentSessions, setBrowserAgentPanelOpen, setBrowserAgentSessionId, setBrowserWorkflowStatus])

  const handleBrowserToolbarClick = React.useCallback((): void => {
    const action = getBrowserWorkflowToolbarAction(browserWorkflowStatus)
    if (action === 'stop-recording') {
      void handleStopRecording()
      return
    }
    void handleOpenBrowserAgent()
  }, [browserWorkflowStatus, handleOpenBrowserAgent, handleStopRecording])

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
    const request: BrowserAgentContextRequest = {
      requestId: (browserAgentContextRequestRef.current?.requestId ?? 0) + 1,
      sessionId: browserAgentSessionId,
      tabId: activeTabId,
      pageUrl: activeTab?.url ?? '',
    }
    browserAgentContextRequestRef.current = request
    let cancelled = false
    void browserAgentBindingQueue.bind(browserAgentSessionId, activeTabId).then(({ status }) => {
      if (!isCurrentBrowserAgentContextRequest(
        request,
        browserAgentContextRequestRef.current,
        browserAgentMountedRef.current && !cancelled,
        browserAgentTargetRef.current,
      )) return
      setBrowserWorkflowStatus(status)
    }).catch((error) => {
      if (!isCurrentBrowserAgentContextRequest(
        request,
        browserAgentContextRequestRef.current,
        browserAgentMountedRef.current && !cancelled,
        browserAgentTargetRef.current,
      )) return
      console.error('[Browser Workflow] 切换绑定页签失败:', error)
    })
    return () => {
      cancelled = true
    }
  }, [activeTab?.url, activeTabId, browserAgentBindingQueue, browserAgentSessionId, setBrowserWorkflowStatus])

  React.useEffect(() => {
    browserAgentSessionIdRef.current = browserAgentSessionId
  }, [browserAgentSessionId])

  React.useEffect(() => {
    const generation = browserAgentLifecycleGenerationRef.current + 1
    browserAgentLifecycleGenerationRef.current = generation
    browserAgentMountedRef.current = true
    return () => {
      browserAgentMountedRef.current = false
      queueMicrotask(() => {
        if (!shouldFinalizeBrowserAgentUnmount(
          generation,
          browserAgentLifecycleGenerationRef.current,
          browserAgentMountedRef.current,
        )) return
        const sessionId = browserAgentSessionIdRef.current
        if (browserAgentUnmountPolicy.unbindContext && sessionId) {
          void browserAgentBindingQueue.unbindAfterPending(sessionId).catch((error) => {
            console.error('[Browser Workflow] 页面宿主卸载时解除绑定失败:', error)
          })
        }
        if (!browserAgentUnmountPolicy.preserveSessionId) setBrowserAgentSessionId(null)
        setBrowserAgentPanelOpen(false)
        setBrowserWorkflowStatus({ state: 'idle' })
      })
    }
  }, [browserAgentBindingQueue, setBrowserAgentPanelOpen, setBrowserAgentSessionId, setBrowserWorkflowStatus])


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
                src={CopisAgentLogo}
                alt=""
                className={cn('size-4 rounded-[25%] object-cover')}
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
              onStartNewSession={handleStartNewBrowserAgentSession}
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
