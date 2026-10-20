/**
 * DSH 群聊与协作会话侧边栏列表
 * 
 * 展示所有本地协作群聊列表，支持群聊搜索、置顶、移除群聊与新建协作入口。
 */

import React, { useEffect, useState } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import {
  Search,
  Plus,
  UsersRound,
  Bot,
  Pin,
  MessageSquare,
  Trash2,
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
import type { DshGroupChatSummary } from '@copis/shared'

export function DshGroupChatSidebar(): React.ReactElement {
  const [groups, setGroups] = useAtom(dshGroupListAtom)
  const [loading, setLoading] = useAtom(dshGroupListLoadingAtom)
  const [activeGroupId, setActiveGroupId] = useAtom(dshActiveGroupIdAtom)
  const setCreateDialogOpen = useSetAtom(dshCreateGroupDialogOpenAtom)
  const [searchQuery, setSearchQuery] = useState('')
  const [groupToDelete, setGroupToDelete] = useState<DshGroupChatSummary | null>(null)
  const [deleting, setDeleting] = useState(false)

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

  // 监听实时事件流（如其他窗口或后台删除、更新群聊）
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

  // 格式化相对时间
  const formatRelativeTime = (isoString?: string) => {
    if (!isoString) return ''
    const date = new Date(isoString)
    const now = new Date()
    const diff = Math.floor((now.getTime() - date.getTime()) / 1000)

    if (diff < 60) return '刚刚'
    if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`
    if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`
    return `${date.getMonth() + 1}/${date.getDate()}`
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
            .sort((a, b) => (b.isTopPinned ? 1 : 0) - (a.isTopPinned ? 1 : 0))
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

  return (
    <div className="w-64 border-r border-border/60 flex flex-col h-full bg-muted/20 select-none">
      {/* 顶部搜索与操作栏 */}
      <div className="p-3 border-b border-border/50 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <UsersRound className="w-4 h-4 text-primary" />
            <span>群聊协作</span>
            <span className="text-[11px] font-normal text-muted-foreground">({groups.length})</span>
          </div>

          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground"
            onClick={() => setCreateDialogOpen(true)}
            title="新建协作群聊"
          >
            <Plus className="w-4 h-4" />
          </Button>
        </div>

        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-2 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索协作群聊与历史..."
            className="h-7 text-xs pl-8 pr-2 bg-background/50 border-border/50 focus-visible:ring-1"
          />
        </div>
      </div>

      {/* 列表流 */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {loading && groups.length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground">加载群聊列表中...</div>
        ) : filteredGroups.length === 0 ? (
          <div className="p-6 text-center text-xs text-muted-foreground flex flex-col items-center gap-2">
            <MessageSquare className="w-8 h-8 opacity-40" />
            <p>暂无群聊，点击上方加号发起协同</p>
          </div>
        ) : (
          filteredGroups.map((group) => {
            const isActive = group.id === activeGroupId

            return (
              <div
                key={group.id}
                onClick={() => setActiveGroupId(group.id)}
                className={`group relative flex items-start gap-2.5 p-2.5 rounded-xl cursor-pointer transition-all ${
                  isActive
                    ? 'bg-primary/10 border border-primary/30 shadow-xs'
                    : 'hover:bg-muted/60 border border-transparent'
                }`}
              >
                {/* 头像 */}
                <div className="relative shrink-0">
                  <div
                    className={`w-9 h-9 rounded-lg flex items-center justify-center font-medium text-xs ${
                      isActive ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'
                    }`}
                  >
                    {group.conversationKind === 'direct' ? (
                      <Bot className="w-4 h-4" />
                    ) : (
                      <UsersRound className="w-4 h-4" />
                    )}
                  </div>
                  {group.unreadCount > 0 && (
                    <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
                      {group.unreadCount > 99 ? '99+' : group.unreadCount}
                    </span>
                  )}
                </div>

                {/* 详情 */}
                <div className="flex-1 min-w-0">
                  <div className="h-5 flex items-center justify-between gap-1">
                    <span className="text-xs font-semibold text-foreground truncate min-w-0 flex-1 leading-none">
                      {group.name}
                    </span>
                    
                    {/* 时间（默认）与 Hover 快捷操作按钮组（高度恒定保持 h-5，绝不撑高卡片） */}
                    <div className="h-5 flex items-center justify-end shrink-0">
                      <span className="text-[10px] text-muted-foreground group-hover:hidden transition-opacity leading-none">
                        {formatRelativeTime(group.activityAt || group.updatedAt)}
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
                              ? 'text-amber-500 hover:text-amber-600 hover:bg-amber-500/10'
                              : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                          }`}
                          onClick={(e) => handleTogglePin(group, e)}
                          title={group.isTopPinned ? '取消置顶' : '置顶群聊'}
                        >
                          <Pin className="w-3 h-3" />
                        </Button>

                        <Button
                          variant="ghost"
                          size="sm"
                          type="button"
                          className="h-5 w-5 p-0 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            setGroupToDelete(group)
                          }}
                          title="移除协作群聊"
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    </div>
                  </div>

                  <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                    {group.lastMessage ? (
                      <span>
                        <span className="text-foreground/70">{group.lastMessage.authorName}: </span>
                        {group.lastMessage.text}
                      </span>
                    ) : (
                      '暂无消息'
                    )}
                  </p>

                  <div className="flex items-center gap-2 mt-1.5 text-[10px] text-muted-foreground/80">
                    <span className="flex items-center gap-0.5">
                      <Bot className="w-3 h-3" />
                      {group.agentCount} 个 Agent
                    </span>
                    {group.isTopPinned && (
                      <span className="flex items-center gap-0.5 text-amber-500 font-medium">
                        <Pin className="w-2.5 h-2.5" />
                        置顶
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )
          })
        )}
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
