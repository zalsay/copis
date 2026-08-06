/**
 * GlobalShortcuts — 全局快捷键注册 + 初始化组件
 *
 * 在 main.tsx 顶层挂载（类似 AgentListenersInitializer），永不销毁。
 * 负责：
 * 1. 初始化快捷键注册表
 * 2. 从 settings 加载用户自定义配置
 * 3. 注册所有应用级快捷键的 handler
 * 4. 监听菜单 IPC 事件（Cmd+W 关闭标签）
 */

import { useEffect, useCallback } from 'react'
import { useAtomValue, useSetAtom, useAtom, useStore } from 'jotai'
import { appModeAtom } from '@/atoms/app-mode'
import { settingsOpenAtom, channelFormDirtyAtom, settingsCloseRequestedAtom } from '@/atoms/settings-tab'
import { searchDialogOpenAtom } from '@/atoms/search-atoms'
import {
  tabsAtom,
  activeTabIdAtom,
  sidebarCollapsedAtom,
  openTab,
} from '@/atoms/tab-atoms'
import { shortcutOverridesAtom, sendWithCmdEnterAtom } from '@/atoms/shortcut-atoms'
import { shortcutGuideOpenAtom } from '@/atoms/shortcut-guide'
import {
  agentPendingPromptAtom,
  agentSessionDraftHtmlAtom,
  agentSessionDraftsAtom,
  agentSessionsAtom,
  currentAgentSessionIdAtom,
  agentChannelIdAtom,
  agentModelIdAtom,
  currentAgentWorkspaceIdAtom,
  agentWorkspacesAtom,
  agentAttachedFilesMapAtom,
} from '@/atoms/agent-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { useCreateSession } from '@/hooks/useCreateSession'
import { useShortcut } from '@/hooks/useShortcut'
import { useCloseTab } from '@/hooks/useCloseTab'
import {
  initShortcutRegistry,
  updateShortcutOverrides,
} from '@/lib/shortcut-registry'
import { getFileParentPath } from '@/lib/file-utils'
import {
  VOICE_DICTATION_CLEAR_PREVIEW_EVENT,
  VOICE_DICTATION_PREVIEW_EVENT,
} from '@/lib/voice-input-focus'

/**
 * 快捷键初始化 + 全局 Handler 注册
 *
 * 挂载后从 settings 加载自定义配置，并注册所有应用级快捷键。
 */
