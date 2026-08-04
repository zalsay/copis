import * as React from 'react'
import { History, RotateCcw } from 'lucide-react'
import type { MemoryRevision } from '@copis/shared'
import { cn } from '@/lib/utils'

const OPERATION_LABELS: Record<MemoryRevision['operation'], string> = {
  capture: '创建',
  rewrite: '编辑',
  restore: '恢复',
  archive: '归档',
}

interface MemoryHistoryProps {
  revisions: MemoryRevision[]
  loading: boolean
  onRestore: (revision: MemoryRevision) => void
}

export function MemoryHistory({ revisions, loading, onRestore }: MemoryHistoryProps): React.ReactElement {
  return (
    <div className="border-t border-border/50 pt-5">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground/75">
        <History className="size-4 text-foreground/45" />
        修订历史
      </div>
      {loading ? (
        <div className="text-xs text-foreground/45">加载历史中...</div>
      ) : revisions.length === 0 ? (
        <div className="text-xs text-foreground/45">暂无修订历史</div>
      ) : (
        <div className="flex flex-col gap-2">
          {revisions.map((revision) => (
            <div key={`${revision.memoryId}-${revision.revision}`} className="flex items-start justify-between gap-3 rounded-lg bg-muted/45 px-3 py-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-xs font-medium text-foreground/70">
                  <span>v{revision.revision}</span>
                  <span className="text-foreground/40">{OPERATION_LABELS[revision.operation]}</span>
                </div>
                <div className="mt-1 line-clamp-2 text-xs leading-5 text-foreground/45">{revision.snapshot.content}</div>
              </div>
              <button
                type="button"
                onClick={() => onRestore(revision)}
                className={cn('flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-foreground/60 transition-colors hover:bg-background hover:text-foreground')}
              >
                <RotateCcw className="size-3.5" />
                恢复
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
