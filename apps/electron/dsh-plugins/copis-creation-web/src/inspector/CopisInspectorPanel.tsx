import React, { useState, useMemo, useRef, useEffect, type ReactElement } from 'react'
import {
  FolderCode,
  MessageSquare,
  UsersRound,
  Plus,
  X,
  ChevronDown,
} from 'lucide-react'
import type { InspectorTab, InspectorTabKind } from './inspectorTypes'
import { FilesInspectorTab } from './FilesInspectorTab'
import { SideChatInspectorTab } from './SideChatInspectorTab'
import { TeamInspectorTab } from './TeamInspectorTab'

interface CopisInspectorPanelProps {
  sessionId?: string
  ctx?: any
  renderSlot?: (name: string, props: any) => ReactElement | null
  closeDetails?: () => void
}

const DEFAULT_TABS: InspectorTab[] = [
  {
    id: 'tab-files',
    kind: 'files',
    label: '工作区文件',
    closable: true,
  },
  {
    id: 'tab-side-chat',
    kind: 'side-chat',
    label: '侧边聊天',
    closable: true,
  },
  {
    id: 'tab-team',
    kind: 'team',
    label: '智能体团队',
    closable: true,
  },
]

export function resolveInspectorSessionCwd(
  ctx: any,
  explicitSessionId?: string,
): { cwd?: string; sessionId?: string } {
  const sessions = ctx?.sessions
  const listSnapshot = sessions?.list?.getSnapshot?.()
  const targetSessionId = explicitSessionId || listSnapshot?.current

  // 1. 优先尝试从 sessions.list.items 中获取目标 session 的 cwd
  if (targetSessionId && Array.isArray(listSnapshot?.items)) {
    const entry = listSnapshot.items.find(
      (item: any) => (item.sessionId || item.id) === targetSessionId,
    )
    if (entry?.cwd) {
      return { cwd: entry.cwd, sessionId: targetSessionId }
    }
  }

  // 兼容某些版本可能的 byId 结构
  if (targetSessionId && listSnapshot?.byId?.[targetSessionId]?.cwd) {
    return { cwd: listSnapshot.byId[targetSessionId].cwd, sessionId: targetSessionId }
  }

  // 2. 尝试从 workspaces 获取关联工作区或默认工作区
  const workspacesSnapshot = ctx?.workspaces?.getSnapshot?.()
  if (Array.isArray(workspacesSnapshot?.items) && workspacesSnapshot.items.length > 0) {
    if (targetSessionId) {
      const matchedWs = workspacesSnapshot.items.find(
        (ws: any) => Array.isArray(ws.sessionIds) && ws.sessionIds.includes(targetSessionId),
      )
      if (matchedWs?.path) {
        return { cwd: matchedWs.path, sessionId: targetSessionId }
      }
    }
    // 未匹配到具体会话时，使用列表首项工作区
    if (workspacesSnapshot.items[0]?.path) {
      return { cwd: workspacesSnapshot.items[0].path, sessionId: targetSessionId }
    }
  }

  return { cwd: undefined, sessionId: targetSessionId }
}

