/**
 * DSH 群聊智能体配置与模型切换抽屉面板（Agents Panel）
 */

import React, { useEffect, useState } from 'react'
import {
  Bot,
  Crown,
  Sparkles,
  ChevronDown,
  Check,
  X,
  Cpu,
  Layers,
  Info,
} from 'lucide-react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import type { DshGroupChatAgent } from '@copis/shared'
import {
  dshActiveGroupIdAtom,
  dshActiveGroupDetailAtom,
  dshActiveDrawerAtom,
  dshAvailableModelsAtom,
} from '@/atoms/dsh-group-chat-atoms'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export interface DshGroupChatAgentsPanelProps {
  groupId?: string
  agents?: DshGroupChatAgent[]
  onClose?: () => void
}

export function DshGroupChatAgentsPanel(props: DshGroupChatAgentsPanelProps = {}): React.ReactElement {
  const activeGroupId = useAtomValue(dshActiveGroupIdAtom)
  const [groupDetail, setGroupDetail] = useAtom(dshActiveGroupDetailAtom)
  const setActiveDrawer = useSetAtom(dshActiveDrawerAtom)
  const [availableModels, setAvailableModels] = useAtom(dshAvailableModelsAtom)
  const [updatingAgentId, setUpdatingAgentId] = useState<string | null>(null)

  const effectiveGroupId = props.groupId || activeGroupId || ''
  const effectiveAgents = props.agents || groupDetail?.agents || []
  const handleClose = props.onClose || (() => setActiveDrawer('none'))

  // 1. 加载可用模型列表（后台静默同步，避免锁定 UI 交互）
  useEffect(() => {
    let mounted = true
    window.electronAPI.dshGroupChat
      .getAvailableModels()
      .then((models) => {
        if (mounted && Array.isArray(models) && models.length > 0) {
          setAvailableModels(models)
        }
      })
      .catch((err) => {
        console.error('[DshGroupChatAgentsPanel] 获取可用模型列表异常:', err)
      })
    return () => {
      mounted = false
    }
  }, [setAvailableModels])

  // 2. 处理模型切换
  const handleModelChange = async (
    agentId: string,
    channelId: string,
    modelId: string,
    modelName: string,
  ) => {
    if (!effectiveGroupId) return
    try {
      setUpdatingAgentId(agentId)
      const updatedGroup = await window.electronAPI.dshGroupChat.updateAgentModel({
        groupId: effectiveGroupId,
        agentId,
        channelId,
        modelId,
        modelName,
      })
      if (updatedGroup) {
        setGroupDetail(updatedGroup)
      }
    } catch (err) {
      console.error('[DshGroupChatAgentsPanel] 切换智能体模型失败:', err)
    } finally {
      setUpdatingAgentId(null)
    }
  }

  // 计算当前显示的友好模型名
  const getDisplayModelName = (agent: DshGroupChatAgent) => {
    if (agent.modelName) return agent.modelName
    if (agent.modelId) {
      // 在可用模型库中查找名称
      for (const group of availableModels) {
        const found = group.models.find((m) => m.id === agent.modelId)
        if (found) return found.name
      }
      return agent.modelId
    }
    return '默认模型 (DeepSeek Flash)'
  }

  return (
    <div className="w-80 border-l border-border/60 flex flex-col h-full bg-background select-none animate-in slide-in-from-right duration-200">
      {/* 顶部标题栏 (对齐 Header 的 h-13) */}
      <div className="h-13 border-b border-border/60 px-3 flex items-center justify-between shrink-0 bg-muted/20">
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4 text-zinc-300" />
          <h3 className="text-xs font-semibold text-foreground">群协作智能体配置</h3>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/[0.08] text-zinc-300 border border-white/[0.08] font-medium">
            {effectiveAgents.length} 成员
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
          onClick={handleClose}
          title="关闭面板"
        >
          <X className="w-4 h-4" />
        </Button>
      </div>

      {/* 智能体卡片列表 */}
      <div className="flex-1 overflow-y-auto p-3.5 space-y-3">
        <div className="p-2.5 rounded-lg bg-muted/30 border border-border/40 text-[11px] text-muted-foreground leading-relaxed flex items-start gap-2">
          <Info className="w-3.5 h-3.5 text-zinc-400 shrink-0 mt-0.5" />
          <div>
            为群聊中的每个工作区智能体指定独立的推理模型。智能体在被 @ 触发协同调用时将使用对应的专属模型。
          </div>
        </div>

        {effectiveAgents.map((agent) => {
          const currentModelName = getDisplayModelName(agent)
          const isUpdating = updatingAgentId === agent.agentId

          return (
            <div
              key={agent.agentId}
              className="p-3 rounded-xl border border-border/60 bg-card hover:border-border transition-all space-y-2.5 shadow-2xs"
            >
              {/* 头部：头像、名称、Leader 标签 */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-7 h-7 rounded-lg bg-white/[0.08] border border-white/[0.1] flex items-center justify-center text-zinc-300 shrink-0">
                    <Bot className="w-3.5 h-3.5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-semibold text-foreground truncate">
                        {agent.name}
                      </span>
                      {agent.isLeader && (
                        <span className="px-1.5 py-0.2 rounded bg-white/[0.08] text-zinc-300 border border-white/[0.08] text-[10px] font-medium flex items-center gap-0.5 shrink-0">
                          <Crown className="w-2.5 h-2.5" />
                          Leader
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* 职责说明 */}
              {agent.responsibility && (
                <p className="text-[11px] text-muted-foreground leading-normal line-clamp-2 bg-muted/20 p-1.5 rounded-md border border-border/30">
                  {agent.responsibility}
                </p>
              )}

              {/* 核心操作项：模型切换 */}
              <div className="pt-1.5 border-t border-border/40 flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted-foreground flex items-center gap-1 shrink-0">
                  <Cpu className="w-3 h-3 text-muted-foreground/80" />
                  执行模型:
                </span>

                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      disabled={isUpdating}
                      className="group inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-medium border border-border/50 bg-background/80 hover:bg-muted/70 hover:border-border text-foreground transition-all shadow-2xs hover:shadow-xs max-w-[175px] truncate cursor-pointer"
                      title="点击切换此智能体的执行模型"
                    >
                      <div className="w-4 h-4 rounded-md bg-white/[0.08] flex items-center justify-center text-zinc-300 shrink-0 transition-colors group-hover:bg-white/[0.12]">
                        <Sparkles className="w-2.5 h-2.5" />
                      </div>
                      <span className="truncate">{isUpdating ? '切换中...' : currentModelName}</span>
                      <ChevronDown className="w-3 h-3 text-muted-foreground/60 shrink-0 ml-auto transition-transform group-hover:translate-y-0.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="w-56 max-h-[300px] overflow-y-auto z-[9999]"
                    onCloseAutoFocus={(e) => e.preventDefault()}
                  >
                    {availableModels.length === 0 ? (
                      <div className="p-2 text-[11px] text-muted-foreground text-center">
                        暂无可用模型
                      </div>
                    ) : (
                      availableModels.map((group, groupIdx) => (
                        <React.Fragment key={group.channelId || groupIdx}>
                          {groupIdx > 0 && <DropdownMenuSeparator />}
                          <DropdownMenuLabel className="text-[10px] text-muted-foreground uppercase tracking-wider px-2 py-1 flex items-center gap-1">
                            <Layers className="w-2.5 h-2.5" />
                            {group.channelName}
                          </DropdownMenuLabel>
                          {group.models.map((model) => {
                            const isSelected =
                              agent.modelId === model.id ||
                              (!agent.modelId && model.id === 'deepseek-v4-flash')

                            return (
                              <DropdownMenuItem
                                key={model.id}
                                onSelect={() =>
                                  handleModelChange(
                                    agent.agentId,
                                    group.channelId,
                                    model.id,
                                    model.name,
                                  )
                                }
                                onClick={() =>
                                  handleModelChange(
                                    agent.agentId,
                                    group.channelId,
                                    model.id,
                                    model.name,
                                  )
                                }
                                className={`flex items-center justify-between text-xs py-1.5 px-2 cursor-pointer ${
                                  isSelected ? 'bg-white/[0.1] text-white font-medium' : ''
                                }`}
                              >
                                <span className={isSelected ? 'font-medium text-white' : ''}>
                                  {model.name}
                                </span>
                                {isSelected && (
                                  <Check className="w-3.5 h-3.5 text-zinc-200 ml-2 shrink-0" />
                                )}
                              </DropdownMenuItem>
                            )
                          })}
                        </React.Fragment>
                      ))
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
