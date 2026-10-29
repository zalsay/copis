/**
 * DSH 智能体执行轨迹下钻抽屉组件（GroupInvocationDetail）
 */

import React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import {
  Activity,
  Bot,
  Brain,
  Wrench,
  CheckCircle2,
  Clock,
  X,
  FileCode,
  Sparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  dshActiveGroupIdAtom,
  dshActiveGroupDetailAtom,
  dshActiveDrawerAtom,
  dshActiveInvocationAtom,
} from '@/atoms/dsh-group-chat-atoms'

export function DshGroupChatInvocationDetail(): React.ReactElement {
  const groupDetail = useAtomValue(dshActiveGroupDetailAtom)
  const invocation = useAtomValue(dshActiveInvocationAtom)
  const [_, setActiveDrawer] = useAtom(dshActiveDrawerAtom)

  return (
    <div className="w-80 border-l border-border/60 flex flex-col h-full bg-background select-none animate-in slide-in-from-right duration-200">
      {/* Header */}
      <div className="h-13 border-b border-border/60 px-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-zinc-300" />
          <span className="text-xs font-semibold text-foreground">执行轨迹与透明度</span>
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

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {invocation ? (
          <div className="space-y-3">
            {/* 智能体状态卡片 */}
            <div className="p-3 rounded-xl border border-border/60 bg-muted/20 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                  <Bot className="w-3.5 h-3.5 text-zinc-300" />
                  {invocation.agentName}
                </span>
                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                    invocation.status === 'completed'
                      ? 'bg-white/[0.1] text-zinc-200 border border-white/[0.08]'
                      : invocation.status === 'running'
                        ? 'bg-white/[0.15] text-white border border-white/[0.12] animate-pulse'
                        : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {invocation.status === 'completed' ? '已完成' : '执行中'}
                </span>
              </div>

              {invocation.durationMs && (
                <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {(invocation.durationMs / 1000).toFixed(1)}s
                  </span>
                  {invocation.tokens && <span>{invocation.tokens} tokens</span>}
                </div>
              )}
            </div>

            {/* 深度思考 (Thought) */}
            {invocation.thoughts && (
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-foreground flex items-center gap-1.5">
                  <Brain className="w-3.5 h-3.5 text-zinc-300" />
                  深度思考
                </span>
                <div className="p-2.5 rounded-xl border border-border/60 bg-muted/30 text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
                  {invocation.thoughts}
                </div>
              </div>
            )}

            {/* 工具调用 (Tool Calls) */}
            {invocation.toolCalls && invocation.toolCalls.length > 0 && (
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-foreground flex items-center gap-1.5">
                  <Wrench className="w-3.5 h-3.5 text-zinc-300" />
                  工具调用 ({invocation.toolCalls.length})
                </span>
                <div className="space-y-1.5">
                  {invocation.toolCalls.map((tc, idx) => (
                    <div
                      key={idx}
                      className="p-2.5 rounded-lg border border-border/60 bg-card text-xs space-y-1"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-[11px] text-zinc-200">{tc.name}</span>
                        {tc.durationMs && (
                          <span className="text-[10px] text-muted-foreground">{tc.durationMs}ms</span>
                        )}
                      </div>
                      <pre className="text-[10px] bg-muted/50 p-1.5 rounded overflow-x-auto text-muted-foreground">
                        {JSON.stringify(tc.args, null, 2)}
                      </pre>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="p-3 rounded-xl border border-border/60 bg-muted/20 space-y-2">
              <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-zinc-300" />
                群内协同 Agent 名录
              </span>
              <p className="text-[11px] text-muted-foreground">
                群聊内配置的各 Agent 均处于就绪状态，点击 Agent 消息可下钻查看单次任务调度的完整调用链。
              </p>
            </div>

            <div className="space-y-2">
              {groupDetail?.agents.map((agent) => (
                <div
                  key={agent.agentId}
                  className="p-2.5 rounded-xl border border-border/70 bg-card text-xs space-y-1"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-foreground flex items-center gap-1.5">
                      <Bot className="w-3.5 h-3.5 text-zinc-300" />
                      {agent.name}
                    </span>
                    {agent.isLeader && (
                      <span className="text-[10px] px-1.5 py-0.2 rounded bg-white/[0.08] text-zinc-300 border border-white/[0.08] font-medium">
                        Leader
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">{agent.responsibility}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
