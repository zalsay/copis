/**
 * 渲染进程入口
 *
 * 挂载 React 应用，初始化主题系统。
 */

// 引入 Inter Variable 自托管字体（含 400/500/600/700 等所有字重）
// index.css 声明了全部语言子集（latin/latin-ext/cyrillic/greek/vietnamese 等），
// 但每个 @font-face 都带 unicode-range，浏览器仅按需下载实际用到的子集（本应用主要是 latin）。
import '@fontsource-variable/inter/index.css'

import React, { useEffect, useMemo, useRef } from 'react'
import ReactDOM from 'react-dom/client'
import { useSetAtom, useAtomValue, useStore } from 'jotai'
import App from './App'
import {
  themeModeAtom,
  themeStyleAtom,
  interfaceVariantAtom,
  systemIsDarkAtom,
  resolvedThemeAtom,
  applyThemeToDOM,
  applyInterfaceVariantToDOM,
  initializeTheme,
} from './atoms/theme'
import {
  agentChannelIdAtom,
  agentChannelIdsAtom,
  agentModelIdAtom,
  agentRuntimeAtom,
  agentWorkspacesAtom,
  agentSessionsAtom,
  currentAgentWorkspaceIdAtom,
  currentAgentSessionIdAtom,
  workspaceCapabilitiesVersionAtom,
  workspaceFilesVersionAtom,
  agentThinkingAtom,
  agentEffortAtom,
  agentMaxBudgetUsdAtom,
  agentMaxTurnsAtom,
  agentSettingsReadyAtom,
  automationGroupOrderAtom,
  dockBadgeCountAtom,
  unviewedCompletedSessionIdsAtom,
} from './atoms/agent-atoms'
import { workingAuthStateAtom, workingClientConfigAtom, workingVipStatusAtom } from './atoms/working-atoms'
import {
  resetWorkingModelCatalog,
  workingModelCatalogAtom,
} from './atoms/working-model-catalog-atoms'
import { workingPaymentRefreshAtom } from './atoms/working-payment-atoms'
import { updateStatusAtom, initializeUpdater } from './atoms/updater'
import { automationsAtom } from './atoms/automation-atoms'
import { calendarEventsAtom, planningTagsAtom, todoPlanningGroupsAtom, todosAtom } from './atoms/planning-atoms'
import {
  notificationsEnabledAtom,
  notificationSoundEnabledAtom,
  notificationSoundsAtom,
  initializeNotifications,
} from './atoms/notifications'
import {
  stickyUserMessageEnabledAtom,
  longTextPasteAsAttachmentEnabledAtom,
  richTextRenderingEnabledAtom,
  sessionHoverPreviewEnabledAtom,
  initializeUiPreferences,
} from './atoms/ui-preferences'
import {
  markdownFontSizeAtom,
  initializeMarkdownFontSize,
} from './atoms/markdown-font-size'
import {
  pinnedDevProjectsAtom,
  initializePinnedDevProjects,
} from './atoms/pinned-dev-projects'
import { useGlobalAgentListeners } from './hooks/useGlobalAgentListeners'
import { tabsAtom, activeTabIdAtom, getPersistableTabState, sanitizePersistedTabs } from './atoms/tab-atoms'
import type { TabItem } from './atoms/tab-atoms'
import { agentToolsAtom } from './atoms/agent-tool-atoms'
import { feishuBotStatesAtom } from './atoms/feishu-atoms'
import { dingtalkBotStatesAtom } from './atoms/dingtalk-atoms'
import { channelsAtom, channelsLoadedAtom, selectedModelAtom } from './atoms/model-atoms'
import { appModeAtom, normalizeAppMode } from './atoms/app-mode'
import {
  EMPTY_WORKING_MODEL_CATALOG,
  COPIS_WORKING_DEEPSEEK_CHANNEL_ID,
  COPIS_WORKING_DEEPSEEK_FAST_MODEL_ID,
  isWorkingCustomModelChannelId,
  workingCustomModelChannelIdFor,
} from '@copis/shared'
import type { FeishuBotBridgeState, FeishuBridgeState, DingTalkBotBridgeState, DingTalkBridgeState, WorkingAuthState, WorkingModelCatalog } from '@copis/shared'
import { Toaster } from './components/ui/sonner'
import { toast } from 'sonner'
import { diffCapabilities } from '@copis/shared'
import type { WorkspaceCapabilities } from '@copis/shared'
import { showCapabilityChangeToasts } from './lib/capabilities-toast'
import { GlobalShortcuts } from './components/shortcuts/GlobalShortcuts'
import { VoiceDictationApp } from './components/voice-dictation/VoiceDictationApp'
import { TabSwitcher } from './components/tabs/TabSwitcher'
import { getEnabledAgentChannelIds } from './lib/agent-channel-selection'
import { WindowControls } from './components/WindowControls'
import { CopisLogo } from './lib/model-logo'
import { initShortcutRegistry, updateShortcutOverrides } from './lib/shortcut-registry'
import { installHttpApiBridge } from './lib/http-api-bridge'
import './styles/globals.css'
import 'katex/dist/katex.min.css'

// ===== 窗口类型检测 =====
// 普通浏览器没有 Electron Preload，改用本地 HTTP API 兼容层；Electron 环境保持原有 IPC。
installHttpApiBridge()

const isQuickTaskWindow = new URLSearchParams(window.location.search).get('window') === 'quick-task'
const isVoiceDictationIndicatorWindow = new URLSearchParams(window.location.search).get('window') === 'voice-dictation-indicator'
const isDetachedPreviewWindow = new URLSearchParams(window.location.search).get('window') === 'detached-preview'
const isPlanningWindow = new URLSearchParams(window.location.search).get('window') === 'planning'
const isWebBookmarksWindow = new URLSearchParams(window.location.search).get('window') === 'web-bookmarks'
const isMainWindow = !isQuickTaskWindow && !isVoiceDictationIndicatorWindow && !isDetachedPreviewWindow && !isPlanningWindow && !isWebBookmarksWindow

