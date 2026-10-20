/**
 * DSH 群任务看板抽屉组件（TasksKanban & Panel）
 */

import React, { useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import {
  Kanban,
  Plus,
  CheckCircle2,
  Circle,
  Clock,
  AlertTriangle,
  ChevronRight,
  GitFork,
  X,
  Layers,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  dshActiveGroupIdAtom,
  dshActiveTaskBoardAtom,
  dshTasksMapAtom,
  dshActiveDrawerAtom,
} from '@/atoms/dsh-group-chat-atoms'
import type { DshGroupChatTask, DshGroupTaskStatus } from '@copis/shared'

const STATUS_COLUMNS: Array<{ status: DshGroupTaskStatus; label: string; icon: any; color: string }> = [
  { status: 'todo', label: '待处理', icon: Circle, color: 'text-slate-500' },
  { status: 'in_progress', label: '执行中', icon: Clock, color: 'text-blue-500' },
  { status: 'blocked', label: '受阻', icon: AlertTriangle, color: 'text-amber-500' },
  { status: 'done', label: '已完成', icon: CheckCircle2, color: 'text-emerald-500' },
]

export function DshGroupChatTasksPanel(): React.ReactElement {
  const activeGroupId = useAtomValue(dshActiveGroupIdAtom)
  const board = useAtomValue(dshActiveTaskBoardAtom)
  const [tasksMap, setTasksMap] = useAtom(dshTasksMapAtom)
  const [_, setActiveDrawer] = useAtom(dshActiveDrawerAtom)

  const [newTaskTitle, setNewTaskTitle] = useState('')
  const [creating, setCreating] = useState(false)

  const tasks = board?.tasks || []

  // 创建新任务
  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newTaskTitle.trim() || !activeGroupId || creating) return

    setCreating(true)
    try {
      const updatedBoard = await window.electronAPI.dshGroupChat.createTask({
        groupId: activeGroupId,
        title: newTaskTitle.trim(),
        expectedRevision: board?.revision,
      })
      setTasksMap((prev) => ({ ...prev, [activeGroupId]: updatedBoard }))
      setNewTaskTitle('')
    } catch (err) {
      console.error('[DshGroupChatTasksPanel] 创建任务失败:', err)
    } finally {
      setCreating(false)
    }
  }

  // 状态流转
  const handleUpdateStatus = async (taskId: string, nextStatus: DshGroupTaskStatus) => {
    if (!activeGroupId) return
    try {
      const updatedBoard = await window.electronAPI.dshGroupChat.updateTask({
        groupId: activeGroupId,
        taskId,
        status: nextStatus,
        expectedRevision: board?.revision,
      })
      setTasksMap((prev) => ({ ...prev, [activeGroupId]: updatedBoard }))
    } catch (err) {
      console.error('[DshGroupChatTasksPanel] 更新状态失败:', err)
    }
  }

  // 一键原子分解示例
  const handleDecompose = async (parentTaskId: string, title: string) => {
    if (!activeGroupId) return
    try {
      const updatedBoard = await window.electronAPI.dshGroupChat.decomposeTasks({
        groupId: activeGroupId,
        parentTaskId,
        expectedRevision: board?.revision,
        tasks: [
          { title: `${title} - 子阶段 1: 需求拆解与接口契约`, status: 'todo' },
          { title: `${title} - 子阶段 2: 核心代码落地与单测覆盖`, status: 'todo' },
        ],
      })
      setTasksMap((prev) => ({ ...prev, [activeGroupId]: updatedBoard }))
    } catch (err) {
      console.error('[DshGroupChatTasksPanel] 分解任务失败:', err)
    }
  }

  return (
    <div className="w-80 border-l border-border/60 flex flex-col h-full bg-background select-none animate-in slide-in-from-right duration-200">
      {/* 抽屉 Header */}
      <div className="h-13 border-b border-border/60 px-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <Kanban className="w-4 h-4 text-primary" />
          <span className="text-xs font-semibold text-foreground">群任务看板</span>
          {board && (
            <span className="text-[10px] px-1.5 py-0.2 rounded bg-muted text-muted-foreground font-mono">
              r{board.revision}
            </span>
          )}
        </div>

        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
          onClick={() => setActiveDrawer('none')}
        >
          <X className="w-4 h-4" />
        </Button>
      </div>

      {/* 新建任务输入框 */}
      <form onSubmit={handleCreateTask} className="p-3 border-b border-border/50">
        <div className="flex items-center gap-1.5">
          <Input
            value={newTaskTitle}
            onChange={(e) => setNewTaskTitle(e.target.value)}
            placeholder="快速拆解新建协同任务..."
            className="h-7 text-xs bg-muted/30"
          />
          <Button
            type="submit"
            size="sm"
            disabled={!newTaskTitle.trim() || creating}
            className="h-7 px-2.5 text-xs shrink-0"
          >
            <Plus className="w-3.5 h-3.5 mr-1" />
            添加
          </Button>
        </div>
      </form>

      {/* 四列泳道分类列表 */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {STATUS_COLUMNS.map((col) => {
          const colTasks = tasks.filter((t) => t.status === col.status && !t.archivedAt)
          const IconComponent = col.icon

          return (
            <div key={col.status} className="space-y-1.5">
              <div className="flex items-center justify-between text-xs font-medium text-foreground px-1">
                <span className="flex items-center gap-1.5">
                  <IconComponent className={`w-3.5 h-3.5 ${col.color}`} />
                  <span>{col.label}</span>
                </span>
                <span className="text-[11px] text-muted-foreground font-mono">{colTasks.length}</span>
              </div>

              {colTasks.length === 0 ? (
                <div className="p-2.5 rounded-lg border border-dashed border-border/60 text-center text-[11px] text-muted-foreground/60">
                  暂无任务
                </div>
              ) : (
                <div className="space-y-1.5">
                  {colTasks.map((task) => (
                    <div
                      key={task.id}
                      className="p-2.5 rounded-xl border border-border/70 bg-card hover:border-primary/40 transition-all text-xs shadow-xs space-y-1.5"
                    >
                      <div className="flex items-start justify-between gap-1">
                        <span className="font-medium text-foreground leading-snug">{task.title}</span>
                        <span className="text-[10px] text-muted-foreground font-mono shrink-0">
                          #{task.number}
                        </span>
                      </div>

                      {task.description && (
                        <p className="text-[11px] text-muted-foreground line-clamp-2">
                          {task.description}
                        </p>
                      )}

                      {/* 任务状态流转按钮条 */}
                      <div className="flex items-center justify-between pt-1 border-t border-border/40 text-[10px]">
                        <button
                          onClick={() => handleDecompose(task.id, task.title)}
                          className="flex items-center gap-1 text-primary hover:underline cursor-pointer"
                          title="原子分解子任务"
                        >
                          <GitFork className="w-3 h-3" />
                          <span>分解</span>
                        </button>

                        <div className="flex items-center gap-1">
                          {task.status !== 'in_progress' && (
                            <button
                              onClick={() => handleUpdateStatus(task.id, 'in_progress')}
                              className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 hover:bg-blue-500/20 font-medium cursor-pointer"
                            >
                              开始
                            </button>
                          )}
                          {task.status !== 'done' && (
                            <button
                              onClick={() => handleUpdateStatus(task.id, 'done')}
                              className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 font-medium cursor-pointer"
                            >
                              完成
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
