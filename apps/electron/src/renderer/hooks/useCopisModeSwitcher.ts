import { useCallback, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  agentSessionsAtom,
  currentAgentWorkspaceIdAtom,
} from '@/atoms/agent-atoms'
import {
  appModeAtom,
  creationModeSkipConfirmAtom,
  setAppModeAndRuntimeAtom,
  type AppMode,
  dshCordisStatusAtom,
} from '@/atoms/app-mode'
import { activeViewAtom } from '@/atoms/active-view'
import { activeWebTabIdAtom } from '@/atoms/web-tabs'
import { CREATION_MODE_SWITCH_DISABLED } from '@/lib/creation-mode-switch'
import { useCreateSession } from './useCreateSession'
import { useOpenSession } from './useOpenSession'

export interface CopisModeSwitcherState {
  currentMode: AppMode
  confirmDialogOpen: boolean
  setConfirmDialogOpen: (open: boolean) => void
  handleSwitchMode: (nextMode: AppMode) => void
  executeSwitchToCreation: () => void
}

/** 统一处理 Copis Agent/创造模式切换，供侧边栏与首页 Tab 菜单复用。 */
export function useCopisModeSwitcher(): CopisModeSwitcherState {
  const currentMode = useAtomValue(appModeAtom)
  const skipConfirm = useAtomValue(creationModeSkipConfirmAtom)
  const agentSessions = useAtomValue(agentSessionsAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const setAppModeAndRuntime = useSetAtom(setAppModeAndRuntimeAtom)
  const setDshCordisStatus = useSetAtom(dshCordisStatusAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const setActiveWebTabId = useSetAtom(activeWebTabIdAtom)
  const openSession = useOpenSession()
  const { createAgent } = useCreateSession()
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false)

  const executeSwitchToCreation = useCallback(() => {
    if (CREATION_MODE_SWITCH_DISABLED) {
      console.warn('[模式切换] 当前构建已禁用创造模式')
      setConfirmDialogOpen(false)
      return
    }

    // 网页 WebContentsView 位于 React DOM 之上。先回到 Copis 首页，避免活动网页遮挡创造模式原生视图。
    setActiveWebTabId(null)
    void window.electronAPI.webTabs.activate(null)
      .catch((err) => console.error('[模式切换] 退出活动网页页签失败:', err))

    setAppModeAndRuntime('creation')
    setActiveView('conversations')

    // 进入创造模式时按需预热并启动 DSH Cordis Web 服务。
    window.electronAPI.dshCordis.start()
      .then((status) => setDshCordisStatus(status))
      .catch((err) => {
        console.warn('[模式切换] 启动 DSH Cordis 服务失败:', err)
        setDshCordisStatus({
          running: false,
          error: err instanceof Error ? err.message : String(err),
        })
      })
  }, [setActiveView, setActiveWebTabId, setAppModeAndRuntime, setDshCordisStatus])

  const switchToAgent = useCallback(() => {
    setAppModeAndRuntime('agent')
    setActiveView('conversations')

    const matchedSession = agentSessions.find(
      (session) => (
        !session.archived
        && session.workspaceId === currentWorkspaceId
        && session.mode !== 'creation'
        && session.agentRuntime !== 'dsh'
      ),
    )

    if (matchedSession) {
      openSession('agent', matchedSession.id, matchedSession.title)
    } else {
      void createAgent({
        draft: true,
        mode: 'agent',
        agentRuntime: 'pi',
      })
    }
  }, [agentSessions, createAgent, currentWorkspaceId, openSession, setActiveView, setAppModeAndRuntime])

  const handleSwitchMode = useCallback((nextMode: AppMode) => {
    if (nextMode === currentMode) return

    if (nextMode === 'creation') {
      if (CREATION_MODE_SWITCH_DISABLED) {
        console.warn('[模式切换] 当前构建已禁用创造模式')
        return
      }
      if (skipConfirm) {
        executeSwitchToCreation()
      } else {
        setConfirmDialogOpen(true)
      }
      return
    }

    switchToAgent()
  }, [currentMode, executeSwitchToCreation, skipConfirm, switchToAgent])

  return {
    currentMode,
    confirmDialogOpen,
    setConfirmDialogOpen,
    handleSwitchMode,
    executeSwitchToCreation,
  }
}