type WorkingDefaultModelSettings = {
  agentChannelId?: string
  agentModelId?: string
}

function getWorkingAccountKey(state: WorkingAuthState | null): string {
  if (!state?.authenticated) return 'anonymous'
  const accountId = state.user?.id ?? state.user?.userId
  return accountId === undefined || accountId === null
    ? 'authenticated'
    : `authenticated:${String(accountId)}`
}

function resolveWorkingDefaultModel(
  settings: WorkingDefaultModelSettings,
  catalog: WorkingModelCatalog,
): { channelId: string; modelId: string } {
  const storedChannelId = settings.agentChannelId
  const storedCustomModel = isWorkingCustomModelChannelId(storedChannelId)
    ? catalog.models.find((model) => (
      workingCustomModelChannelIdFor(model.id) === storedChannelId
      && model.apiKeyConfigured
    ))
    : undefined

  return storedCustomModel
    ? { channelId: storedChannelId!, modelId: storedCustomModel.modelId }
    : { channelId: COPIS_WORKING_DEEPSEEK_CHANNEL_ID, modelId: COPIS_WORKING_DEEPSEEK_FAST_MODEL_ID }
}

// 主窗口和独立规划窗口均由内部面板管理滚动，避免页面本身出现第二层滚动。
if (isMainWindow || isPlanningWindow) {
  document.documentElement.classList.add('copis-main-window')
}

/**
 * 主题初始化组件
 *
 * 负责从主进程加载主题设置、监听系统主题变化、
 * 并将最终主题同步到 DOM。
 */
function ThemeInitializer(): null {
  const setThemeMode = useSetAtom(themeModeAtom)
  const setThemeStyle = useSetAtom(themeStyleAtom)
  const setInterfaceVariant = useSetAtom(interfaceVariantAtom)
  const setSystemIsDark = useSetAtom(systemIsDarkAtom)
  const themeMode = useAtomValue(themeModeAtom)
  const themeStyle = useAtomValue(themeStyleAtom)
  const interfaceVariant = useAtomValue(interfaceVariantAtom)
  const systemIsDark = useAtomValue(systemIsDarkAtom)

  // 初始化：从主进程加载设置 + 订阅系统主题变化
  useEffect(() => {
    let isMounted = true
    let cleanup: (() => void) | undefined

    initializeTheme(setThemeMode, setSystemIsDark, setThemeStyle, setInterfaceVariant).then((fn) => {
      if (isMounted) {
        cleanup = fn
      } else {
        // 组件已卸载（StrictMode 场景），立即清理监听器
        fn()
      }
    })

    return () => {
      isMounted = false
      cleanup?.()
    }
  }, [setThemeMode, setSystemIsDark, setThemeStyle, setInterfaceVariant])

  // 响应式应用主题到 DOM
  // 用 useMemo 计算"实际会影响 DOM 的状态签名"作为唯一依赖：
  // special 模式下 systemIsDark 不影响最终 class，避免系统主题变化时触发无意义的
  // applyThemeToDOM 调用（配合 applyThemeToDOM 内部的幂等检查双重兜底）。
  const themeSignature = useMemo(() => {
    if (themeMode === 'special') {
      return `special:${themeStyle}`
    }
    if (themeMode === 'system') {
      return `system:${systemIsDark ? 'dark' : 'light'}`
    }
    return themeMode
  }, [themeMode, themeStyle, systemIsDark])

  useEffect(() => {
    applyThemeToDOM(themeMode, themeStyle, systemIsDark)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeSignature])

  useEffect(() => {
    applyInterfaceVariantToDOM(interfaceVariant)
  }, [interfaceVariant])

  return null
}

/**
 * Agent 设置初始化组件
 *
 * 从主进程加载 Agent 渠道/模型设置并写入 atoms。
 */
