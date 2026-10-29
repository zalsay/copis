/**
 * DSH 群聊与协作会话侧边栏列表（WorkBuddy 视觉重构版）
 * 
 * 采用 WorkBuddy 现代深邃极简美学：
 * - 纯净曜石黑背景（#111215）、极细边框与柔和悬浮光感
 * - 顶部品牌标题、发现应用胶囊与「+ 新建协作群聊」常驻卡片
 * - 分区展示：置顶群聊、任务/群聊协作、空间（工作区智能体）
 * - 底部集成用户档案（头像、姓名、通知红点与快捷入口）
 */

import React, { useEffect, useState } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  Search,
  Plus,
  UsersRound,
  Bot,
  Pin,
  MessageSquare,
  Trash2,
  Folder,
  SlidersHorizontal,
  Compass,
  Bell,
  Sparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  dshGroupListAtom,
  dshGroupListLoadingAtom,
  dshActiveGroupIdAtom,
  dshCreateGroupDialogOpenAtom,
} from '@/atoms/dsh-group-chat-atoms'
import { userProfileAtom } from '@/atoms/user-profile'
import type { DshCreationWorkspace, DshGroupChatSummary } from '@copis/shared'

export function DshGroupChatSidebar(): React.ReactElement {
  const [groups, setGroups] = useAtom(dshGroupListAtom)
  const [loading, setLoading] = useAtom(dshGroupListLoadingAtom)
  const [activeGroupId, setActiveGroupId] = useAtom(dshActiveGroupIdAtom)
  const setCreateDialogOpen = useSetAtom(dshCreateGroupDialogOpenAtom)
  const userProfile = useAtomValue(userProfileAtom)

  const [searchQuery, setSearchQuery] = useState('')
  const [groupToDelete, setGroupToDelete] = useState<DshGroupChatSummary | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [workspaces, setWorkspaces] = useState<DshCreationWorkspace[]>([])

  // 初始化加载群列表
  useEffect(() => {
    let mounted = true
    const load = async () => {
      setLoading(true)
      try {
        const list = await window.electronAPI.dshGroupChat.listGroups()
        if (mounted) {
          setGroups(list)
          if (!activeGroupId && list.length > 0 && list[0]) {
            setActiveGroupId(list[0].id)
          }
        }
      } catch (err) {
        console.error('[DshGroupChatSidebar] 加载群列表失败:', err)
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => {
      mounted = false
    }
  }, [setGroups, setLoading, activeGroupId, setActiveGroupId])

  // 加载工作区列表
  useEffect(() => {
    let mounted = true
    window.electronAPI.dshGroupChat
      .listCreationWorkspaces()
      .then((ws) => {
        if (mounted && Array.isArray(ws)) setWorkspaces(ws)
      })
      .catch(() => {})
    return () => {
      mounted = false
    }
  }, [])

  // 监听实时事件流
  useEffect(() => {
    const unsubscribe = window.electronAPI.dshGroupChat.onEventStream((event) => {
      if (event.type === 'group_deleted') {
        setGroups((prev) => prev.filter((g) => g.id !== event.groupId))
        setActiveGroupId((prevActive) => {
          if (prevActive === event.groupId) {
            const remaining = groups.filter((g) => g.id !== event.groupId)
            return remaining[0]?.id || ''
          }
          return prevActive
        })
      } else if (event.type === 'group_updated') {
        setGroups((prev) => {
          const index = prev.findIndex((g) => g.id === event.groupId)
          if (index >= 0) {
            const next = [...prev]
            next[index] = {
              ...next[index]!,
              name: event.group.name,
              isTopPinned: event.group.isTopPinned,
              agentCount: event.group.agents.length,
              updatedAt: event.group.updatedAt,
            }
            return next.sort((a, b) => (b.isTopPinned ? 1 : 0) - (a.isTopPinned ? 1 : 0))
          }
          return prev
        })
      }
    })

    return () => {
      unsubscribe()
    }
  }, [groups, setGroups, setActiveGroupId])

  // 过滤群列表
  const filteredGroups = groups.filter((g) => {
    if (!searchQuery.trim()) return true
    const query = searchQuery.toLowerCase()
    return (
      g.name.toLowerCase().includes(query) ||
      (g.lastMessage?.text && g.lastMessage.text.toLowerCase().includes(query))
    )
  })

  const pinnedGroups = filteredGroups.filter((g) => g.isTopPinned)
  const normalGroups = filteredGroups.filter((g) => !g.isTopPinned)

  // 格式化类似 WorkBuddy 的时间文案 (刚刚 / 18分钟前 / 2天前 / 3月16日)
  const formatWorkBuddyDate = (isoString?: string) => {
    if (!isoString) return ''
    const date = new Date(isoString)
    const now = new Date()
    const diff = Math.floor((now.getTime() - date.getTime()) / 1000)

    if (diff < 60) return '刚刚'
    if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`
    if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`
    if (diff < 86400 * 2) return '昨天'
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}天前`
    return `${date.getMonth() + 1}月${date.getDate()}日`
  }

  // 切换置顶
  const handleTogglePin = async (group: DshGroupChatSummary, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      const updated = await window.electronAPI.dshGroupChat.updateGroup({
        groupId: group.id,
        isTopPinned: !group.isTopPinned,
      })
      if (updated) {
        setGroups((prev) =>
          prev
            .map((g) => (g.id === group.id ? { ...g, isTopPinned: updated.isTopPinned } : g))
            .sort((a, b) => (b.isTopPinned ? 1 : 0) - (a.isTopPinned ? 1 : 0)),
        )
      }
    } catch (err) {
      console.error('[DshGroupChatSidebar] 切换置顶失败:', err)
    }
  }

  // 确认移除群聊
  const handleConfirmDelete = async () => {
    if (!groupToDelete) return
    setDeleting(true)
    try {
      const success = await window.electronAPI.dshGroupChat.deleteGroup(groupToDelete.id)
      if (success) {
        const deletedId = groupToDelete.id
        setGroups((prev) => prev.filter((g) => g.id !== deletedId))
        if (activeGroupId === deletedId) {
          const remaining = groups.filter((g) => g.id !== deletedId)
          setActiveGroupId(remaining[0]?.id || '')
        }
      }
    } catch (err) {
      console.error('[DshGroupChatSidebar] 移除群聊失败:', err)
    } finally {
      setDeleting(false)
      setGroupToDelete(null)
    }
  }

  // 渲染单项群聊卡片（WorkBuddy 极简胶囊）
  const renderGroupItem = (group: DshGroupChatSummary) => {
    const isActive = group.id === activeGroupId
    const dateStr = formatWorkBuddyDate(group.activityAt || group.updatedAt)

    return (
      <div
        key={group.id}
        onClick={() => setActiveGroupId(group.id)}
        className={`group relative flex items-center justify-between px-2.5 py-2 rounded-lg cursor-pointer transition-all duration-120 ${
          isActive
            ? 'bg-white/[0.12] text-white font-medium shadow-xs border border-white/[0.08]'
            : 'text-zinc-300 hover:text-white hover:bg-white/[0.05] border border-transparent'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1 pr-1.5">
          {/* 活动状态点 (绿点) */}
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 transition-opacity ${
              isActive ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]' : 'bg-zinc-600 group-hover:bg-zinc-500'
            }`}
          />

          <span className="text-[13px] font-normal truncate tracking-tight">{group.name}</span>

          {group.agentCount > 0 && (
            <span className="text-[10px] text-zinc-400/80 px-1 py-0.2 rounded bg-white/[0.05] shrink-0 font-mono">
              {group.agentCount}
            </span>
          )}
        </div>

        {/* 右侧日期及 Hover 快捷操作按钮 */}
        <div className="h-5 flex items-center justify-end shrink-0">
          <span className="text-[11px] text-zinc-500 font-mono group-hover:hidden transition-opacity tabular-nums">
            {dateStr}
          </span>

          <div
            className="hidden group-hover:flex items-center gap-0.5"
            onClick={(e) => e.stopPropagation()}
          >
            <Button
              variant="ghost"
              size="sm"
              type="button"
              className={`h-5 w-5 p-0 rounded transition-colors ${
                group.isTopPinned
                  ? 'text-zinc-200 hover:text-white hover:bg-white/15'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/10'
              }`}
              onClick={(e) => handleTogglePin(group, e)}
              title={group.isTopPinned ? '取消置顶' : '置顶'}
            >
              <Pin className="w-3 h-3" />
            </Button>

            <Button
              variant="ghost"
              size="sm"
              type="button"
              className="h-5 w-5 p-0 rounded text-zinc-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setGroupToDelete(group)
              }}
              title="移除群聊"
            >
              <Trash2 className="w-3 h-3" />
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="w-64 border-r border-white/[0.06] flex flex-col h-full bg-[#111215] text-zinc-200 select-none">
      {/* 顶部 Header 与 发现应用 / 搜索 */}
      <div className="p-3 pb-2 flex flex-col gap-2.5">
        <div className="flex items-center justify-between pt-1">
          <div className="flex items-baseline gap-1.5">
            <span className="text-sm font-semibold text-white tracking-wide">Copis 协同</span>
            <span className="text-[10px] text-zinc-500 font-mono">v0.0.84</span>
          </div>

          {/* 发现应用胶囊按钮 */}
          <button
            type="button"
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] text-zinc-300 hover:text-white bg-white/[0.05] hover:bg-white/[0.09] border border-white/[0.08] transition-all cursor-pointer"
            onClick={() => setCreateDialogOpen(true)}
            title="发现或创建协同模式"
          >
            <Compass className="w-3 h-3 text-zinc-300" />
            <span>发现应用</span>
          </button>
        </div>

        {/* WorkBuddy 风格「+ 新建任务 / 群聊」主操作卡片 */}
        <button
          type="button"
          onClick={() => setCreateDialogOpen(true)}
          className="w-full h-9 rounded-lg bg-white/[0.05] hover:bg-white/[0.09] border border-white/[0.08] hover:border-white/[0.14] text-white text-[13px] font-medium flex items-center justify-start px-3 gap-2 shadow-xs transition-all cursor-pointer group"
        >
          <div className="w-4 h-4 rounded-full bg-white/10 flex items-center justify-center text-white/90 group-hover:scale-105 transition-transform">
            <Plus className="w-3 h-3" />
          </div>
          <span>新建协作群聊</span>
        </button>

        {/* 极简搜索条 */}
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-2 text-zinc-500" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索协作群聊与历史..."
            className="h-7 text-xs pl-8 pr-2 bg-white/[0.03] border-white/[0.06] hover:border-white/[0.1] focus-visible:ring-1 focus-visible:ring-white/20 focus-visible:border-white/20 rounded-lg text-zinc-200 placeholder:text-zinc-600"
          />
        </div>
      </div>

      {/* 群聊与空间列表流 */}
      <div className="flex-1 overflow-y-auto px-2 py-1 space-y-4 scrollbar-thin">
        {loading && groups.length === 0 ? (
          <div className="p-6 text-center text-xs text-zinc-500">正在同步协作列表...</div>
        ) : filteredGroups.length === 0 ? (
          <div className="p-8 text-center text-xs text-zinc-500 flex flex-col items-center gap-2">
            <MessageSquare className="w-8 h-8 opacity-20 text-zinc-400" />
            <p>暂无群聊记录，点击上方新建发起</p>
          </div>
        ) : (
          <>
            {/* 置顶分区 */}
            {pinnedGroups.length > 0 && (
              <div className="space-y-0.5">
                <div className="px-2 py-1 text-[11px] font-medium text-zinc-500 uppercase tracking-wider flex items-center justify-between">
                  <span>置顶 ({pinnedGroups.length})</span>
                </div>
                {pinnedGroups.map(renderGroupItem)}
              </div>
            )}

            {/* 任务 / 普通群聊分区 */}
            {normalGroups.length > 0 && (
              <div className="space-y-0.5">
                <div className="px-2 py-1 text-[11px] font-medium text-zinc-500 uppercase tracking-wider flex items-center justify-between">
                  <span>任务 ({normalGroups.length})</span>
                </div>
                {normalGroups.map(renderGroupItem)}
              </div>
            )}

            {/* 空间（工作区智能体）分区 */}
            {workspaces.length > 0 && (
              <div className="space-y-0.5 pt-1 border-t border-white/[0.04]">
                <div className="px-2 py-1 text-[11px] font-medium text-zinc-500 uppercase tracking-wider flex items-center justify-between">
                  <span>空间 ({workspaces.length})</span>
                </div>
                {workspaces.map((ws) => (
                  <div
                    key={ws.id}
                    className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04] transition-colors cursor-pointer text-xs"
                    title={ws.path || ws.name}
                  >
                    <Folder className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                    <span className="truncate">{ws.name}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* 底部用户档案（WorkBuddy Meetlife-张颖 风格） */}
      <div className="p-2.5 border-t border-white/[0.06] bg-[#0e0f12] flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-full bg-white/[0.12] border border-white/[0.15] flex items-center justify-center text-zinc-200 font-semibold text-xs shrink-0">
            {userProfile?.userName?.charAt(0) || 'M'}
          </div>
          <div className="flex flex-col min-w-0">
            <span className="text-xs font-medium text-zinc-200 truncate">
              {userProfile?.userName || 'Meetlife-张颖'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0 text-zinc-500">
          <div className="relative">
            <Bell className="w-3.5 h-3.5 text-zinc-400 hover:text-zinc-200 cursor-pointer" />
            <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-rose-500" />
          </div>
        </div>
      </div>

      {/* 移除群聊二次确认弹窗 */}
      <ConfirmDialog
        open={Boolean(groupToDelete)}
        onOpenChange={(open) => {
          if (!open && !deleting) setGroupToDelete(null)
        }}
        title="移除协作群聊"
        description={`确定要移除「${groupToDelete?.name}」吗？移除后群聊协作记录与看板任务将被清理。`}
        confirmLabel="确认移除"
        cancelLabel="取消"
        variant="destructive"
        loading={deleting}
        onConfirm={handleConfirmDelete}
      />
    </div>
  )
}
