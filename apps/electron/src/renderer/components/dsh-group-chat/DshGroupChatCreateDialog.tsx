/**
 * 新建 DSH 群聊与协作工作台弹窗
 * 
 * 动态加载 DSH 创造模式本地工作区智能体（Creation Workspace Agents）供用户挑选入群，
 * 并支持为每个选中的工作区 Agent 设定 Leader 协调者与专属群岗位职责。
 * 严格遵守零交叉原则，仅消费创造模式工作区，不调用 Agent 模式接口与状态。
 */

import React, { useEffect, useState } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  UsersRound,
  Bot,
  Crown,
  Search,
  Check,
  AlertCircle,
  Loader2,
  FolderGit2,
} from 'lucide-react'
import {
  dshCreateGroupDialogOpenAtom,
  dshGroupListAtom,
  dshActiveGroupIdAtom,
} from '@/atoms/dsh-group-chat-atoms'
import type { DshConversationKind, DshCreationWorkspace } from '@copis/shared'

export function DshGroupChatCreateDialog(): React.ReactElement {
  const [open, setOpen] = useAtom(dshCreateGroupDialogOpenAtom)
  const setGroupList = useSetAtom(dshGroupListAtom)
  const setActiveGroupId = useSetAtom(dshActiveGroupIdAtom)
  const [workspaces, setWorkspaces] = useState<DshCreationWorkspace[]>([])

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [kind] = useState<DshConversationKind>('group')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([])
  const [leaderId, setLeaderId] = useState<string>('')
  const [responsibilities, setResponsibilities] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [fetchingWorkspaces, setFetchingWorkspaces] = useState(false)

  // 当弹窗打开时，主动从创造模式加载工作区智能体
  useEffect(() => {
    if (!open) return
    let mounted = true

    const loadWorkspaces = async () => {
      setFetchingWorkspaces(true)
      try {
        const list = await window.electronAPI.dshGroupChat.listCreationWorkspaces()
        if (mounted && Array.isArray(list)) {
          setWorkspaces(list)
        }
      } catch (err) {
        console.error('[DshGroupChatCreateDialog] 加载创造模式工作区 Agent 失败:', err)
      } finally {
        if (mounted) setFetchingWorkspaces(false)
      }
    }

    void loadWorkspaces()
    return () => {
      mounted = false
    }
  }, [open])

  // 当工作区列表加载就绪且尚未选择时，默认选中前两个工作区并设定第一个为 Leader
  useEffect(() => {
    if (open && workspaces.length > 0 && selectedAgentIds.length === 0) {
      const defaultSelected = workspaces.slice(0, Math.min(2, workspaces.length)).map((w) => w.id)
      setSelectedAgentIds(defaultSelected)
      if (defaultSelected[0]) {
        setLeaderId(defaultSelected[0])
      }
      const initialResp: Record<string, string> = {}
      for (const ws of workspaces) {
        initialResp[ws.id] = `负责「${ws.name}」专业领域方案设计与业务协同`
      }
      setResponsibilities(initialResp)
    }
  }, [open, workspaces, selectedAgentIds.length])

  // 切换工作区选中状态
  const handleToggleWorkspace = (ws: DshCreationWorkspace) => {
    setSelectedAgentIds((prev) => {
      const isSelected = prev.includes(ws.id)
      let next: string[]
      if (isSelected) {
        next = prev.filter((id) => id !== ws.id)
        if (leaderId === ws.id) {
          setLeaderId(next[0] || '')
        }
      } else {
        next = [...prev, ws.id]
        if (!leaderId) {
          setLeaderId(ws.id)
        }
      }
      return next
    })
  }

  // 提交创建群聊
  const handleCreate = async () => {
    if (!name.trim()) return
    setLoading(true)

    try {
      const agentsToAttach = workspaces
        .filter((ws) => selectedAgentIds.includes(ws.id))
        .map((ws) => ({
          agentId: ws.id,
          name: ws.name,
          isLeader: ws.id === leaderId,
          responsibility:
            responsibilities[ws.id] || `负责「${ws.name}」领域相关执行与交付`,
        }))

      const newGroup = await window.electronAPI.dshGroupChat.createGroup({
        name: name.trim(),
        description: description.trim() || undefined,
        conversationKind: kind,
        agents: agentsToAttach,
      })

      // 刷新列表并选中
      const list = await window.electronAPI.dshGroupChat.listGroups()
      setGroupList(list)
      setActiveGroupId(newGroup.id)
      setOpen(false)
      setName('')
      setDescription('')
    } catch (err) {
      console.error('[DshGroupChatCreateDialog] 创建失败:', err)
    } finally {
      setLoading(false)
    }
  }

  const filteredWorkspaces = workspaces.filter((ws) => {
    if (!searchQuery.trim()) return true
    const q = searchQuery.toLowerCase()
    return (
      ws.name.toLowerCase().includes(q) ||
      (ws.path && ws.path.toLowerCase().includes(q)) ||
      (ws.description && ws.description.toLowerCase().includes(q))
    )
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-[540px] max-h-[85vh] flex flex-col border border-border/60 shadow-2xl bg-card p-0 gap-0 overflow-hidden">
        <DialogHeader className="p-4 pb-3 border-b border-border/50">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0">
              <UsersRound className="w-4 h-4" />
            </div>
            <div>
              <DialogTitle className="text-sm font-semibold">发起创造模式多智能体协同群聊</DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                挑选 DSH 创造模式工作区智能体加入群组，指定协调者（Leader）与分工职责。
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* 群聊名称 */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">群组/协作名称</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：基金策略与投资协同攻坚群"
              className="h-8 text-xs bg-muted/20"
              autoFocus
            />
          </div>

          {/* 描述说明 */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">协作目标与说明 (可选)</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="简要描述本次多智能体协作的主要目标、预期交付物与协同重点"
              rows={2}
              className="text-xs resize-none bg-muted/20"
            />
          </div>

          {/* 挑选工作区 Agent */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-foreground flex items-center gap-1.5">
                <Bot className="w-3.5 h-3.5 text-primary" />
                <span>选择加入群组的创造模式工作区 Agent</span>
              </label>
              <span className="text-[11px] text-muted-foreground">
                已选 {selectedAgentIds.length} 个智能体
              </span>
            </div>

            {/* 搜索框 */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-2 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索创造模式本地工作区..."
                className="h-7 text-xs pl-8 pr-2 bg-muted/30 border-border/50"
              />
            </div>

            {/* 工作区 Agent 列表 */}
            <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1">
              {fetchingWorkspaces ? (
                <div className="p-6 text-center text-xs text-muted-foreground flex items-center justify-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-primary" />
                  <span>正在获取创造模式本地工作区智能体...</span>
                </div>
              ) : filteredWorkspaces.length === 0 ? (
                <div className="p-6 text-center text-xs text-muted-foreground border border-dashed rounded-xl space-y-1.5">
                  <AlertCircle className="w-6 h-6 text-muted-foreground/60 mx-auto" />
                  <p className="font-medium text-foreground/80">未找到匹配的创造模式工作区</p>
                  <p className="text-[11px]">请在创造模式（DSH）中打开或创建项目目录，即可作为智能体加入协作</p>
                </div>
              ) : (
                filteredWorkspaces.map((ws) => {
                  const isSelected = selectedAgentIds.includes(ws.id)
                  const isCurrentLeader = leaderId === ws.id

                  return (
                    <div
                      key={ws.id}
                      onClick={() => handleToggleWorkspace(ws)}
                      className={`p-2.5 rounded-xl border text-xs cursor-pointer transition-all space-y-2 ${
                        isSelected
                          ? 'border-primary/50 bg-primary/5 shadow-xs'
                          : 'border-border/60 hover:bg-muted/40 hover:border-border'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2.5 min-w-0">
                          {/* 选中 Checkbox / 头像 */}
                          <div
                            className={`w-6 h-6 rounded-md flex items-center justify-center shrink-0 transition-colors ${
                              isSelected
                                ? 'bg-primary text-primary-foreground'
                                : 'bg-muted border border-border/80 text-muted-foreground'
                            }`}
                          >
                            {isSelected ? <Check className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
                          </div>

                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="font-semibold text-foreground truncate">{ws.name}</span>
                              <span className="px-1.5 py-0.2 rounded bg-muted text-muted-foreground text-[10px] font-medium flex items-center gap-1 shrink-0">
                                <FolderGit2 className="w-2.5 h-2.5" />
                                创造工作区
                              </span>
                              {isCurrentLeader && (
                                <span className="px-1.5 py-0.2 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[10px] font-semibold flex items-center gap-0.5 shrink-0">
                                  <Crown className="w-2.5 h-2.5" />
                                  Leader 协调者
                                </span>
                              )}
                            </div>
                            <p className="text-[10px] text-muted-foreground font-mono truncate mt-0.5">
                              {ws.path || ws.id}
                            </p>
                          </div>
                        </div>

                        {isSelected && (
                          <Button
                            variant={isCurrentLeader ? 'secondary' : 'ghost'}
                            size="sm"
                            className="h-6 px-2 text-[10px] shrink-0"
                            onClick={(e) => {
                              e.stopPropagation()
                              setLeaderId(ws.id)
                            }}
                          >
                            {isCurrentLeader ? '协调主控' : '设为主控'}
                          </Button>
                        )}
                      </div>

                      {/* 岗位职责编辑框（选中时展开） */}
                      {isSelected && (
                        <div className="pt-1.5 border-t border-border/40" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
                            <span>群内岗位职责分工 (Responsibility)：</span>
                          </div>
                          <Input
                            value={responsibilities[ws.id] || ''}
                            onChange={(e) =>
                              setResponsibilities((prev) => ({
                                ...prev,
                                [ws.id]: e.target.value,
                              }))
                            }
                            placeholder={`例如：负责「${ws.name}」领域的代码开发与业务方案分析`}
                            className="h-6 text-[11px] bg-background/80"
                          />
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </div>

        <DialogFooter className="p-3 border-t border-border/50 gap-2 bg-muted/10 shrink-0">
          <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={loading}>
            取消
          </Button>
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={!name.trim() || selectedAgentIds.length === 0 || loading}
          >
            {loading ? '创建中...' : `创建协作群聊 (${selectedAgentIds.length} Agent)`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