function AgentSettingsInitializer(): null {
  const setAgentChannelId = useSetAtom(agentChannelIdAtom)
  const setAgentChannelIds = useSetAtom(agentChannelIdsAtom)
  const setAgentModelId = useSetAtom(agentModelIdAtom)
  const setAgentRuntime = useSetAtom(agentRuntimeAtom)
  const setAgentWorkspaces = useSetAtom(agentWorkspacesAtom)
  const setCurrentWorkspaceId = useSetAtom(currentAgentWorkspaceIdAtom)
  const bumpCapabilities = useSetAtom(workspaceCapabilitiesVersionAtom)
  const bumpFiles = useSetAtom(workspaceFilesVersionAtom)
  const setThinking = useSetAtom(agentThinkingAtom)
  const setEffort = useSetAtom(agentEffortAtom)
  const setMaxBudget = useSetAtom(agentMaxBudgetUsdAtom)
  const setMaxTurns = useSetAtom(agentMaxTurnsAtom)
  const setAutomationGroupOrder = useSetAtom(automationGroupOrderAtom)
  const setWorkingClientConfig = useSetAtom(workingClientConfigAtom)
  const setWorkingAuthState = useSetAtom(workingAuthStateAtom)
  const setWorkingVipStatus = useSetAtom(workingVipStatusAtom)
  const setWorkingModelCatalog = useSetAtom(workingModelCatalogAtom)
  const bumpWorkingPaymentRefresh = useSetAtom(workingPaymentRefreshAtom)
  const workingAuthState = useAtomValue(workingAuthStateAtom)
  const workingAccountId = workingAuthState?.user?.id ?? workingAuthState?.user?.userId
  const workingModelRequestIdRef = useRef(0)
  const workingAuthSnapshotRequestIdRef = useRef(0)

  const setAgentSettingsReady = useSetAtom(agentSettingsReadyAtom)
  const setChannels = useSetAtom(channelsAtom)
  const setChannelsLoaded = useSetAtom(channelsLoadedAtom)
  const store = useStore()

  // 读取当前工作区信息（用于能力变化 diff）
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)

  // 缓存上一次工作区能力（用于 diff 检测变化）
  const prevCapabilitiesRef = useRef<WorkspaceCapabilities | null>(null)
  // 初次加载标记 — 应用启动或切换工作区时不显示 toast
  const suppressToastRef = useRef(true)

  useEffect(() => {
    const unsubscribeWorkingAuth = window.electronAPI.onWorkingAuthUpdated((state: WorkingAuthState) => {
      const requestId = ++workingAuthSnapshotRequestIdRef.current
      const accountKey = getWorkingAccountKey(state)
      setWorkingAuthState(state)
      bumpWorkingPaymentRefresh((value) => value + 1)
      void window.electronAPI.getWorkingSettingsSnapshot().then((snapshot) => {
        const currentState = store.get(workingAuthStateAtom)
        if (
          requestId !== workingAuthSnapshotRequestIdRef.current
          || getWorkingAccountKey(currentState) !== accountKey
        ) return
        setWorkingAuthState((current) => current ? { ...current, user: snapshot.user } : state)
        setWorkingVipStatus(snapshot.vip)
      }).catch((error: unknown) => {
        console.error('[Copis Working] 刷新 VIP 状态失败:', error)
      })
    })

    return unsubscribeWorkingAuth
  }, [bumpWorkingPaymentRefresh, setWorkingAuthState, setWorkingVipStatus, store])

  useEffect(() => {
    const requestId = ++workingModelRequestIdRef.current
    const accountKey = getWorkingAccountKey(workingAuthState)
    resetWorkingModelCatalog(setWorkingModelCatalog)
    const applyDefaultModel = (settings: WorkingDefaultModelSettings, catalog: WorkingModelCatalog): void => {
      if (
        requestId !== workingModelRequestIdRef.current
        || getWorkingAccountKey(store.get(workingAuthStateAtom)) !== accountKey
      ) return

      const defaultModel = resolveWorkingDefaultModel(settings, catalog)
      setAgentChannelId(defaultModel.channelId)
      setAgentModelId(defaultModel.modelId)

      if (
        settings.agentChannelId === defaultModel.channelId
        && settings.agentModelId === defaultModel.modelId
      ) return

      void window.electronAPI.updateSettings({
        agentChannelId: defaultModel.channelId,
        agentModelId: defaultModel.modelId,
      }).catch((error: unknown) => {
        console.error('[AgentSettings] 保存 Working 默认模型失败:', error)
      })
    }

    if (!workingAuthState?.authenticated || workingAuthState.user?.isVip !== true) {
      setAgentChannelId(COPIS_WORKING_DEEPSEEK_CHANNEL_ID)
      setAgentModelId(COPIS_WORKING_DEEPSEEK_FAST_MODEL_ID)
      return
    }

    void Promise.all([
      window.electronAPI.getSettings(),
      window.electronAPI.getWorkingModelCatalog(),
    ]).then(([settings, catalog]) => {
      if (
        requestId !== workingModelRequestIdRef.current
        || getWorkingAccountKey(store.get(workingAuthStateAtom)) !== accountKey
      ) return
      setWorkingModelCatalog(catalog)
      applyDefaultModel(settings, catalog)
    }).catch((error: unknown) => {
      if (
        requestId !== workingModelRequestIdRef.current
        || getWorkingAccountKey(store.get(workingAuthStateAtom)) !== accountKey
      ) return
      setWorkingModelCatalog(EMPTY_WORKING_MODEL_CATALOG)
      applyDefaultModel({}, EMPTY_WORKING_MODEL_CATALOG)
      console.error('[模型管理] 加载当前账号模型配置失败:', error)
    })
  }, [setAgentChannelId, setAgentModelId, setWorkingModelCatalog, store, workingAccountId, workingAuthState?.authenticated, workingAuthState?.user?.isVip])

  useEffect(() => {
    const initialWorkingModelRequestId = workingModelRequestIdRef.current
    // 并行加载渠道列表和设置，确保两者都就绪后再验证渠道有效性
    Promise.all([
      window.electronAPI.listChannels(),
      window.electronAPI.getSettings(),
      window.electronAPI.getWorkingConfig(),
    ]).then(([channels, settings, workingConfig]) => {
      // 渠道列表供 Agent、自动化和视觉助手共用。
      setChannels(channels)
      setChannelsLoaded(true)
      setWorkingClientConfig(workingConfig)

      const channelIds = new Set(channels.map((c) => c.id))

      // 验证全局默认模型（localStorage 持久化的可能指向已删除渠道）。
      const storedModel = store.get(selectedModelAtom)
      if (storedModel && !channelIds.has(storedModel.channelId)) {
        console.warn('[AgentSettings] selectedModel 指向已删除的渠道，清除')
        store.set(selectedModelAtom, null)
      }

      // Copis Working 的本地 Agent 固定使用 Pi；模型推理统一经过 edu-api。
      const defaultAgentRuntime = 'pi' as const
      setAgentRuntime(defaultAgentRuntime)

      // 渠道的启用状态是唯一开关：启动时也必须从实际渠道派生可用列表。
      const agentChannelIds = getEnabledAgentChannelIds(channels)
      setAgentChannelIds(agentChannelIds)

      const updates: Parameters<typeof window.electronAPI.updateSettings>[0] = {}
      const storedAgentChannelIds = settings.agentChannelIds ?? []
      const whitelistChanged = agentChannelIds.length !== storedAgentChannelIds.length
        || agentChannelIds.some((id, index) => id !== storedAgentChannelIds[index])
      if (whitelistChanged) updates.agentChannelIds = agentChannelIds

      if (settings.agentRuntime !== defaultAgentRuntime) updates.agentRuntime = defaultAgentRuntime

      if (Object.keys(updates).length > 0 && initialWorkingModelRequestId === workingModelRequestIdRef.current) {
        window.electronAPI.updateSettings(updates).catch(console.error)
      }

      if (settings.agentThinking) {
        setThinking(settings.agentThinking)
      }
      if (settings.agentEffort) {
        setEffort(settings.agentEffort)
      }
      if (settings.agentMaxBudgetUsd != null) {
        setMaxBudget(settings.agentMaxBudgetUsd)
      }
      if (settings.agentMaxTurns != null) {
        setMaxTurns(settings.agentMaxTurns)
      }
      if (typeof settings.agentAutomationGroupOrder === 'number') {
        setAutomationGroupOrder(settings.agentAutomationGroupOrder)
      }

      // 加载工作区列表并恢复上次选中的工作区
      window.electronAPI.listAgentWorkspaces().then((workspaces) => {
        setAgentWorkspaces(workspaces)
        if (settings.agentWorkspaceId) {
          // 验证工作区仍然存在
          const exists = workspaces.some((w) => w.id === settings.agentWorkspaceId)
          setCurrentWorkspaceId(exists ? settings.agentWorkspaceId! : workspaces[0]?.id ?? null)
        } else if (workspaces.length > 0) {
          setCurrentWorkspaceId(workspaces[0]!.id)
        }
        setAgentSettingsReady(true)
      }).catch((err) => {
        console.error(err)
        setAgentSettingsReady(true) // 即使出错也标记就绪，避免永远阻塞
      })
    }).catch((err) => {
      console.error(err)
      setAgentSettingsReady(true) // 即使出错也标记就绪，避免永远阻塞
    })
  }, [setAgentChannelId, setAgentChannelIds, setAgentModelId, setAgentRuntime, setAgentWorkspaces, setCurrentWorkspaceId, setThinking, setEffort, setMaxBudget, setMaxTurns, setAutomationGroupOrder, setWorkingClientConfig, setChannels, setChannelsLoaded, setAgentSettingsReady])

  // 工作区切换时重置能力缓存，预加载基线
  useEffect(() => {
    suppressToastRef.current = true
    prevCapabilitiesRef.current = null

    if (!currentWorkspaceId) return
    const ws = workspaces.find((w) => w.id === currentWorkspaceId)
    if (!ws) return

    window.electronAPI
      .getWorkspaceCapabilities(ws.slug)
      .then((caps) => {
        prevCapabilitiesRef.current = caps
        suppressToastRef.current = false
      })
      .catch(console.error)
  }, [currentWorkspaceId, workspaces])

  // 订阅主进程文件监听推送
  useEffect(() => {
    const unsubCapabilities = window.electronAPI.onCapabilitiesChanged(() => {
      // 查找当前工作区 slug
      const ws = workspaces.find((w) => w.id === currentWorkspaceId)
      if (ws) {
        window.electronAPI
          .getWorkspaceCapabilities(ws.slug)
          .then((newCaps) => {
            const prevCaps = prevCapabilitiesRef.current
            if (prevCaps && !suppressToastRef.current) {
              const changes = diffCapabilities(prevCaps, newCaps)
              showCapabilityChangeToasts(changes)
            }
            prevCapabilitiesRef.current = newCaps
            suppressToastRef.current = false
          })
          .catch(console.error)
      }

      bumpCapabilities((v) => v + 1)
    })
    const unsubFiles = window.electronAPI.onWorkspaceFilesChanged(() => {
      bumpFiles((v) => v + 1)
      // 外部本地项目目录变动时，主进程在 LIST_WORKSPACES 中重新计算根目录状态。
      // 这里仅响应 watcher 事件刷新一次，避免在侧栏每次渲染时同步访问文件系统。
      window.electronAPI.listAgentWorkspaces().then(setAgentWorkspaces).catch(console.error)
    })

    return () => {
      unsubCapabilities()
      unsubFiles()
    }
  }, [bumpCapabilities, bumpFiles, currentWorkspaceId, setAgentWorkspaces, workspaces])

  return null
}

