/**
 * 创造模式全功能 Web 工作台。
 *
 * 架构重构为 Electron 原生 WebContentsView 承载，彻底去除 <iframe> 标签：
 * - 由主进程单例 WebContentsView 直接渲染原生 Chromium 网页，无沙箱与层级割裂；
 * - 尺寸矩形 Bounds 实时对齐，保证生命周期完全独立于 React 渲染，零重载、长连接不中断；
 * - 创造模式下左侧保持 DSH Web 原生侧边栏，点击 Copis 功能（记忆/知识库/日程等）时，
 *   WebContentsView 宽度自适应收敛至侧边栏，右侧无缝呈现对应的 Copis 原生功能组件；
 * - 点击新建会话或历史会话瞬间切回 DSH 聊天界面，外层 Agent 侧边栏绝对不渲染。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  Loader2,
  RefreshCw,
  Sparkles,
  Lightbulb,
  AlertCircle,
  Download,
  X,
} from 'lucide-react'
import { dshCordisStatusAtom, normalizeAppMode, setAppModeAndRuntimeAtom } from '@/atoms/app-mode'
import { agentSessionsAtom, currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { searchDialogOpenAtom } from '@/atoms/search-atoms'
import { planningTabAtom } from '@/atoms/planning-atoms'
import { workingSettingsOpenAtom } from '@/atoms/working-atoms'
import { activeWebTabIdAtom } from '@/atoms/web-tabs'
import { automationFormAtom } from '@/atoms/automation-atoms'
import { resolvedThemeAtom } from '@/atoms/theme'
import { useOpenSession } from '@/hooks/useOpenSession'
import { useCreateSession } from '@/hooks/useCreateSession'
import { CopisWorkingFeedbackDialog } from '@/components/app-shell/CopisWorkingFeedbackDialog'
import { Button } from '@/components/ui/button'
import { PlanningView } from '@/components/planning/PlanningView'
import { AutomationsListView } from '@/components/automation/AutomationsListView'
import { AutomationFormView } from '@/components/automation/AutomationFormView'
import { MemoryView } from '@/components/memory/MemoryView'
import { KnowledgeView } from '@/components/knowledge/KnowledgeView'
import { ExpertTeamView } from '@/components/expert-team/ExpertTeamView'
import { AgentSkillsView } from '@/components/agent-skills/AgentSkillsView'
import { FundStockTerminalView } from '@/components/trading/FundStockTerminalView'
import { CopisWorkingSettingsPanel } from '@/components/app-shell/CopisWorkingSettingsPanel'
import { cn } from '@/lib/utils'
import type { DshClientEvent } from '@copis/shared'

type CreationSubView =
  | 'planning'
  | 'automations'
  | 'memory'
  | 'knowledge'
  | 'expert-team'
  | 'agent-skills'
  | 'fund-stock'
  | 'settings'
  | null

import { isDshModuleMissingError } from './creation-dsh-helper'
export { isDshModuleMissingError }

export function CopisCreationWebView(): React.ReactElement {
  const [status, setStatus] = useAtom(dshCordisStatusAtom)
  const setAppModeAndRuntime = useSetAtom(setAppModeAndRuntimeAtom)
  const setSearchDialogOpen = useSetAtom(searchDialogOpenAtom)
  const setPlanningTab = useSetAtom(planningTabAtom)
  const setWorkingSettingsOpen = useSetAtom(workingSettingsOpenAtom)
  const workingSettingsOpen = useAtomValue(workingSettingsOpenAtom)
  const activeWebTabId = useAtomValue(activeWebTabIdAtom)
  const automationFormOpen = useAtomValue(automationFormAtom).open
  const agentSessions = useAtomValue(agentSessionsAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const openSession = useOpenSession()
  const { createAgent } = useCreateSession()
  const resolvedTheme = useAtomValue(resolvedThemeAtom)

  const [feedbackOpen, setFeedbackOpen] = useState(false)
  // 未就绪时默认处于启动/检测状态，避免首帧闪现未就绪/错误页
  const [starting, setStarting] = useState(!status.running || !status.url)
  const [startError, setStartError] = useState<string | null>(null)
  const [installingModule, setInstallingModule] = useState(false)
  const [installProgressText, setInstallProgressText] = useState<string | null>(null)
  const [creationSubView, setCreationSubView] = useState<CreationSubView>(null)
  const [dshSidebarWidth, setDshSidebarWidth] = useState(280)

  const nativeHostRef = useRef<HTMLDivElement>(null)
  const hasAttemptedRef = useRef(false)

  // 1. 同步原生 WebContentsView 的坐标矩形与可见性给主进程
  const updateNativeBounds = useCallback(() => {
    if (!nativeHostRef.current || !status.running || !status.url) {
      void window.electronAPI?.dshCordis?.updateViewBounds?.({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        visible: false,
      })
      return
    }

    const rect = nativeHostRef.current.getBoundingClientRect()
    // 若当前打开了 Copis 功能视图，则原生视图保持展开左侧 DSH 侧边栏（不低于 264px），右侧腾出空间渲染 React 视图；
    // 设置页面则完全隐藏原生 DSH 侧边栏与网页内容，由 Copis 设置面板全屏覆盖呈现。
    const isSettings = creationSubView === 'settings'
    const effectiveSidebarWidth = Math.max(264, dshSidebarWidth)
    const effectiveWidth = isSettings
      ? 0
      : creationSubView
        ? Math.min(effectiveSidebarWidth, rect.width)
        : rect.width
    const isVisible = !workingSettingsOpen && !activeWebTabId && !isSettings && rect.width > 0 && rect.height > 0

    void window.electronAPI?.dshCordis?.updateViewBounds?.(
      {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(effectiveWidth),
        height: Math.round(rect.height),
        visible: isVisible,
      },
      status.url
    )
  }, [status.running, status.url, creationSubView, dshSidebarWidth, workingSettingsOpen, activeWebTabId])

  useEffect(() => {
    updateNativeBounds()
    const handleResize = () => updateNativeBounds()
    window.addEventListener('resize', handleResize)

    let ro: ResizeObserver | null = null
    if (nativeHostRef.current) {
      ro = new ResizeObserver(() => updateNativeBounds())
      ro.observe(nativeHostRef.current)
    }

    return () => {
      window.removeEventListener('resize', handleResize)
      ro?.disconnect()
    }
  }, [updateNativeBounds])

  // 切离创造模式时隐藏原生 WebContentsView
  useEffect(() => {
    return () => {
      void window.electronAPI?.dshCordis?.updateViewBounds?.({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        visible: false,
      })
    }
  }, [])

  // 实时同步 Copis 当前生效的主题至 DSH 原生网页
  useEffect(() => {
    if (!status.running || !status.url) return
    void window.electronAPI?.dshCordis?.dispatchToClient?.({
      type: 'COPIS_THEME_CHANGED',
      isDark: resolvedTheme === 'dark',
    })
  }, [resolvedTheme, status.running, status.url])

  // 切回 Agent 模式并自动恢复当前工作区的 Agent 会话
  const handleBackToAgent = useCallback(() => {
    setAppModeAndRuntime('agent')
    setActiveView('conversations')
    const matchedSession = agentSessions.find(
      (s) => !s.archived && s.workspaceId === currentWorkspaceId && s.mode !== 'creation' && s.agentRuntime !== 'dsh',
    )
    if (matchedSession) {
      openSession('agent', matchedSession.id, matchedSession.title)
    } else {
      createAgent({
        draft: true,
        mode: 'agent',
        agentRuntime: 'pi',
      })
    }
  }, [setAppModeAndRuntime, setActiveView, agentSessions, currentWorkspaceId, openSession, createAgent])

  // 2. 监听 DSH 客户端事件（通过 preload IPC 与 message 双向监听）
  useEffect(() => {
    const handleClientEvent = (e: DshClientEvent) => {
      if (!e || typeof e !== 'object') return
      if (e.type === 'COPIS_SWITCH_MODE' && e.mode) {
        const nextMode = normalizeAppMode(e.mode)
        if (nextMode === 'agent') {
          handleBackToAgent()
        } else {
          setAppModeAndRuntime(nextMode)
          setActiveView('conversations')
        }
      } else if (e.type === 'COPIS_NAVIGATE') {
        if (e.view === 'conversations') {
          setCreationSubView(null)
          setActiveView('conversations')
          void window.electronAPI?.dshCordis?.dispatchToClient?.({
            type: 'COPIS_ACTIVE_VIEW_CHANGE',
            view: 'conversations',
          })
        } else if (e.view) {
          setCreationSubView(e.view as CreationSubView)
          if (e.view === 'planning' && e.tab) {
            setPlanningTab(e.tab as any)
          }
        }
      } else if (e.type === 'COPIS_DSH_SIDEBAR_INFO') {
        if (e.width && Number.isFinite(e.width) && e.width > 0) {
          setDshSidebarWidth(Math.max(264, Math.round(e.width)))
        }
      } else if (e.type === 'COPIS_OPEN_SEARCH') {
        setSearchDialogOpen(true)
      } else if (e.type === 'COPIS_OPEN_SETTINGS') {
        setCreationSubView('settings')
      } else if (e.type === 'COPIS_OPEN_FEEDBACK') {
        setFeedbackOpen(true)
      }
    }

    const unsubIpc = window.electronAPI?.dshCordis?.onClientEvent?.(handleClientEvent)
    const onMsg = (event: MessageEvent) => {
      if (event.data && typeof event.data === 'object' && 'type' in event.data) {
        handleClientEvent(event.data as DshClientEvent)
      }
    }
    window.addEventListener('message', onMsg)

    return () => {
      unsubIpc?.()
      window.removeEventListener('message', onMsg)
    }
  }, [handleBackToAgent, setAppModeAndRuntime, setActiveView, setSearchDialogOpen, setPlanningTab, setWorkingSettingsOpen])

  // 3. 关闭右侧 Copis 功能视图并切回 DSH 聊天
  const closeSubView = useCallback(() => {
    setCreationSubView(null)
    void window.electronAPI?.dshCordis?.dispatchToClient?.({
      type: 'COPIS_ACTIVE_VIEW_CHANGE',
      view: 'conversations',
    })
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && creationSubView) {
        e.preventDefault()
        closeSubView()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [creationSubView, closeSubView])

  // 4. 监听 DSH 服务状态
  useEffect(() => {
    if (!window.electronAPI?.dshCordis?.onStatusChange) return
    const unsubscribe = window.electronAPI.dshCordis.onStatusChange((newStatus) => {
      setStatus(newStatus)
      if (newStatus.running && newStatus.url) {
        setStartError(null)
      } else if (!newStatus.running && newStatus.error) {
        setStartError(newStatus.error)
      }
    })
    return () => unsubscribe()
  }, [setStatus])

  const ensureServiceRunning = useCallback(async () => {
    if (!window.electronAPI?.dshCordis) {
      console.warn('[CopisCreationWebView] window.electronAPI.dshCordis 未挂载')
      const errMsg = '客户端接口未完成初始化，请重试。'
      setStartError(errMsg)
      setStatus({
        running: false,
        error: errMsg,
      })
      setStarting(false)
      return
    }

    try {
      setStarting(true)
      setStartError(null)
      const current = await window.electronAPI.dshCordis.getStatus()
      if (current.running && current.url) {
        setStatus(current)
        setStartError(null)
        setStarting(false)
        return
      }

      const started = await window.electronAPI.dshCordis.start()
      if (started.running && started.url) {
        setStatus(started)
        setStartError(null)
      } else {
        const errMsg = started.error || 'Copis 创造模式服务未能成功启动，请重试。'
        setStartError(errMsg)
        setStatus({
          running: false,
          error: errMsg,
        })
      }
    } catch (err) {
      console.error('[CopisCreationWebView] 启动 Cordis 服务异常:', err)
      const errMsg = err instanceof Error ? err.message : String(err)
      setStartError(errMsg)
      setStatus({
        running: false,
        error: errMsg,
      })
    } finally {
      setStarting(false)
    }
  }, [setStatus])

  useEffect(() => {
    if (!hasAttemptedRef.current && (!status.running || !status.url)) {
      hasAttemptedRef.current = true
      void ensureServiceRunning()
    }
  }, [status.running, status.url, ensureServiceRunning])

  const handleInstallModule = useCallback(async () => {
    if (!window.electronAPI?.installFunctionalModule) {
      setStartError('当前客户端未提供模块安装接口，请在设置中查看。')
      return
    }

    try {
      setInstallingModule(true)
      setInstallProgressText('正在准备安装创造模式模块...')
      setStartError(null)

      const moduleStatus = await window.electronAPI.installFunctionalModule({ name: 'dsh' })
      if (moduleStatus.installed) {
        setInstallProgressText('模块安装完成，正在启动创造模式...')
        await ensureServiceRunning()
      } else {
        setStartError(moduleStatus.error || '创造模式模块安装未完成，请重试。')
      }
    } catch (err) {
      console.error('[CopisCreationWebView] 安装创造模式模块失败:', err)
      const errMsg = err instanceof Error ? err.message : String(err)
      setStartError(`安装创造模式模块失败: ${errMsg}`)
    } finally {
      setInstallingModule(false)
      setInstallProgressText(null)
    }
  }, [ensureServiceRunning])

  useEffect(() => {
    if (!installingModule || !window.electronAPI?.onFunctionalModuleProgress) return
    const unsubscribe = window.electronAPI.onFunctionalModuleProgress((payload) => {
      if (payload.name === 'dsh') {
        const percent = Math.round((payload.progress ?? 0) * 100)
        if (payload.phase === 'manifest') {
          setInstallProgressText('正在获取模块更新信息...')
        } else if (payload.phase === 'download') {
          setInstallProgressText(`正在下载创造模式模块 (${percent}%)...`)
        } else if (payload.phase === 'verify') {
          setInstallProgressText('正在验证模块完整性...')
        } else if (payload.phase === 'install') {
          setInstallProgressText('正在解压并安装模块...')
        } else if (payload.phase === 'activate') {
          setInstallProgressText('正在激活创造模式模块...')
        } else if (payload.phase === 'done') {
          setInstallProgressText('模块准备就绪，正在启动...')
        }
      }
    })
    return () => unsubscribe()
  }, [installingModule])

  const handleRetry = useCallback(() => {
    setStartError(null)
    setStarting(true)
    void ensureServiceRunning()
  }, [ensureServiceRunning])

  const isReady = status.running && Boolean(status.url)
  const isActualError = !isReady && !starting && Boolean(startError || status.error || installingModule)
  const isLoading = !isReady && !isActualError
  const errorMessage = startError || status.error || ''
  const isMissingDsh = isDshModuleMissingError(errorMessage)

  return (
    <div className="flex flex-col w-full h-full bg-background select-none overflow-hidden relative">
      {/* 主视图区域：由 Electron 原生 WebContentsView 挂载承载，顶格充满主容器，彻底告别 iframe 标签 */}
      <div className="flex-1 min-h-0 relative bg-background overflow-hidden" ref={nativeHostRef}>
        {!isReady && (
          isLoading ? (
            <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-6">
              <div className="relative">
                <div className="w-12 h-12 rounded-2xl bg-[var(--creation-ui-primary-background)] flex items-center justify-center text-[var(--creation-ui-primary)] animate-pulse">
                  <Lightbulb className="w-6 h-6" />
                </div>
                <Loader2 className="w-5 h-5 animate-spin absolute -bottom-1 -right-1 text-[var(--creation-ui-primary)]" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-foreground">正在启动 Copis 创造模式</h3>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm">
                  加载微内核插件体系与原生 Chromium 视图容器...
                </p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-6">
              <div
                className={cn(
                  'w-12 h-12 rounded-2xl flex items-center justify-center transition-colors',
                  installingModule
                    ? 'bg-[var(--creation-ui-primary-background)] text-[var(--creation-ui-primary)]'
                    : 'bg-destructive/10 text-destructive',
                )}
              >
                {installingModule ? (
                  <Loader2 className="w-6 h-6 animate-spin" />
                ) : (
                  <AlertCircle className="w-6 h-6" />
                )}
              </div>
              <div>
                <h3 className="text-base font-semibold text-foreground">
                  {installingModule ? '正在安装创造模式模块' : 'Copis 创造模式启动失败'}
                </h3>
                <p className="text-xs text-muted-foreground mt-1 max-w-md">
                  {installProgressText || errorMessage || '创造模式微内核服务未能成功启动，请点击下方重试。'}
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2 mt-2">
                {isMissingDsh && (
                  <Button
                    variant="default"
                    size="sm"
                    onClick={handleInstallModule}
                    disabled={installingModule}
                    className="titlebar-no-drag bg-[var(--creation-ui-primary)] text-white hover:bg-[var(--creation-ui-primary)]/90 shadow-sm"
                  >
                    {installingModule ? (
                      <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <Download className="w-3.5 h-3.5 mr-1.5" />
                    )}
                    {installingModule ? '正在安装创造模式模块...' : '安装创造模式模块'}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRetry}
                  disabled={installingModule}
                  className="titlebar-no-drag"
                >
                  <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                  重试启动
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleBackToAgent}
                  disabled={installingModule}
                  className="titlebar-no-drag text-muted-foreground hover:text-foreground"
                >
                  <Sparkles className="w-3.5 h-3.5 mr-1.5 text-[var(--ui-primary)]" />
                  返回 Agent 模式
                </Button>
              </div>
            </div>
          )
        )}

        {/* 右侧 Copis 功能视图展示区域：
            - 非设置视图：左侧露出原生 DSH 侧边栏，右侧无缝呈现对应 Copis 功能组件；
            - 设置视图：完全覆盖全屏并隐藏 DSH 原生侧边栏，呈现完整的 Copis 设置面板。 */}
        {creationSubView && (
          <div
            className={cn(
              'absolute top-0 bottom-0 right-0 z-20 flex flex-col bg-content-area shadow-2xl overflow-hidden animate-in fade-in duration-150',
              creationSubView === 'settings'
                ? 'left-0 border-l-0'
                : 'border-l border-border/60',
            )}
            style={{
              left: creationSubView === 'settings' ? 0 : Math.max(264, Math.round(dshSidebarWidth)),
            }}
          >
            {/* 右上角快捷返回按钮 */}
            <div className="absolute top-3 right-4 z-50">
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2.5 gap-1.5 rounded-full border-border/70 bg-background/85 backdrop-blur-sm shadow-sm text-xs hover:bg-accent titlebar-no-drag"
                onClick={closeSubView}
                title="返回会话 (Esc)"
              >
                <X className="w-3.5 h-3.5 text-[var(--ui-primary)]" />
                <span className="hidden sm:inline font-medium">返回会话</span>
                <kbd className="text-[10px] text-muted-foreground font-mono">Esc</kbd>
              </Button>
            </div>

            <div className="flex-1 min-h-0 relative">
              {creationSubView === 'planning' ? (
                <PlanningView standalone />
              ) : creationSubView === 'automations' ? (
                automationFormOpen ? <AutomationFormView /> : <AutomationsListView />
              ) : creationSubView === 'memory' ? (
                <MemoryView />
              ) : creationSubView === 'knowledge' ? (
                <KnowledgeView />
              ) : creationSubView === 'expert-team' ? (
                <ExpertTeamView />
              ) : creationSubView === 'agent-skills' ? (
                <AgentSkillsView />
              ) : creationSubView === 'fund-stock' ? (
                <FundStockTerminalView />
              ) : creationSubView === 'settings' ? (
                <CopisWorkingSettingsPanel onClose={closeSubView} />
              ) : null}
            </div>
          </div>
        )}
      </div>

      <CopisWorkingFeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </div>
  )
}
