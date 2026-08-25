import * as React from 'react'
import { Plus, RefreshCw, Search } from 'lucide-react'
import type { MemoryKindFilter, MemoryMaintenanceState, MemoryPolicy, MemoryScopeFilter, MemoryStats } from '@copis/shared'
import { AppSelect } from '@/components/ui/select'
import { cn } from '@/lib/utils'

interface MemoryToolbarProps {
  query: string
  scope: MemoryScopeFilter
  kind: MemoryKindFilter
  includeArchived: boolean
  stats: MemoryStats
  memoryPolicy: MemoryPolicy
  memoryDefaultPolicy: MemoryPolicy
  memoryPolicyOverride: MemoryPolicy | null
  workspaceAvailable: boolean
  maintenanceState: MemoryMaintenanceState | null
  loading: boolean
  onQueryChange: (value: string) => void
  onScopeChange: (value: MemoryScopeFilter) => void
  onKindChange: (value: MemoryKindFilter) => void
  onIncludeArchivedChange: (value: boolean) => void
  onNew: () => void
  onRefresh: () => void
  onMemoryPolicyChange: (value: MemoryPolicy | null) => void
}

export function MemoryToolbar({
  query,
  scope,
  kind,
  includeArchived,
  stats,
  memoryPolicy,
  memoryDefaultPolicy,
  memoryPolicyOverride,
  workspaceAvailable,
  maintenanceState,
  loading,
  onQueryChange,
  onScopeChange,
  onKindChange,
  onIncludeArchivedChange,
  onNew,
  onRefresh,
  onMemoryPolicyChange,
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

      <AppSelect
        value={scope}
        onValueChange={(val) => onScopeChange(val as MemoryScopeFilter)}
        aria-label="记忆范围"
        size="sm"
        triggerClassName="h-9 w-auto bg-muted/60"
        options={[
          { value: 'all', label: '全部范围' },
          { value: 'user', label: '用户记忆' },
          { value: 'workspace', label: '工作区记忆' },
        ]}
      />

      <AppSelect
        value={workspaceAvailable ? (memoryPolicyOverride ?? 'inherit') : memoryPolicy}
        disabled={!workspaceAvailable}
        onValueChange={(val) => onMemoryPolicyChange(val === 'inherit' ? null : (val as MemoryPolicy))}
        aria-label="Memory 策略"
        size="sm"
        triggerClassName="h-9 w-auto bg-muted/60"
        options={[
          ...(workspaceAvailable
            ? [
                {
                  value: 'inherit',
                  label: `记忆：${memoryDefaultPolicy === 'writable' ? '可写' : memoryDefaultPolicy === 'visible' ? '只读' : '关闭'}（继承全局）`,
                },
              ]
            : []),
          { value: 'writable', label: '记忆：可写' },
          { value: 'visible', label: '记忆：只读' },
          { value: 'off', label: '记忆：关闭' },
        ]}
      />

      <AppSelect
        value={kind}
        onValueChange={(val) => onKindChange(val as MemoryKindFilter)}
        aria-label="记忆类型"
        size="sm"
        triggerClassName="h-9 w-auto bg-muted/60"
        options={[
          { value: 'all', label: '全部类型' },
          { value: 'fact', label: '事实' },
          { value: 'preference', label: '偏好' },
          { value: 'decision', label: '决策' },
          { value: 'project', label: '项目' },
          { value: 'scratch', label: '草稿' },
        ]}
      />

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
      {maintenanceState && (
        <span className="hidden whitespace-nowrap text-xs tabular-nums text-foreground/45 2xl:inline" title="自动维护状态">
          维护 {maintenanceState.lastConsolidatedCaptureCount}/{maintenanceState.captureCount}
          {maintenanceState.lastCleanupAt ? ' · 已清理' : ''}
        </span>
      )}

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