/**
 * 自动更新初始化组件
 *
 * 订阅主进程推送的更新状态变化事件。
 */
function UpdaterInitializer(): null {
  const setUpdateStatus = useSetAtom(updateStatusAtom)
  const updateStatus = useAtomValue(updateStatusAtom)
  const notifiedDownloadVersionRef = useRef<string | null>(null)

  useEffect(() => {
    const cleanup = initializeUpdater(setUpdateStatus)
    return cleanup
  }, [setUpdateStatus])

  useEffect(() => {
    if (updateStatus.status !== 'downloaded') return

    const version = updateStatus.version || '新版本'
    if (notifiedDownloadVersionRef.current === version) return
    notifiedDownloadVersionRef.current = version
    const versionLabel = version.startsWith('v') ? version : `v${version}`

    toast.custom((toastId) => (
      <div className="w-[344px] max-w-[calc(100vw-32px)] rounded-xl bg-background/95 p-3 text-foreground shadow-[0_12px_32px_rgba(0,0,0,0.14)] ring-1 ring-black/5 backdrop-blur-xl dark:ring-white/10">
        <div className="flex items-center gap-2.5">
          <img src={CopisLogo} alt="Copis" className="size-8 rounded-lg" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-sm leading-5">
              <span className="font-semibold tracking-tight">Copis 更新已下载</span>
              <span className="text-xs text-primary">{versionLabel}</span>
            </div>
            <p className="text-xs leading-4 text-muted-foreground">所有 Agent 完成后即可自动安装。</p>
          </div>
        </div>
        <div className="mt-2.5 flex items-center justify-between">
          <button
            type="button"
            className="h-7 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-[0.96]"
            onClick={() => toast.dismiss(toastId)}
          >
            取消
          </button>
          <button
              type="button"
              className="h-7 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 active:scale-[0.96]"
              onClick={() => {
                toast.dismiss(toastId)
                void window.electronAPI.updater?.installWhenIdle()
                  .then((scheduled) => {
                    if (!scheduled) {
                      toast.error('更新尚未准备好，请稍后重试')
                      return
                    }

                    toast.custom((scheduledToastId) => (
                      <div className="w-[312px] max-w-[calc(100vw-32px)] rounded-xl bg-background/95 p-3 text-foreground shadow-[0_12px_32px_rgba(0,0,0,0.14)] ring-1 ring-black/5 backdrop-blur-xl dark:ring-white/10">
                        <div className="flex items-center gap-2.5">
                          <img src={CopisLogo} alt="Copis" className="size-7 rounded-md" />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold tracking-tight">已安排空闲时更新</p>
                            <p className="text-xs leading-4 text-muted-foreground">当前任务结束后会自动重启安装。</p>
                          </div>
                        </div>
                        <div className="mt-2 flex justify-end">
                          <button
                            type="button"
                            className="h-7 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-[0.96]"
                            onClick={() => {
                              void window.electronAPI.updater?.cancelIdleInstall()
                              toast.dismiss(scheduledToastId)
                            }}
                          >
                            取消安排
                          </button>
                        </div>
                      </div>
                    ), {
                      duration: Infinity,
                      dismissible: false,
                      unstyled: true,
                    })
                  })
                  .catch(() => {
                    toast.error('无法安排空闲更新，请稍后重试')
                  })
              }}
            >
              空闲时更新
            </button>
        </div>
      </div>
    ), {
      duration: Infinity,
      dismissible: false,
      unstyled: true,
    })
  }, [updateStatus])

  return null
}

