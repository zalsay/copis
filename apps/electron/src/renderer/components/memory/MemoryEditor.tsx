import * as React from 'react'
import { Archive, Check, Edit3, Save, X } from 'lucide-react'
import type { MemoryEntry, MemoryKind, MemoryRevision, MemoryScope } from '@copis/shared'
import type { MemoryConflictState, MemoryDraft, MemoryEditorMode } from '@/atoms/memory-atoms'
import { MemoryHistory } from './MemoryHistory'

const KIND_OPTIONS: Array<{ value: MemoryKind; label: string }> = [
  { value: 'fact', label: '事实' },
  { value: 'preference', label: '偏好' },
  { value: 'decision', label: '决策' },
  { value: 'project', label: '项目' },
  { value: 'scratch', label: '草稿' },
]

interface MemoryEditorProps {
  entry: MemoryEntry | null
  draft: MemoryDraft | null
  mode: MemoryEditorMode
  dirty: boolean
  saving: boolean
  workspaceSlug: string | null
  conflict: MemoryConflictState | null
  history: MemoryRevision[]
  historyLoading: boolean
  onDraftChange: (draft: MemoryDraft) => void
  onEdit: () => void
  onCancel: () => void
  onSave: () => void
  onArchive: () => void
  onRestore: (revision: MemoryRevision) => void
}

function scopeLabel(scope: MemoryScope): string {
  return scope === 'user' ? '用户记忆' : '工作区记忆'
}

export function MemoryEditor({
  entry,
  draft,
  mode,
  dirty,
  saving,
  workspaceSlug,
  conflict,
  history,
  historyLoading,
  onDraftChange,
  onEdit,
  onCancel,
  onSave,
  onArchive,
  onRestore,
}: MemoryEditorProps): React.ReactElement {
  if (!draft || (mode === 'view' && !entry)) {
    return (
      <section className="flex min-h-0 flex-1 items-center justify-center px-8 text-sm text-foreground/40">
        选择一条记忆查看，或新建一条记忆
      </section>
    )
  }

  const readOnly = mode === 'view'
  const updateDraft = (updates: Partial<MemoryDraft>): void => onDraftChange({ ...draft, ...updates })

  return (
    <section className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-8 py-7">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2 text-xs text-foreground/45">
              <span>{mode === 'create' ? '新建记忆' : scopeLabel(draft.scope)}</span>
              {entry && <span>· v{entry.revision}</span>}
            </div>
            {readOnly ? (
              <h2 className="truncate text-xl font-semibold text-foreground">{draft.title || '未命名记忆'}</h2>
            ) : (
              <input
                value={draft.title}
                onChange={(event) => updateDraft({ title: event.target.value })}
                placeholder="记忆标题"
                className="w-full bg-transparent text-xl font-semibold text-foreground outline-none placeholder:text-foreground/30"
              />
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {readOnly ? (
              <>
                <button type="button" onClick={onEdit} className="flex h-8 items-center gap-1.5 rounded-md bg-muted px-2.5 text-xs text-foreground/70 transition-colors hover:bg-muted/70 hover:text-foreground">
                  <Edit3 className="size-3.5" />
                  编辑
                </button>
                {!entry?.archived && (
                  <button type="button" onClick={onArchive} className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs text-foreground/55 transition-colors hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400">
                    <Archive className="size-3.5" />
                    归档
                  </button>
                )}
              </>
            ) : (
              <>
                <button type="button" onClick={onCancel} className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs text-foreground/55 transition-colors hover:bg-muted hover:text-foreground">
                  <X className="size-3.5" />
                  取消
                </button>
                <button type="button" onClick={onSave} disabled={saving || !draft.title.trim() || !draft.content.trim()} className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50">
                  {saving ? <Check className="size-3.5 animate-pulse" /> : <Save className="size-3.5" />}
                  保存
                </button>
              </>
            )}
          </div>
        </div>

        {mode === 'create' && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-muted/45 px-3 py-2.5 text-xs text-foreground/60">
            <span>范围</span>
            <select
              value={draft.scope}
              onChange={(event) => updateDraft({ scope: event.target.value as MemoryScope })}
              className="rounded-md bg-background px-2 py-1 text-xs text-foreground/75 outline-none"
            >
              <option value="user">用户记忆</option>
              <option value="workspace" disabled={!workspaceSlug}>当前工作区</option>
            </select>
            {!workspaceSlug && <span className="text-amber-600 dark:text-amber-400">选择工作区后才能新建工作区记忆</span>}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 text-xs text-foreground/50">
          <label className="flex items-center gap-2">
            类型
            <select
              value={draft.kind}
              disabled={readOnly}
              onChange={(event) => updateDraft({ kind: event.target.value as MemoryKind })}
              className="rounded-md bg-muted/60 px-2 py-1.5 text-xs text-foreground/75 outline-none disabled:opacity-70"
            >
              {KIND_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="flex min-w-[220px] flex-1 items-center gap-2">
            标签
            <input
              value={draft.tags}
              disabled={readOnly}
              onChange={(event) => updateDraft({ tags: event.target.value })}
              placeholder="用逗号分隔"
              className="min-w-0 flex-1 rounded-md bg-muted/60 px-2 py-1.5 text-xs text-foreground/75 outline-none placeholder:text-foreground/30 disabled:opacity-70"
            />
          </label>
        </div>

        {readOnly ? (
          <div className="whitespace-pre-wrap rounded-lg bg-muted/35 px-4 py-4 text-sm leading-7 text-foreground/80">{draft.content}</div>
        ) : (
          <textarea
            value={draft.content}
            onChange={(event) => updateDraft({ content: event.target.value })}
            placeholder="记录稳定、可复用且有足够证据的事实、偏好或决策"
            className="min-h-[260px] resize-y rounded-lg bg-muted/35 px-4 py-3 text-sm leading-7 text-foreground/80 outline-none ring-1 ring-transparent transition-shadow focus:ring-primary/35"
          />
        )}

        {dirty && !readOnly && <div className="text-xs text-foreground/45">有未保存修改</div>}

        {conflict && (
          <div className="rounded-lg bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
            <div className="font-medium">保存时发现版本冲突</div>
            <div className="mt-1 text-xs leading-5">服务器当前版本为 v{conflict.current.revision}。本地草稿已保留，请合并后重新保存。</div>
          </div>
        )}

        {entry && <MemoryHistory revisions={history} loading={historyLoading} onRestore={onRestore} />}
      </div>
    </section>
  )
}
