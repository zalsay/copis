import * as React from 'react'
import { FolderOpen, Loader2 } from 'lucide-react'
import type { AgentWorkspace, MemoryPolicy, MemoryStats } from '@copis/shared'
import { useAtom, useAtomValue } from 'jotai'
import {
  memoryDefaultPolicyAtom,
  memoryProjectStatsAtom,
  memoryProjectStatsLoadingAtom,
} from '@/atoms/memory-atoms'
import { memoryApi } from '@/lib/memory-api'
import { cn } from '@/lib/utils'

interface MemoryProjectOverviewProps {
  workspaces: AgentWorkspace[]
  selectedWorkspaceId: string | null
  onSelectWorkspace: (workspaceId: string) => void
}

function policyLabel(policy: MemoryPolicy): string {
  if (policy === 'off') return '关闭'
  if (policy === 'visible') return '只读'
  return '可写'
}

export function MemoryProjectOverview({ workspaces, selectedWorkspaceId, onSelectWorkspace }: MemoryProjectOverviewProps): React.ReactElement {
  const defaultPolicy = useAtomValue(memoryDefaultPolicyAtom)
  const [stats, setStats] = useAtom(memoryProjectStatsAtom)
  const [loading, setLoading] = useAtom(memoryProjectStatsLoadingAtom)

  React.useEffect(() => {
    let active = true
    setLoading(true)
    void Promise.all(workspaces.map(async (workspace): Promise<[string, MemoryStats]> => [workspace.id, await memoryApi.stats(workspace.slug)]))
      .then((items) => {
        if (!active) return
        setStats(Object.fromEntries(items))
      })
      .catch(() => {
        if (active) setStats({})
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [setLoading, setStats, workspaces])

  if (workspaces.length === 0) {
    return (
      <section className="flex min-h-0 flex-1 items-center justify-center p-8">
        <div className="max-w-md text-center">
          <FolderOpen className="mx-auto size-8 text-foreground/25" />
          <h2 className="mt-3 text-base font-medium text-foreground">还没有项目</h2>
          <p className="mt-2 text-sm leading-6 text-foreground/50">当前只能管理用户记忆。创建项目后，项目记忆和项目策略会显示在这里。</p>
        </div>
      </section>
    )
  }

  return (
    <section className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-5xl px-8 py-7">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">全部项目</h2>
            <p className="mt-1 text-sm text-foreground/50">按项目查看记忆数量和当前生效策略。</p>
          </div>
          {loading && <Loader2 className="size-4 animate-spin text-foreground/35" />}
        </div>
        <div className="mt-6 overflow-hidden rounded-lg bg-card/55 shadow-sm ring-1 ring-border/35">
          {workspaces.map((workspace) => {
            const workspaceStats = stats[workspace.id]
            const effectivePolicy = workspace.memoryPolicy ?? defaultPolicy
            return (
              <button
                key={workspace.id}
                type="button"
                onClick={() => onSelectWorkspace(workspace.id)}
                className={cn(
                  'flex w-full items-center gap-4 border-b border-border/35 px-4 py-4 text-left last:border-b-0 hover:bg-muted/35',
                  selectedWorkspaceId === workspace.id && 'bg-primary/5',
                )}
              >
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <FolderOpen className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">{workspace.name}</div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-foreground/45">
                    <span>{workspace.projectRootPath ? '已关联本地目录' : 'Copis 托管项目'}</span>
                    <span>{workspace.memoryPolicy ? `项目覆盖：${policyLabel(workspace.memoryPolicy)}` : `继承全局：${policyLabel(defaultPolicy)}`}</span>
                  </div>
                </div>
                <div className="shrink-0 text-right text-xs tabular-nums text-foreground/50">
                  <div>{workspaceStats ? `用户 ${workspaceStats.userCount} · 项目 ${workspaceStats.workspaceCount} · 归档 ${workspaceStats.archivedCount}` : '统计加载中'}</div>
                  <div className="mt-1">生效：{policyLabel(effectivePolicy)}</div>
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
}