export function GlobalShortcuts(): null {
  const [settingsOpen, setSettingsOpen] = useAtom(settingsOpenAtom)
  const channelFormDirty = useAtomValue(channelFormDirtyAtom)
  const setSettingsCloseRequested = useSetAtom(settingsCloseRequestedAtom)
  const [searchOpen, setSearchOpen] = useAtom(searchDialogOpenAtom)
  const [shortcutGuideOpen, setShortcutGuideOpen] = useAtom(shortcutGuideOpenAtom)
  const [sidebarCollapsed, setSidebarCollapsed] = useAtom(sidebarCollapsedAtom)
  const setShortcutOverrides = useSetAtom(shortcutOverridesAtom)
  const shortcutOverrides = useAtomValue(shortcutOverridesAtom)
  const setSendWithCmdEnter = useSetAtom(sendWithCmdEnterAtom)
  const { createAgent } = useCreateSession()

  // Tab 管理（用于关闭标签页）
  const activeTabId = useAtomValue(activeTabIdAtom)

  // 统一关闭逻辑：与 TabBar.handleClose 共用
  // 含 Agent 子进程 stop + 流式中的确认对话框（修复 Issue #357）
  const { requestClose } = useCloseTab()

  // 初始化：挂载注册表 + 加载用户配置
  useEffect(() => {
    initShortcutRegistry()

    window.electronAPI.getSettings().then((settings) => {
      if (settings.shortcutOverrides) {
        setShortcutOverrides(settings.shortcutOverrides)
        updateShortcutOverrides(settings.shortcutOverrides)
      }
      setSendWithCmdEnter(settings.sendWithCmdEnter ?? false)
    }).catch(console.error)
  }, [setShortcutOverrides, setSendWithCmdEnter])

  // 配置变更时同步到注册表
  useEffect(() => {
    updateShortcutOverrides(shortcutOverrides)
  }, [shortcutOverrides])

  // ===== 关闭标签页逻辑 =====

  const handleCloseTab = useCallback(() => {
    // 浮窗优先：有浮窗打开时 Cmd+W 先关闭浮窗而非 tab
    if (shortcutGuideOpen) {
      setShortcutGuideOpen(false)
      return
    }
    if (settingsOpen) {
      // 渠道表单有未保存内容时，通知 SettingsPanel 弹出确认对话框
      if (channelFormDirty) {
        setSettingsCloseRequested(true)
        return
      }
      setSettingsOpen(false)
      return
    }
    if (searchOpen) {
      setSearchOpen(false)
      return
    }

    if (!activeTabId) return
    requestClose(activeTabId)
  }, [shortcutGuideOpen, setShortcutGuideOpen, settingsOpen, setSettingsOpen, channelFormDirty, setSettingsCloseRequested, searchOpen, setSearchOpen, activeTabId, requestClose])

  // 监听菜单 IPC 事件（Cmd+W 被 Electron 菜单拦截后通过 IPC 转发）
  useEffect(() => {
    const cleanup = window.electronAPI.onMenuCloseTab(handleCloseTab)
    return cleanup
  }, [handleCloseTab])

  // 同时注册到快捷键系统（用于设置面板展示和自定义，实际触发走 IPC）
  useShortcut('close-tab', handleCloseTab)

  // ===== 快捷键 Handler =====

  // Cmd+, → 打开设置
  useShortcut(
    'open-settings',
    useCallback(() => setSettingsOpen(true), [setSettingsOpen]),
  )

  // Cmd+Shift+F / Ctrl+Shift+F → 全局搜索
  useShortcut(
    'global-search',
    useCallback(() => setSearchOpen(true), [setSearchOpen]),
  )

  // Cmd+Shift+T / Ctrl+Shift+T → 打开或聚焦独立任务/日程窗口
  useShortcut(
    'open-planning',
    useCallback(() => {
      void window.electronAPI.openPlanningWindow().catch((error) => {
        console.error('[任务/日程] 打开独立窗口失败:', error)
      })
    }, []),
  )

  // Cmd+N → 新建 Agent 会话
  useShortcut(
    'new-session',
    useCallback(() => {
      void createAgent({ draft: true })
    }, [createAgent]),
  )

  // Cmd+B → 切换侧边栏
  useShortcut(
    'toggle-sidebar',
    useCallback(
      () => setSidebarCollapsed(!sidebarCollapsed),
      [sidebarCollapsed, setSidebarCollapsed],
    ),
  )

  // Cmd+K → 清除上下文（通过 CustomEvent 分发到 ChatInput）
  useShortcut(
    'clear-context',
    useCallback(() => {
      window.dispatchEvent(new CustomEvent('copis:clear-context'))
    }, []),
  )

  // Cmd+L → 聚焦输入框（通过 CustomEvent 分发到 ChatInput/AgentView）
  useShortcut(
    'focus-input',
    useCallback(() => {
      window.dispatchEvent(new CustomEvent('copis:focus-input'))
    }, []),
  )

  // Cmd+Shift+Backspace → 停止 Agent（通过 CustomEvent 分发到 ChatView/AgentView）
  useShortcut(
    'stop-generation',
    useCallback(() => {
      window.dispatchEvent(new CustomEvent('copis:stop-generation'))
    }, []),
  )

  // ===== 快速任务窗口 → 创建会话并自动发送 =====

  const store = useStore()

  useEffect(() => {
    const cleanup = window.electronAPI.onQuickTaskOpenSession(async (data) => {
      try {
        // 快速任务统一进入 Agent 会话。
        store.set(appModeAtom, 'agent')
        store.set(activeViewAtom, 'conversations')

        {
          // Agent 模式：创建会话 + 保存附件到 session 目录
          const channelId = store.get(agentChannelIdAtom) || undefined
          const modelId = store.get(agentModelIdAtom) || undefined
          const configuredWorkspaceId = store.get(currentAgentWorkspaceIdAtom) || undefined
          let workspaces = store.get(agentWorkspacesAtom)
          if (
            workspaces.length === 0
            || (configuredWorkspaceId && !workspaces.some((workspace) => workspace.id === configuredWorkspaceId))
          ) {
            try {
              workspaces = await window.electronAPI.listAgentWorkspaces()
              store.set(agentWorkspacesAtom, workspaces)
            } catch (error) {
              console.error('[快速任务] 加载 Agent 工作区失败:', error)
            }
          }
          const workspace = workspaces.find((item) => item.id === configuredWorkspaceId)
            ?? workspaces.find((item) => item.slug === 'default')
            ?? workspaces[0]
          const workspaceId = workspace?.id ?? configuredWorkspaceId
          if (workspace && workspace.id !== configuredWorkspaceId) {
            store.set(currentAgentWorkspaceIdAtom, workspace.id)
            void window.electronAPI.updateSettings({ agentWorkspaceId: workspace.id }).catch(console.error)
          }
          const meta = await window.electronAPI.createAgentSession(
            undefined,
            channelId,
            workspaceId,
            modelId,
          )
          // 更新 atom 状态
          store.set(agentSessionsAtom, (prev) => [meta, ...prev])
          store.set(currentAgentSessionIdAtom, meta.id)

          // 处理附件：保存到 session 目录，构建 file references
          let fileReferences = ''
          const additionalDirectories = new Set<string>()
          if (data.files && data.files.length > 0) {
            try {
              const allRefs: Array<{ filename: string; targetPath: string }> = []
              for (const file of data.files) {
                if (!file.sourcePath) continue
                const attachedFiles = await window.electronAPI.attachFile({
                  sessionId: meta.id,
                  filePath: file.sourcePath,
                })
                store.set(agentAttachedFilesMapAtom, (prev) => {
                  const map = new Map(prev)
                  map.set(meta.id, attachedFiles)
                  return map
                })
                allRefs.push({ filename: file.filename, targetPath: file.sourcePath })
                const parentPath = getFileParentPath(file.sourcePath)
                if (parentPath) additionalDirectories.add(parentPath)
              }

              const filesToSave = data.files.filter((f) => f.base64).map((f) => ({
                filename: f.filename,
                data: f.base64!,
              }))
              if (workspace && filesToSave.length > 0) {
                const saved = await window.electronAPI.saveFilesToAgentSession({
                  workspaceSlug: workspace.slug,
                  sessionId: meta.id,
                  files: filesToSave,
                })
                allRefs.push(...saved)
              }

              if (allRefs.length > 0) {
                const refs = allRefs.map((f) => `- ${f.filename}: ${f.targetPath}`).join('\n')
                fileReferences = `<attached_files>\n${refs}\n</attached_files>\n\n`
              }
            } catch (error) {
              console.error('[快速任务] 保存 Agent 附件失败:', error)
            }
          }

          // 打开新标签页
          const currentTabs = store.get(tabsAtom)
          const result = openTab(currentTabs, {
            type: 'agent',
            sessionId: meta.id,
            title: data.text.slice(0, 30),
          })
          store.set(tabsAtom, result.tabs)
          store.set(activeTabIdAtom, result.activeTabId)

          // 设置待发送消息（附件引用已内联到消息文本中）
          store.set(agentPendingPromptAtom, {
            sessionId: meta.id,
            message: fileReferences + data.text,
            ...(additionalDirectories.size > 0 && { additionalDirectories: Array.from(additionalDirectories) }),
          })
        }
      } catch (error) {
        console.error('[快速任务] 创建会话失败:', error)
      }
    })
    return cleanup
  }, [store])

  // ===== 语音输入 → 写入当前 Copis 输入框 =====

  useEffect(() => {
    const cleanupPreview = window.electronAPI.onVoiceDictationPreviewText((data) => {
      if (!data.text.trim()) return
      window.dispatchEvent(new CustomEvent(VOICE_DICTATION_PREVIEW_EVENT, { detail: data }))
    })
    const cleanupClearPreview = window.electronAPI.onVoiceDictationClearPreviewText((data) => {
      window.dispatchEvent(new CustomEvent(VOICE_DICTATION_CLEAR_PREVIEW_EVENT, { detail: data }))
    })
    const cleanup = window.electronAPI.onVoiceDictationInsertText((data) => {
      const trimmed = data.text.trim()
      if (!trimmed) return

      const insertedAtCursor = !window.dispatchEvent(new CustomEvent('copis:insert-voice-dictation-text', {
        cancelable: true,
        detail: { ...data, text: trimmed },
      }))
      if (insertedAtCursor) {
        window.dispatchEvent(new CustomEvent('copis:focus-input'))
        return
      }

      const tabs = store.get(tabsAtom)
      const activeTabId = store.get(activeTabIdAtom)
      const activeTab = tabs.find((tab) => tab.id === activeTabId)
      const fallbackTarget = { type: 'agent' as const, sessionId: store.get(currentAgentSessionIdAtom) }
      const target = activeTab ?? fallbackTarget

      if (!target.sessionId) return

      store.set(activeViewAtom, 'conversations')

      if (target.type === 'agent' || target.type === 'preview') {
        const sessionId = target.sessionId
        store.set(appModeAtom, 'agent')
        store.set(currentAgentSessionIdAtom, sessionId)
        store.set(agentSessionDraftsAtom, (prev) => {
          const map = new Map(prev)
          const current = map.get(sessionId) ?? ''
          map.set(sessionId, current ? `${current}\n${trimmed}` : trimmed)
          return map
        })
        store.set(agentSessionDraftHtmlAtom, (prev) => {
          const map = new Map(prev)
          map.delete(sessionId)
          return map
        })
        window.dispatchEvent(new CustomEvent('copis:focus-input'))
        return
      }

    })
    return () => {
      cleanupPreview()
      cleanupClearPreview()
      cleanup()
    }
  }, [store])

  // ===== 菜单栏 → 打开 / 创建会话 =====

  useEffect(() => {
    const cleanupOpen = window.electronAPI.onTrayOpenAgentSession(async (data) => {
      try {
        const sessions = await window.electronAPI.listAgentSessions()
        const session = sessions.find((item) => item.id === data.sessionId)
        if (!session) return

        store.set(agentSessionsAtom, sessions)
        store.set(appModeAtom, 'agent')
        store.set(activeViewAtom, 'conversations')
        store.set(currentAgentSessionIdAtom, session.id)

        if (session.workspaceId) {
          store.set(currentAgentWorkspaceIdAtom, session.workspaceId)
          window.electronAPI.updateSettings({
            agentWorkspaceId: session.workspaceId,
          }).catch(console.error)
        }

        const currentTabs = store.get(tabsAtom)
        const result = openTab(currentTabs, {
          type: 'agent',
          sessionId: session.id,
          title: session.title || data.title,
        })
        store.set(tabsAtom, result.tabs)
        store.set(activeTabIdAtom, result.activeTabId)
      } catch (error) {
        console.error('[菜单栏] 打开 Agent 会话失败:', error)
      }
    })

    const cleanupCreate = window.electronAPI.onTrayCreateSession(async () => {
      store.set(appModeAtom, 'agent')
      store.set(activeViewAtom, 'conversations')
      await createAgent()
    })

    return () => {
      cleanupOpen()
      cleanupCreate()
    }
  }, [store, createAgent])
  return null
}
