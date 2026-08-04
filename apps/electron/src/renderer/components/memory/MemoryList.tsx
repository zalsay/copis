import * as React from 'react'
import { BookOpen, Loader2 } from 'lucide-react'
import type { MemoryEntry } from '@copis/shared'
import { cn } from '@/lib/utils'

const KIND_LABELS: Record<MemoryEntry['kind'], string> = {
  fact: '事实',
  preference: '偏好',
  decision: '决策',
  project: '项目',
  scratch: '草稿',
}

function formatUpdatedAt(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}

interface MemoryListProps {
  entries: MemoryEntry[]
  selectedId: string | null
  loading: boolean
  query: string
  onSelect: (entry: MemoryEntry) => void
}

export function MemoryList({ entries, selectedId, loading, query, onSelect }: MemoryListProps): React.ReactElement {
  return (
    <section className="flex min-h-0 flex-1 flex-col border-r border-border/50">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="text-xs font-medium uppercase tracking-wide text-foreground/45">记忆条目</div>
        <div className="text-xs tabular-nums text-foreground/35">{entries.length}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 scrollbar-thin">
        {loading ? (
          <div className="flex h-32 items-center justify-center text-foreground/40">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : entries.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-foreground/45">
            <BookOpen className="size-7 text-foreground/25" />
            <span>{query.trim() ? '没有匹配的记忆' : '还没有记忆条目'}</span>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {entries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => onSelect(entry)}
                className={cn(
                  'w-full rounded-lg px-3 py-2.5 text-left transition-colors',
                  selectedId === entry.id
                    ? 'bg-primary/10 text-foreground shadow-sm'
                    : 'text-foreground/75 hover:bg-muted/70',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-medium">{entry.title}</span>
                  <span className="shrink-0 text-[11px] tabular-nums text-foreground/35">v{entry.revision}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-foreground/50">{entry.content}</p>
                <div className="mt-2 flex items-center gap-1.5 text-[11px] text-foreground/40">
                  <span>{entry.scope === 'user' ? '用户' : '工作区'}</span>
                  <span aria-hidden="true">·</span>
                  <span>{KIND_LABELS[entry.kind]}</span>
                  {entry.archived && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-amber-600 dark:text-amber-400">已归档</span>
                    </>
                  )}
                  <span className="ml-auto">{formatUpdatedAt(entry.updatedAt)}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