/**
 * 定时任务初始化组件
 *
 * 加载全部定时任务，并订阅主进程的变更事件（运行完成/状态变化）刷新列表。
 */
function PlanningShortcutInitializer(): null {
  useEffect(() => {
    initShortcutRegistry()
    void window.electronAPI.getSettings().then((settings) => {
      updateShortcutOverrides(settings.shortcutOverrides ?? {})
    }).catch((error) => {
      console.error('[任务/日程] 加载快捷键设置失败:', error)
    })
  }, [])
  return null
}

function PlanningInitializer(): null {
  const setTodos = useSetAtom(todosAtom)
  const setCalendarEvents = useSetAtom(calendarEventsAtom)
  const setTodoGroups = useSetAtom(todoPlanningGroupsAtom)
  const setTags = useSetAtom(planningTagsAtom)

  useEffect(() => {
    let disposed = false
    const latestRequest = { todos: 0, calendarEvents: 0, todoGroups: 0, tags: 0 }
    const loadTodos = (): void => {
      const requestId = ++latestRequest.todos
      void window.electronAPI.listTodos().then((todos) => {
        if (!disposed && requestId === latestRequest.todos) setTodos(todos)
      }).catch((error: unknown) => console.error('[任务/日程] 加载 Todo 失败:', error))
    }
    const loadCalendarEvents = (): void => {
      const requestId = ++latestRequest.calendarEvents
      void window.electronAPI.listCalendarEvents().then((events) => {
        if (!disposed && requestId === latestRequest.calendarEvents) setCalendarEvents(events)
      }).catch((error: unknown) => console.error('[任务/日程] 加载日程失败:', error))
    }
    const loadTodoGroups = (): void => {
      const requestId = ++latestRequest.todoGroups
      void window.electronAPI.listPlanningGroups('todo').then((groups) => {
        if (!disposed && requestId === latestRequest.todoGroups) setTodoGroups(groups)
      }).catch((error: unknown) => console.error('[任务/日程] 加载 Todo 分组失败:', error))
    }
    const loadTags = (): void => {
      const requestId = ++latestRequest.tags
      void window.electronAPI.listPlanningTags().then((tags) => {
        if (!disposed && requestId === latestRequest.tags) setTags(tags)
      }).catch((error: unknown) => console.error('[任务/日程] 加载标签失败:', error))
    }
    const load = (resources?: string[]): void => {
      const includes = (resource: string): boolean => resources === undefined || resources.includes(resource)
      if (includes('todos')) loadTodos()
      if (includes('calendar_events')) loadCalendarEvents()
      if (includes('todo_groups')) loadTodoGroups()
      if (includes('tags')) loadTags()
    }
    load()
    const unsubscribe = window.electronAPI.onPlanningChanged((change) => load(change.resources))
    return () => { disposed = true; unsubscribe() }
  }, [setCalendarEvents, setTags, setTodoGroups, setTodos])

  return null
}

function AutomationInitializer(): null {
  const setAutomations = useSetAtom(automationsAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)

  useEffect(() => {
    let disposed = false
    const load = (): void => {
      if (disposed) return
      window.electronAPI.listAutomations().then(setAutomations).catch(console.error)
      window.electronAPI.listAgentSessions().then(setAgentSessions).catch(console.error)
    }

    // 等待系统核心服务就绪后再拉取定时任务，避免窗口创建早于 Rust API 健康检查。
    void window.electronAPI.ensureRequiredFunctionalModules()
      .catch((error: unknown) => {
        console.error('[自动化] 等待系统核心服务失败:', error)
      })
      .finally(() => { load() })

    const unsub = window.electronAPI.onAutomationChanged(load)
    return () => {
      disposed = true
      unsub()
    }
  }, [setAutomations, setAgentSessions])

  return null
}

/**
 * 通知初始化组件
 *
 * 从主进程加载通知开关设置。
 */
function NotificationsInitializer(): null {
  const setEnabled = useSetAtom(notificationsEnabledAtom)
  const setSoundEnabled = useSetAtom(notificationSoundEnabledAtom)
  const setSounds = useSetAtom(notificationSoundsAtom)

  useEffect(() => {
    void initializeNotifications(setEnabled, setSoundEnabled, setSounds)
  }, [setEnabled, setSoundEnabled, setSounds])

  return null
}

