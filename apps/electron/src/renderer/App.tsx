import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai'
import { AppShell } from './components/app-shell/AppShell'
import { OnboardingView } from './components/onboarding/OnboardingView'
import { TutorialBanner } from './components/tutorial/TutorialBanner'
import { EnvironmentCheckDialog } from './components/environment/EnvironmentCheckDialog'
import { MigrationImportDialog } from './components/migration/MigrationImportDialog'
import { TooltipProvider } from './components/ui/tooltip'
import { ShortcutGuideDialog } from './components/shortcuts/ShortcutGuideDialog'
import { PlanningReminderRail } from './components/planning/PlanningReminderRail'
import { conversationsAtom } from './atoms/chat-atoms'
import { environmentCheckDialogOpenAtom } from './atoms/environment'
import { tabsAtom, activeTabIdAtom, openTab, TUTORIAL_TAB_ID, TUTORIAL_TAB_TITLE } from './atoms/tab-atoms'
import { appModeAtom } from './atoms/app-mode'
import {
  agentSessionsAtom,
  agentSettingsReadyAtom,
  currentAgentSessionIdAtom,
  currentAgentWorkspaceIdAtom,
} from './atoms/agent-atoms'
import type { AppShellContextType } from './contexts/AppShellContext'

export default function App(): React.ReactElement {
  // 应用级初始化状态。

  const store = useStore()
  const [isLoading, setIsLoading] = React.useState(true)
  const [showOnboarding, setShowOnboarding] = React.useState(false)

  // 初始化：检查是否需要显示 Onboarding
  // macOS/Linux 上 SDK 自带 claude native binary 不依赖宿主 Node/Git；
  // Windows 上仍需 Git Bash/WSL，由 Onboarding Step 2 与聊天错误卡片引导用户安装。
  React.useEffect(() => {
    const initialize = async () => {
      try {
        const settings = await window.electronAPI.getSettings()
        if (!settings.onboardingCompleted) {
          setShowOnboarding(true)
        }
      } catch (error) {
        console.error('[App] 初始化失败:', error)
      } finally {
        setIsLoading(false)
      }
    }

    initialize()
  }, [])

  // 完成 onboarding 回调：创建欢迎对话，可选打开教程 Tab
  const handleOnboardingComplete = async (openTutorial?: boolean) => {
    setShowOnboarding(false)

    if (openTutorial) {
      const tabs = store.get(tabsAtom)
      const result = openTab(tabs, { type: 'tutorial', sessionId: TUTORIAL_TAB_ID, title: TUTORIAL_TAB_TITLE })
      store.set(tabsAtom, result.tabs)
      store.set(activeTabIdAtom, result.activeTabId)
      return
    }

    try {
      const meta = await window.electronAPI.createWelcomeConversation()
      if (meta) {
        const conversations = store.get(conversationsAtom)
        store.set(conversationsAtom, [meta, ...conversations])

        const tabs = store.get(tabsAtom)
        const result = openTab(tabs, {
          type: 'chat',
          sessionId: meta.id,
          title: meta.title,
        })
        store.set(tabsAtom, result.tabs)
        store.set(activeTabIdAtom, result.activeTabId)
      }
    } catch (error) {
      console.error('[App] 创建欢迎对话失败:', error)
    }
  }

  // 加载中状态
  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">正在初始化...</p>
        </div>
      </div>
    )
  }

  // 显示 onboarding 界面
  if (showOnboarding) {
    return (
      <TooltipProvider delayDuration={200}>
        <OnboardingView onComplete={handleOnboardingComplete} />
        <MigrationImportDialog />
      </TooltipProvider>
    )
  }

  // Placeholder context value
  const contextValue: AppShellContextType = {}

  // 显示主界面
  return (
    <TooltipProvider delayDuration={200}>
      <CopisStartupInitializer />
      <AppShell contextValue={contextValue} />
      <PlanningReminderRail />
      <ShortcutGuideDialog />
      <TutorialBanner />
      <GlobalEnvironmentCheckDialog />
      <MigrationImportDialog />
    </TooltipProvider>
  )
}

/**
 * Copis 默认直接进入本地 Agent。
 * 只复用已有 Agent 会话和工作区 API，不创建第二套运行时。
 */
function CopisStartupInitializer(): null {
  const store = useStore()
  const agentSettingsReady = useAtomValue(agentSettingsReadyAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const setAppMode = useSetAtom(appModeAtom)
  const setCurrentAgentSessionId = useSetAtom(currentAgentSessionIdAtom)
  const setCurrentAgentWorkspaceId = useSetAtom(currentAgentWorkspaceIdAtom)
  const startedRef = React.useRef(false)

  React.useEffect(() => {
    if (!agentSettingsReady || startedRef.current) return
    startedRef.current = true

    const initialize = async (): Promise<void> => {
      const sessions = await window.electronAPI.listAgentSessions()
      setAgentSessions(sessions)

      const existingAgentTab = store.get(tabsAtom).find((tab) => tab.type === 'agent')
      if (existingAgentTab) {
        setAppMode('agent')
        setCurrentAgentSessionId(existingAgentTab.sessionId)
        store.set(activeTabIdAtom, existingAgentTab.id)
        return
      }

      const workspaceId = store.get(currentAgentWorkspaceIdAtom) ?? undefined
      const session = sessions.find((item) => !item.archived && (!workspaceId || item.workspaceId === workspaceId))
        ?? sessions.find((item) => !item.archived)
      const activeSession = session ?? await window.electronAPI.createAgentSession(undefined, undefined, workspaceId)
      const nextWorkspaceId = activeSession.workspaceId ?? workspaceId
      if (nextWorkspaceId) {
        setCurrentAgentWorkspaceId(nextWorkspaceId)
        void window.electronAPI.updateSettings({ agentWorkspaceId: nextWorkspaceId }).catch(console.error)
      }
      setAppMode('agent')
      setCurrentAgentSessionId(activeSession.id)
      const result = openTab(store.get(tabsAtom), {
        type: 'agent',
        sessionId: activeSession.id,
        title: activeSession.title,
      })
      store.set(tabsAtom, result.tabs)
      store.set(activeTabIdAtom, result.activeTabId)
    }

    void initialize().catch((error) => {
      startedRef.current = false
      console.error('[Copis] 默认 Agent 初始化失败:', error)
    })
  }, [agentSettingsReady, setAgentSessions, setAppMode, setCurrentAgentSessionId, setCurrentAgentWorkspaceId, store])

  return null
}

/**
 * 全局环境检测 Dialog，由错误卡片的 recovery action 按钮打开。
 */
function GlobalEnvironmentCheckDialog(): React.ReactElement {
  const [open, setOpen] = useAtom(environmentCheckDialogOpenAtom)
  return <EnvironmentCheckDialog open={open} onOpenChange={setOpen} />
}
