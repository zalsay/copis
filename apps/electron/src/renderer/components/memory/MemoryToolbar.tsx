import * as React from 'react'
import { Plus, RefreshCw, Search } from 'lucide-react'
import type { MemoryKindFilter, MemoryScopeFilter, MemoryStats } from '@copis/shared'
import { cn } from '@/lib/utils'

interface MemoryToolbarProps {
  query: string
  scope: MemoryScopeFilter
  kind: MemoryKindFilter
  includeArchived: boolean
  stats: MemoryStats
  loading: boolean
  onQueryChange: (value: string) => void
  onScopeChange: (value: MemoryScopeFilter) => void
  onKindChange: (value: MemoryKindFilter) => void
  onIncludeArchivedChange: (value: boolean) => void
  onNew: () => void
  onRefresh: () => void
}

export function MemoryToolbar({
  query,
  scope,
  kind,
  includeArchived,
  stats,
  loading,
  onQueryChange,
  onScopeChange,
  onKindChange,
  onIncludeArchivedChange,
  onNew,
  onRefresh,
}: MemoryToolbarProps): React.ReactElement {
  return (
    <div className="titlebar-no-drag flex flex-wrap items-center gap-2 border-b border-border/50 px-6 py-3">
      <div className="flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-lg bg-muted/60 px-3 focus-within:ring-1 focus-within:ring-primary/40">
        <Search className="size-4 shrink-0 text-foreground/40" />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索记忆"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-foreground/35"
        />
      </div>

      <select
        value={scope}
        onChange={(event) => onScopeChange(event.target.value as MemoryScopeFilter)}
        aria-label="记忆范围"
        className="h-9 rounded-lg bg-muted/60 px-2.5 text-sm text-foreground/75 outline-none focus:ring-1 focus:ring-primary/40"
      >
        <option value="all">全部范围</option>
        <option value="user">用户记忆</option>
        <option value="workspace">工作区记忆</option>
      </select>

      <select
        value={kind}
        onChange={(event) => onKindChange(event.target.value as MemoryKindFilter)}
        aria-label="记忆类型"
        className="h-9 rounded-lg bg-muted/60 px-2.5 text-sm text-foreground/75 outline-none focus:ring-1 focus:ring-primary/40"
      >
        <option value="all">全部类型</option>
        <option value="fact">事实</option>
        <option value="preference">偏好</option>
        <option value="decision">决策</option>
        <option value="project">项目</option>
        <option value="scratch">草稿</option>
      </select>

      <label className="flex h-9 items-center gap-2 px-2 text-xs text-foreground/60">
        <input
          type="checkbox"
          checked={includeArchived}
          onChange={(event) => onIncludeArchivedChange(event.target.checked)}
          className="size-3.5 accent-primary"
        />
        显示归档
      </label>

      <span className="hidden whitespace-nowrap text-xs tabular-nums text-foreground/45 xl:inline">
        用户 {stats.userCount} · 工作区 {stats.workspaceCount} · 归档 {stats.archivedCount}
      </span>

      <button
        type="button"
        onClick={onRefresh}
        disabled={loading}
        title="刷新记忆"
        className={cn(
          'flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm text-foreground/65 transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
        <span className="hidden sm:inline">刷新</span>
      </button>

      <button
        type="button"
        onClick={onNew}
        className="flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
      >
        <Plus className="size-4" />
        新建
      </button>
    </div>
  )
}