/**
 * Dock/Launcher 角标同步组件
 *
 * 将需要用户处理或查看的事项数量同步到系统应用图标。
 */
function DockBadgeInitializer(): null {
  const count = useAtomValue(dockBadgeCountAtom)
  const notificationsEnabled = useAtomValue(notificationsEnabledAtom)
  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const setUnviewedCompleted = useSetAtom(unviewedCompletedSessionIdsAtom)
  const badgeCount = notificationsEnabled ? count : 0
  const activeAgentSessionId = useMemo(() => {
    const activeTab = activeTabId ? tabs.find((tab) => tab.id === activeTabId) : null
    return activeTab?.type === 'agent' || activeTab?.type === 'preview'
      ? activeTab.sessionId
      : null
  }, [activeTabId, tabs])

  useEffect(() => {
    window.electronAPI.setDockBadgeCount(badgeCount).catch((error) => {
      console.error('[Dock 角标] 同步失败:', error)
    })
  }, [badgeCount])

  useEffect(() => {
    const clearActiveSessionBadge = (): void => {
      if (!document.hasFocus() || !activeAgentSessionId) return
      setUnviewedCompleted((prev) => {
        if (!prev.has(activeAgentSessionId)) return prev
        const next = new Set(prev)
        next.delete(activeAgentSessionId)
        return next
      })
    }

    clearActiveSessionBadge()
    window.addEventListener('focus', clearActiveSessionBadge)
    document.addEventListener('visibilitychange', clearActiveSessionBadge)
    return () => {
      window.removeEventListener('focus', clearActiveSessionBadge)
      document.removeEventListener('visibilitychange', clearActiveSessionBadge)
    }
  }, [activeAgentSessionId, setUnviewedCompleted])

  return null
}

/**
 * UI 偏好初始化组件
 *
 * 从主进程加载 UI 偏好设置（悬浮置顶条、输入框 Markdown 渲染等）。
 */
function UiPreferencesInitializer(): null {
  const setStickyUserMessageEnabled = useSetAtom(stickyUserMessageEnabledAtom)
  const setLongTextPasteAsAttachmentEnabled = useSetAtom(longTextPasteAsAttachmentEnabledAtom)
  const setRichTextRenderingEnabled = useSetAtom(richTextRenderingEnabledAtom)
  const setSessionHoverPreviewEnabled = useSetAtom(sessionHoverPreviewEnabledAtom)

  useEffect(() => {
    initializeUiPreferences(
      setStickyUserMessageEnabled,
      setLongTextPasteAsAttachmentEnabled,
      setRichTextRenderingEnabled,
      setSessionHoverPreviewEnabled
    )
  }, [setStickyUserMessageEnabled, setLongTextPasteAsAttachmentEnabled, setRichTextRenderingEnabled, setSessionHoverPreviewEnabled])

  return null
}

/**
 * Markdown 字号初始化组件
 *
 * 从主进程加载字号档位，写入 :root CSS 变量驱动 Markdown 预览。
 */
function MarkdownFontSizeInitializer(): null {
  const setMarkdownFontSize = useSetAtom(markdownFontSizeAtom)

  useEffect(() => {
    initializeMarkdownFontSize(setMarkdownFontSize)
  }, [setMarkdownFontSize])

  return null
}

/**
 * 固定项目初始化组件
 *
 * 从主进程加载「我的项目」固定列表，供右侧项目列表与左侧边栏共享。
 */
function PinnedDevProjectsInitializer(): null {
  const setPinnedDevProjects = useSetAtom(pinnedDevProjectsAtom)

  useEffect(() => {
    void initializePinnedDevProjects(setPinnedDevProjects)
  }, [setPinnedDevProjects])

  return null
}

/**
 * Agent IPC 监听器初始化组件
 *
 * 全局挂载，永不销毁。确保 Agent 流式事件、权限请求
 * 在页面切换时不丢失。
 */
function AgentListenersInitializer(): null {
  useGlobalAgentListeners()
  return null
}

/**
 * Agent 工具初始化组件
 *
 * 启动时从主进程加载所有工具信息到 atom。
 * 订阅工具配置文件变更通知，自动刷新工具列表。
 */
function AgentToolInitializer(): null {
  const setAgentTools = useSetAtom(agentToolsAtom)

  useEffect(() => {
    window.electronAPI.getAgentTools()
      .then(setAgentTools)
      .catch((err: unknown) => console.error('[AgentToolInitializer] 加载工具列表失败:', err))
  }, [setAgentTools])

  // 订阅自定义工具配置变更
  useEffect(() => {
    const cleanup = window.electronAPI.onAgentToolChanged(() => {
      window.electronAPI.getAgentTools()
        .then((tools) => {
          setAgentTools(tools)
          toast.success('Agent 工具已更新')
        })
        .catch((err: unknown) => console.error('[AgentToolInitializer] 刷新工具列表失败:', err))
    })
    return cleanup
  }, [setAgentTools])

  return null
}

/**
 * 飞书集成初始化组件
 *
 * - 订阅飞书 Bridge 状态变化
 * - 定期上报用户在场状态（用于智能通知路由）
 * - 监听通知已发送事件（显示 Sonner + 桌面通知）
 */