export function CopisInspectorPanel(props: CopisInspectorPanelProps): ReactElement {
  const [tabs, setTabs] = useState<InspectorTab[]>(DEFAULT_TABS)
  const [activeTabId, setActiveTabId] = useState<string>('tab-files')
  const [isAddMenuOpen, setIsAddMenuOpen] = useState(false)
  const addMenuRef = useRef<HTMLDivElement | null>(null)

  // 响应式工作区 CWD 状态与当前激活会话 ID
  const [sessionCwd, setSessionCwd] = useState<string | undefined>(() => {
    return resolveInspectorSessionCwd(props.ctx, props.sessionId).cwd
  })
  const [effectiveSessionId, setEffectiveSessionId] = useState<string | undefined>(() => {
    return resolveInspectorSessionCwd(props.ctx, props.sessionId).sessionId
  })

  // 响应式监听 sessions 与 workspaces 的变化，并支持 Copis 主进程工作区异步回退
  useEffect(() => {
    const syncState = () => {
      const resolved = resolveInspectorSessionCwd(props.ctx, props.sessionId)
      if (resolved.cwd) {
        setSessionCwd(resolved.cwd)
      }
      setEffectiveSessionId(resolved.sessionId)
    }

    syncState()

    const unsubs: (() => void)[] = []
    if (typeof props.ctx?.sessions?.list?.subscribe === 'function') {
      unsubs.push(props.ctx.sessions.list.subscribe(syncState))
    }
    if (typeof props.ctx?.workspaces?.subscribe === 'function') {
      unsubs.push(props.ctx.workspaces.subscribe(syncState))
    }

    // 兜底：若前述两源均未返回有效路径，异步向 Copis Bridge 查询活跃/默认工作区
    if (!sessionCwd && window.copisBridge?.getActiveWorkspacePath) {
      window.copisBridge
        .getActiveWorkspacePath()
        .then((bridgePath) => {
          if (bridgePath) {
            setSessionCwd((prev) => prev || bridgePath)
          }
        })
        .catch(() => {})
    }

    return () => {
      unsubs.forEach((fn) => fn())
    }
  }, [props.ctx, props.sessionId, sessionCwd])

  // 点击外部关闭加号菜单与 Esc 快捷键支持
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (isAddMenuOpen && addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setIsAddMenuOpen(false)
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isAddMenuOpen) {
          setIsAddMenuOpen(false)
          e.stopPropagation()
        } else {
          handleCloseDrawer()
        }
      }
    }

    window.addEventListener('mousedown', handleClickOutside)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('mousedown', handleClickOutside)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isAddMenuOpen])

  // 当前激活页签
  const activeTab = useMemo(() => {
    return tabs.find((t) => t.id === activeTabId) || tabs[0]
  }, [tabs, activeTabId])

  // 关闭页签
  const handleCloseTab = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation()
    if (tabs.length <= 1) return // 至少保留一个

    const targetIdx = tabs.findIndex((t) => t.id === tabId)
    const nextTabs = tabs.filter((t) => t.id !== tabId)
    setTabs(nextTabs)

    if (activeTabId === tabId) {
      // 激活邻近页签
      const newActiveIdx = Math.max(0, targetIdx - 1)
      setActiveTabId(nextTabs[newActiveIdx].id)
    }
  }

  // 添加页签
  const handleAddTab = (kind: InspectorTabKind) => {
    setIsAddMenuOpen(false)
    if (kind === 'files') {
      const existing = tabs.find((t) => t.kind === 'files')
      if (existing) {
        setActiveTabId(existing.id)
        return
      }
      const newTab: InspectorTab = {
        id: `tab-files-${Date.now()}`,
        kind: 'files',
        label: '工作区文件',
        closable: true,
      }
      setTabs((prev) => [...prev, newTab])
      setActiveTabId(newTab.id)
    } else if (kind === 'team') {
      const existing = tabs.find((t) => t.kind === 'team')
      if (existing) {
        setActiveTabId(existing.id)
        return
      }
      const newTab: InspectorTab = {
        id: `tab-team-${Date.now()}`,
        kind: 'team',
        label: '智能体团队',
        closable: true,
      }
      setTabs((prev) => [...prev, newTab])
      setActiveTabId(newTab.id)
    } else if (kind === 'side-chat') {
      const chatCount = tabs.filter((t) => t.kind === 'side-chat').length
      const newTab: InspectorTab = {
        id: `tab-side-chat-${Date.now()}`,
        kind: 'side-chat',
        label: chatCount > 0 ? `侧边聊天 ${chatCount + 1}` : '侧边聊天',
        closable: true,
      }
      setTabs((prev) => [...prev, newTab])
      setActiveTabId(newTab.id)
    }
  }

  // 更新页签标题（例如 side-chat 根据首条提问更新）
  const handleTitleChange = (tabId: string, newTitle: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, label: newTitle, title: newTitle } : t)),
    )
  }

  // 关闭整块抽屉
  const handleCloseDrawer = () => {
    if (props.closeDetails) {
      props.closeDetails()
    } else if (props.ctx?.layout?.closeDetails) {
      props.ctx.layout.closeDetails()
    }
  }

  // 获取 Tab 图标（激活状态下统一使用紫色高亮，未激活保持纯净灰阶）
  const getTabIcon = (kind: InspectorTabKind, isActive: boolean) => {
    const activePurple = '#a855f7'
    switch (kind) {
      case 'files':
        return <FolderCode size={13} style={{ color: isActive ? activePurple : '#94a3b8' }} />
      case 'side-chat':
        return <MessageSquare size={13} style={{ color: isActive ? activePurple : '#94a3b8' }} />
      case 'team':
        return <UsersRound size={13} style={{ color: isActive ? activePurple : '#cbd5e1' }} />
    }
  }

  return (
    <div className="copis-inspector-root" data-testid="copis-inspector-panel">
      {/* 顶部 Tab 导航条 */}
      <div className="copis-inspector-tabbar">
        {/* 左侧可滚动页签组 */}
        <div className="copis-inspector-tab-list" role="tablist">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTab?.id
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                data-active={isActive ? 'true' : 'false'}
                className="copis-inspector-tab-item"
                onClick={() => setActiveTabId(tab.id)}
                title={tab.title || tab.label}
              >
                <span className="copis-inspector-tab-icon">{getTabIcon(tab.kind, isActive)}</span>
                <span className="copis-inspector-tab-label">{tab.label}</span>
                {tabs.length > 1 && tab.closable && (
                  <span
                    className="copis-inspector-tab-close"
                    onClick={(e) => handleCloseTab(e, tab.id)}
                    title="关闭页签"
                    role="button"
                    aria-label={`关闭 ${tab.label}`}
                  >
                    <X size={11} />
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {/* 右侧操作区：加号添加菜单 + 关闭抽屉按钮 */}
        <div className="copis-inspector-tabbar-actions">
          {/* 加号按钮与下拉菜单 */}
          <div className="copis-inspector-add-wrapper" ref={addMenuRef}>
            <button
              type="button"
              className="copis-inspector-tool-icon-btn"
              onClick={() => setIsAddMenuOpen((prev) => !prev)}
              title="添加新页签"
              aria-label="添加新页签"
            >
              <Plus size={14} />
            </button>

            {isAddMenuOpen && (
              <div className="copis-inspector-add-dropdown" data-testid="copis-inspector-add-dropdown">
                <button
                  type="button"
                  className="copis-inspector-dropdown-item"
                  onClick={() => handleAddTab('side-chat')}
                >
                  <MessageSquare size={13} style={{ color: '#94a3b8' }} />
                  <span>新建侧边聊天</span>
                </button>
                <button
                  type="button"
                  className="copis-inspector-dropdown-item"
                  onClick={() => handleAddTab('files')}
                >
                  <FolderCode size={13} style={{ color: '#94a3b8' }} />
                  <span>工作区文件</span>
                </button>
                <button
                  type="button"
                  className="copis-inspector-dropdown-item"
                  onClick={() => handleAddTab('team')}
                >
                  <UsersRound size={13} style={{ color: '#cbd5e1' }} />
                  <span>智能体团队</span>
                </button>
              </div>
            )}
          </div>

          {/* 抽屉总关闭按钮 */}
          <button
            type="button"
            className="copis-inspector-tool-icon-btn"
            onClick={handleCloseDrawer}
            title="关闭检查器抽屉"
            aria-label="关闭面板"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* 面板内容容器 */}
      <div className="copis-inspector-content">
        {activeTab?.kind === 'files' && (
          <FilesInspectorTab
            sessionCwd={sessionCwd}
            sessionId={effectiveSessionId || props.sessionId}
          />
        )}

        {activeTab?.kind === 'side-chat' && (
          <SideChatInspectorTab
            tabId={activeTab.id}
            sessionId={effectiveSessionId || props.sessionId}
            sessionCwd={sessionCwd}
            onTitleChange={handleTitleChange}
          />
        )}

        {activeTab?.kind === 'team' && (
          <TeamInspectorTab
            sessionId={effectiveSessionId || props.sessionId}
            sessionCwd={sessionCwd}
          />
        )}
      </div>
    </div>
  )
}
