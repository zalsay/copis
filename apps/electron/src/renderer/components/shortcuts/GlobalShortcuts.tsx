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
import { toast } from 'sonner'
import { useAtomValue, useSetAtom, useAtom, useStore } from 'jotai'
import { appModeAtom } from '@/atoms/app-mode'
import { searchDialogOpenAtom } from '@/atoms/search-atoms'
import {
  tabsAtom,
  activeTabIdAtom,
  sidebarCollapsedAtom,
} from '@/atoms/tab-atoms'
import { shortcutOverridesAtom, sendWithCmdEnterAtom } from '@/atoms/shortcut-atoms'
import { shortcutGuideOpenAtom } from '@/atoms/shortcut-guide'
import {
  agentSessionDraftHtmlAtom,
  agentSessionDraftsAtom,
  currentAgentSessionIdAtom,
} from '@/atoms/agent-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { requestDshNewSessionAtom, showDshConversationAtom } from '@/atoms/dsh-navigation'
import { useShortcut } from '@/hooks/useShortcut'
import { useCloseTab } from '@/hooks/useCloseTab'
import { workingSettingsOpenAtom } from '@/atoms/working-atoms'
import {
  initShortcutRegistry,
  updateShortcutOverrides,
} from '@/lib/shortcut-registry'
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
  const [workingSettingsOpen, setWorkingSettingsOpen] = useAtom(workingSettingsOpenAtom)
  const [searchOpen, setSearchOpen] = useAtom(searchDialogOpenAtom)
  const [shortcutGuideOpen, setShortcutGuideOpen] = useAtom(shortcutGuideOpenAtom)
  const [sidebarCollapsed, setSidebarCollapsed] = useAtom(sidebarCollapsedAtom)
  const setShortcutOverrides = useSetAtom(shortcutOverridesAtom)
  const shortcutOverrides = useAtomValue(shortcutOverridesAtom)
  const setSendWithCmdEnter = useSetAtom(sendWithCmdEnterAtom)
  const store = useStore()
  const requestDshNewSession = useCallback(() => {
    store.set(showDshConversationAtom)
    store.set(requestDshNewSessionAtom)
  }, [store])

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
    if (workingSettingsOpen) {
      setWorkingSettingsOpen(false)
      return
    }
    if (searchOpen) {
      setSearchOpen(false)
      return
    }

    if (!activeTabId) return
    requestClose(activeTabId)
  }, [shortcutGuideOpen, setShortcutGuideOpen, workingSettingsOpen, setWorkingSettingsOpen, searchOpen, setSearchOpen, activeTabId, requestClose])

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
    useCallback(() => setWorkingSettingsOpen(true), [setWorkingSettingsOpen]),
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

  // 宿主获得焦点时将新建会话交给 DSH。
  useShortcut('new-session', requestDshNewSession)

  // Cmd+B → 切换侧边栏
  useShortcut(
    'toggle-sidebar',
    useCallback(
      () => setSidebarCollapsed(!sidebarCollapsed),
      [sidebarCollapsed, setSidebarCollapsed],
    ),
  )

  // Cmd+K → 压缩 Agent 上下文（通过 CustomEvent 分发）
  useShortcut(
    'clear-context',
    useCallback(() => {
      window.dispatchEvent(new CustomEvent('copis:clear-context'))
    }, []),
  )

  // Cmd+L → 聚焦 Agent 输入框（通过 CustomEvent 分发）
  useShortcut(
    'focus-input',
    useCallback(() => {
      window.dispatchEvent(new CustomEvent('copis:focus-input'))
    }, []),
  )

  // Cmd+Shift+Backspace → 停止 Agent 生成（通过 CustomEvent 分发，流式运行时生效）
  useShortcut(
    'stop-generation',
    useCallback(() => {
      window.dispatchEvent(new CustomEvent('copis:stop-generation'))
    }, []),
  )

  // 快速任务仍属于旧 Agent 执行路径，不能静默创建不可见的旧会话。
  useEffect(() => window.electronAPI.onQuickTaskOpenSession(() => {
    toast.error('快速任务暂不支持创造模式，请在会话中创建任务')
  }), [])

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

      if (target.type === 'agent' || target.type === 'preview' || target.type === 'chrome-desktop') {
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
    // 旧会话 ID 不属于 DSH；忽略旧托盘导航以免误打开或创建会话。
    const cleanupOpen = window.electronAPI.onTrayOpenAgentSession(() => {})
    const cleanupCreate = window.electronAPI.onTrayCreateSession(requestDshNewSession)

    return () => {
      cleanupOpen()
      cleanupCreate()
    }
  }, [requestDshNewSession])
  return null
}
