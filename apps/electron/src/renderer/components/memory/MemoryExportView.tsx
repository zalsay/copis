import * as React from 'react'
import { Download, Loader2 } from 'lucide-react'
import { useAtom, useAtomValue } from 'jotai'
import type { AgentWorkspace, MemoryExportFormat, MemoryExportInput, MemoryExportScope, MemoryStats } from '@copis/shared'
import {
  memoryExportEntryCountAtom,
  memoryExportErrorAtom,
  memoryExportFormatAtom,
  memoryExportIncludeArchivedAtom,
  memoryExportIncludeHistoryAtom,
  memoryExportLoadingAtom,
  memoryExportPreviewLoadingAtom,
  memoryExportScopeAtom,
} from '@/atoms/memory-atoms'
import { memoryApi } from '@/lib/memory-api'
import { toast } from 'sonner'

interface MemoryExportViewProps {
  workspaceSlug: string | null
  workspaces: AgentWorkspace[]
}

function scopeLabel(scope: MemoryExportScope): string {
  if (scope === 'current-workspace') return '当前项目'
  if (scope === 'all-workspaces') return '全部项目'
  return '用户记忆'
}

interface BuildMemoryExportInputOptions {
  scope: MemoryExportScope
  format: MemoryExportFormat
  includeArchived: boolean
  includeHistory: boolean
  workspaceSlug: string | null
  workspaces: AgentWorkspace[]
}

export function buildMemoryExportInput(options: BuildMemoryExportInputOptions): MemoryExportInput {
  return {
    scope: options.scope,
    ...(options.scope === 'current-workspace' && options.workspaceSlug ? { workspaceSlug: options.workspaceSlug } : {}),
    format: options.format,
    includeArchived: options.includeArchived,
    includeHistory: options.includeHistory,
    workspaceNames: Object.fromEntries(options.workspaces.map((workspace) => [workspace.slug, workspace.name])),
  }
}

export function countMemoryExportEntries(stats: MemoryStats, includeArchived: boolean): number {
  return stats.userCount + stats.workspaceCount + (includeArchived ? stats.archivedCount : 0)
}

export function countAllMemoryExportEntries(userStats: MemoryStats, projectStats: MemoryStats[], includeArchived: boolean): number {
  const archivedUserCount = includeArchived ? userStats.archivedCount : 0
  return userStats.userCount + archivedUserCount + projectStats.reduce((total, stats) => {
    const archivedProjectCount = includeArchived ? Math.max(0, stats.archivedCount - userStats.archivedCount) : 0
    return total + stats.workspaceCount + archivedProjectCount
  }, 0)
}