function FeishuInitializer(): null {
  const store = useStore()

  useEffect(() => {
    // 加载初始多 Bot 状态
    window.electronAPI.getFeishuMultiStatus?.()
      .then((multiState: { bots: Record<string, FeishuBotBridgeState> }) => {
        store.set(feishuBotStatesAtom, multiState.bots)
      })
      .catch(() => {
        // 回退：使用旧 API 获取单 Bot 状态
        window.electronAPI.getFeishuStatus()
          .then((state: FeishuBridgeState) => {
            const s = state as FeishuBotBridgeState
            const botId = s.botId ?? 'default'
            store.set(feishuBotStatesAtom, { [botId]: { ...s, botId, botName: s.botName ?? '飞书助手' } })
          })
          .catch((err: unknown) => console.error('[FeishuInitializer] 加载状态失败:', err))
      })

    // 订阅状态变化（现在每次推送包含 botId）
    const cleanupStatus = window.electronAPI.onFeishuStatusChanged((raw: FeishuBridgeState) => {
      const state = raw as FeishuBotBridgeState
      const botId = state.botId ?? 'default'
      store.set(feishuBotStatesAtom, (prev) => ({
        ...prev,
        [botId]: { ...state, botId, botName: state.botName ?? '飞书助手' },
      }))
    })

    // 定期上报在场状态（5 秒间隔 + 焦点变化时即时上报）
    const reportPresence = (): void => {
      const activeSessionId = store.get(currentAgentSessionIdAtom)
      window.electronAPI.reportFeishuPresence({
        activeSessionId,
        lastInteractionAt: Date.now(),
      }).catch(() => { /* 忽略 */ })
    }
    const interval = setInterval(reportPresence, 5000)
    window.addEventListener('focus', reportPresence)
    window.addEventListener('blur', reportPresence)

    return () => {
      cleanupStatus()
      clearInterval(interval)
      window.removeEventListener('focus', reportPresence)
      window.removeEventListener('blur', reportPresence)
    }
  }, [store])

  return null
}

/**
 * DingTalkInitializer
 *
 * - 加载多 Bot 初始状态
 * - 订阅钉钉 Bridge 状态变化
 */
function DingTalkInitializer(): null {
  const store = useStore()

  useEffect(() => {
    // 加载初始多 Bot 状态
    window.electronAPI.getDingTalkMultiStatus?.()
      .then((multiState: { bots: Record<string, DingTalkBotBridgeState> }) => {
        store.set(dingtalkBotStatesAtom, multiState.bots)
      })
      .catch(() => {
        // 回退：使用旧 API 获取单 Bot 状态
        window.electronAPI.getDingTalkStatus()
          .then((state: DingTalkBridgeState) => {
            const s = state as DingTalkBotBridgeState
            const botId = s.botId ?? 'default'
            store.set(dingtalkBotStatesAtom, { [botId]: { ...s, botId, botName: s.botName ?? '钉钉助手' } })
          })
          .catch((err: unknown) => console.error('[DingTalkInitializer] 加载状态失败:', err))
      })

    // 订阅状态变化（现在每次推送包含 botId）
    const cleanupStatus = window.electronAPI.onDingTalkStatusChanged((raw: DingTalkBridgeState) => {
      const state = raw as DingTalkBotBridgeState
      const botId = state.botId ?? 'default'
      store.set(dingtalkBotStatesAtom, (prev) => ({
        ...prev,
        [botId]: { ...state, botId, botName: state.botName ?? '钉钉助手' },
      }))
    })

    return () => {
      cleanupStatus()
    }
  }, [store])

  return null
}

/**
 * 标签页持久化组件
 *
 * 启动时从 settings.tabState 恢复上次打开的标签页；
 * 运行时监听标签页变化，自动保存到 settings.json。
 */

/**
 * 旧版（分屏时代）持久化结构——仅用于向后兼容读取迁移。
 * 新版已扁平化为 { tabs, activeTabId }；旧版是 { tabs, splitLayout }。
 */
interface LegacyTabStateWithSplitLayout {
  splitLayout?: {
    focusedPanelIndex?: number
    panels?: Array<{ activeTabId?: string | null }>
  }
}

/** 从旧版 splitLayout 结构中提取原焦点面板的 activeTabId */
function extractLegacyActiveTabId(tabState: unknown): string | null {
  if (!tabState || typeof tabState !== 'object') return null
  const legacy = tabState as LegacyTabStateWithSplitLayout
  const panels = legacy.splitLayout?.panels
  if (!Array.isArray(panels) || panels.length === 0) return null
  const focusedIndex = legacy.splitLayout?.focusedPanelIndex ?? 0
  return panels[focusedIndex]?.activeTabId ?? panels[0]?.activeTabId ?? null
}

function TabStatePersistenceInitializer(): null {
  const store = useStore()
  const restoredRef = useRef(false)

  // 启动恢复：读取 settings.tabState + 校验会话有效性
  useEffect(() => {
    store.set(appModeAtom, normalizeAppMode(store.get(appModeAtom)))

    Promise.all([
      window.electronAPI.getSettings(),
      window.electronAPI.listAgentSessions(),
    ]).then(([settings, agentSessions]) => {
      const tabState = settings.tabState
      const validSessionIds = new Set(agentSessions.map((s) => s.id))

      // 过滤旧版 Scratch/Preview/Chat 入口，只恢复有效 Agent 会话。
      const validTabs = sanitizePersistedTabs(tabState?.tabs, validSessionIds)

      // 旧配置没有可恢复 Tab 时，优先进入上次工作区中的最近 Agent 会话。
      const sortByUpdatedAt = <T extends { updatedAt: number }>(items: T[]): T[] =>
        [...items].sort((a, b) => b.updatedAt - a.updatedAt)
      const preferredAgentSessions = sortByUpdatedAt(
        agentSessions.filter((session) =>
          !session.archived && (!settings.agentWorkspaceId || session.workspaceId === settings.agentWorkspaceId)
        ),
      )
      const recentAgentSession = preferredAgentSessions[0] ?? sortByUpdatedAt(
        agentSessions.filter((session) => !session.archived),
      )[0]
      const fallbackTab: TabItem | null = recentAgentSession
        ? { id: recentAgentSession.id, type: 'agent', sessionId: recentAgentSession.id, title: recentAgentSession.title }
        : null
      const tabsToRestore = validTabs.length > 0 ? validTabs : fallbackTab ? [fallbackTab] : []
      if (tabsToRestore.length === 0) {
        restoredRef.current = true
        return
      }

      const validTabIds = new Set(tabsToRestore.map((t) => t.id))

      // 恢复 activeTabId（校验有效性）
      let restoredActiveTabId: string | null = null
      if (tabState?.activeTabId && validTabIds.has(tabState.activeTabId)) {
        restoredActiveTabId = tabState.activeTabId
      } else {
        // 向后兼容：从旧版 splitLayout 结构中恢复原焦点面板的 activeTabId
        const legacyId = extractLegacyActiveTabId(tabState)
        if (legacyId && validTabIds.has(legacyId)) {
          restoredActiveTabId = legacyId
        } else {
          restoredActiveTabId = tabsToRestore[0]?.id ?? null
        }
      }

      const activeTab = tabsToRestore.find((t) => t.id === restoredActiveTabId) ?? tabsToRestore[0] ?? null
      store.set(tabsAtom, tabsToRestore)
      store.set(activeTabIdAtom, activeTab?.id ?? null)

      // 同步模式、当前 Agent 会话和工作区。
      if (activeTab?.type === 'agent') {
        store.set(appModeAtom, 'agent')
        store.set(currentAgentSessionIdAtom, activeTab.sessionId)
        const session = agentSessions.find((item) => item.id === activeTab.sessionId)
        if (session?.workspaceId) store.set(currentAgentWorkspaceIdAtom, session.workspaceId)
      }

      console.log(`[TabRestore] 已恢复当前会话入口，历史标签 ${tabsToRestore.length} 个已收敛到左侧列表`)
    }).catch((err) => console.error('[TabRestore] 恢复标签页失败:', err))
      .finally(() => { restoredRef.current = true })
  }, [store])

  // 自动保存：监听 tabsAtom / activeTabIdAtom 变化，防抖写入 settings.json
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null

    const save = (): void => {
      const tabs = store.get(tabsAtom)
      const activeTabId = store.get(activeTabIdAtom)
      const persistableTabState = getPersistableTabState(tabs, activeTabId)
      window.electronAPI.updateSettings({
        tabState: persistableTabState,
      }).catch(console.error)
    }

    const debouncedSave = (): void => {
      if (!restoredRef.current) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(save, 500)
    }

    const unsub1 = store.sub(tabsAtom, debouncedSave)
    const unsub2 = store.sub(activeTabIdAtom, debouncedSave)

    // 窗口关闭前立即刷新，避免最后 500ms 内的变更丢失
    const handleBeforeUnload = (): void => {
      if (timer) clearTimeout(timer)
      // 使用同步 IPC 确保关闭前数据写入磁盘
      const tabs = store.get(tabsAtom)
      const activeTabId = store.get(activeTabIdAtom)
      const persistableTabState = getPersistableTabState(tabs, activeTabId)
      if (tabs.length > 0 && window.electronAPI.updateSettingsSync) {
        const ok = window.electronAPI.updateSettingsSync({ tabState: persistableTabState })
        if (!ok) {
          console.warn('[TabPersist] sync IPC failed, falling back to async save')
          save()
        }
      } else {
        save()
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      unsub1()
      unsub2()
      if (timer) clearTimeout(timer)
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [store])

  return null
}

// ===== 快速任务窗口：轻量渲染 =====
if (isQuickTaskWindow) {
  import('./components/quick-task/QuickTaskApp').then(({ QuickTaskApp }) => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <ThemeInitializer />
        <QuickTaskApp />
      </React.StrictMode>
    )
  })
} else if (isVoiceDictationIndicatorWindow) {
  import('./components/voice-dictation/VoiceDictationIndicatorApp').then(({ VoiceDictationIndicatorApp }) => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <ThemeInitializer />
        <VoiceDictationIndicatorApp />
      </React.StrictMode>
    )
  })
} else if (isDetachedPreviewWindow) {
  import('./components/diff/DetachedPreviewApp').then(({ DetachedPreviewApp }) => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <ThemeInitializer />
        <MarkdownFontSizeInitializer />
        <DetachedPreviewApp />
        <Toaster position="bottom-right" />
      </React.StrictMode>
    )
  })
} else if (isPlanningWindow) {
  import('./components/planning/PlanningWindowApp').then(({ PlanningWindowApp }) => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <ThemeInitializer />
        <AgentSettingsInitializer />
        <PlanningShortcutInitializer />
        <AutomationInitializer />
        <PlanningInitializer />
        <PlanningWindowApp />
        <Toaster position="bottom-right" />
      </React.StrictMode>
    )
  })
} else if (isWebBookmarksWindow) {
  import('./components/web-browser/WebBookmarksWindowApp').then(({ WebBookmarksWindowApp }) => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <ThemeInitializer />
        <WebBookmarksWindowApp />
      </React.StrictMode>
    )
  })
} else {
  // ===== 主窗口：完整渲染 =====
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ThemeInitializer />
      <AgentSettingsInitializer />
      <NotificationsInitializer />
      <DockBadgeInitializer />
      <UiPreferencesInitializer />
      <MarkdownFontSizeInitializer />
      <PinnedDevProjectsInitializer />
      <AgentListenersInitializer />
      <AgentToolInitializer />
      <UpdaterInitializer />
      <AutomationInitializer />
      <PlanningInitializer />
      <FeishuInitializer />
      <DingTalkInitializer />
      <TabStatePersistenceInitializer />
      <WindowControls quitApp />
      <VoiceDictationApp embedded />
      <GlobalShortcuts />
      <TabSwitcher />
      <App />
      <Toaster position="bottom-right" />
    </React.StrictMode>
  )
}