export function MemoryExportView({ workspaceSlug, workspaces }: MemoryExportViewProps): React.ReactElement {
  const [scope, setScope] = useAtom(memoryExportScopeAtom)
  const [format, setFormat] = useAtom(memoryExportFormatAtom)
  const [includeArchived, setIncludeArchived] = useAtom(memoryExportIncludeArchivedAtom)
  const [includeHistory, setIncludeHistory] = useAtom(memoryExportIncludeHistoryAtom)
  const [loading, setLoading] = useAtom(memoryExportLoadingAtom)
  const [previewLoading, setPreviewLoading] = useAtom(memoryExportPreviewLoadingAtom)
  const [entryCount, setEntryCount] = useAtom(memoryExportEntryCountAtom)
  const [errorMessage, setErrorMessage] = useAtom(memoryExportErrorAtom)

  React.useEffect(() => {
    if (!workspaceSlug && scope === 'current-workspace') setScope('user')
  }, [scope, setScope, workspaceSlug])

  React.useEffect(() => {
    let active = true
    if (scope === 'current-workspace' && !workspaceSlug) {
      setEntryCount(null)
      return () => { active = false }
    }

    setPreviewLoading(true)
    setErrorMessage(null)
    const load = async (): Promise<number> => {
      if (scope === 'user') {
        const stats = await memoryApi.stats()
        return countMemoryExportEntries(stats, includeArchived)
      }
      if (scope === 'current-workspace') {
        const stats = await memoryApi.stats(workspaceSlug ?? undefined)
        return countMemoryExportEntries(stats, includeArchived)
      }
      const [userStats, projectStats] = await Promise.all([
        memoryApi.stats(),
        Promise.all(workspaces.map((workspace) => memoryApi.stats(workspace.slug))),
      ])
      return countAllMemoryExportEntries(userStats, projectStats, includeArchived)
    }

    void load()
      .then((count) => {
        if (active) setEntryCount(count)
      })
      .catch(() => {
        if (active) {
          setEntryCount(null)
          setErrorMessage('无法读取导出范围的记忆统计')
        }
      })
      .finally(() => {
        if (active) setPreviewLoading(false)
      })
    return () => { active = false }
  }, [includeArchived, scope, setEntryCount, setErrorMessage, setPreviewLoading, workspaceSlug, workspaces])

  const handleExport = React.useCallback(async (): Promise<void> => {
    if (scope === 'current-workspace' && !workspaceSlug) {
      setErrorMessage('请先选择项目，再导出当前项目记忆')
      return
    }
    setLoading(true)
    setErrorMessage(null)
    try {
      const response = await memoryApi.export(buildMemoryExportInput({
        scope,
        workspaceSlug,
        format,
        includeArchived,
        includeHistory,
        workspaces,
      }))
      const saved = await window.electronAPI.saveMemoryExport(response)
      if (saved) toast.success(`已导出 ${response.entryCount} 条记忆`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '导出 Memory 失败')
    } finally {
      setLoading(false)
    }
  }, [format, includeArchived, includeHistory, scope, setErrorMessage, setLoading, workspaceSlug, workspaces])

  return (
    <section className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-3xl px-8 py-7">
        <h2 className="text-lg font-semibold text-foreground">导出记忆</h2>
        <p className="mt-1 text-sm text-foreground/50">导出只读，不会改变条目、归档状态或 revision。</p>

        <div className="mt-6 space-y-4 rounded-lg bg-card/55 p-5 shadow-sm ring-1 ring-border/35">
          <label className="flex items-center justify-between gap-4 text-sm">
            <span className="font-medium text-foreground">导出范围</span>
            <select
              aria-label="导出范围"
              value={scope}
              onChange={(event) => setScope(event.target.value as MemoryExportScope)}
              className="h-9 min-w-48 rounded-lg bg-muted/65 px-2.5 text-sm text-foreground/80 outline-none focus:ring-1 focus:ring-primary/40"
            >
              <option value="current-workspace">当前项目{workspaceSlug ? `：${workspaces.find((workspace) => workspace.slug === workspaceSlug)?.name ?? ''}` : ''}</option>
              <option value="all-workspaces">全部项目</option>
              <option value="user">用户记忆</option>
            </select>
          </label>

          <label className="flex items-center justify-between gap-4 text-sm">
            <span className="font-medium text-foreground">导出格式</span>
            <select
              aria-label="导出格式"
              value={format}
              onChange={(event) => setFormat(event.target.value as MemoryExportFormat)}
              className="h-9 min-w-48 rounded-lg bg-muted/65 px-2.5 text-sm text-foreground/80 outline-none focus:ring-1 focus:ring-primary/40"
            >
              <option value="json">JSON</option>
              <option value="markdown">Markdown</option>
            </select>
          </label>

          <label className="flex items-center gap-2 text-sm text-foreground/70">
            <input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} className="size-3.5 accent-primary" />
            包含归档条目
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground/70">
            <input type="checkbox" checked={includeHistory} onChange={(event) => setIncludeHistory(event.target.checked)} className="size-3.5 accent-primary" />
            包含 revision history
          </label>

          <div className="flex items-center justify-between border-t border-border/35 pt-4 text-sm text-foreground/55">
            <span>{scopeLabel(scope)} · {previewLoading ? '统计读取中' : `${entryCount ?? '未知'} 条记忆`}</span>
            <button
              type="button"
              onClick={() => { void handleExport() }}
              disabled={loading || previewLoading || (scope === 'current-workspace' && !workspaceSlug)}
              className="flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
              导出 {format === 'json' ? 'JSON' : 'Markdown'}
            </button>
          </div>
          {errorMessage && <div role="alert" className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">{errorMessage}</div>}
        </div>
      </div>
    </section>
  )
}
