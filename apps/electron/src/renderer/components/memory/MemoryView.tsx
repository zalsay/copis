import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { BookOpen, Loader2 } from 'lucide-react'
import type { MemoryEntry, MemoryPolicy, MemoryRevision } from '@copis/shared'
import {
  memoryConflictAtom,
  memoryDirtyAtom,
  memoryDraftAtom,
  memoryEditorModeAtom,
  memoryEntriesAtom,
  memoryHistoryAtom,
  memoryHistoryLoadingAtom,
  memoryIncludeArchivedAtom,
  memoryKindFilterAtom,
  memoryListLoadingAtom,
  memoryQueryAtom,
  memoryRefreshTokenAtom,
  memorySavingAtom,
  memoryScopeFilterAtom,
  memorySelectedIdAtom,
  memoryStatsAtom,
  memoryDefaultPolicyAtom,
  memoryMaintenanceStateAtom,
  memoryPolicyAtom,
  memoryWorkspaceSlugAtom,
  type MemoryDraft,
} from '@/atoms/memory-atoms'
import { agentWorkspacesAtom, currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import { MemoryApiError, memoryApi } from '@/lib/memory-api'
import { MemoryEditor } from './MemoryEditor'
import { MemoryList } from './MemoryList'
import { MemoryToolbar } from './MemoryToolbar'
import { toast } from 'sonner'

function draftFromEntry(entry: MemoryEntry): MemoryDraft {
  return {
    scope: entry.scope,
    kind: entry.kind,
    title: entry.title,
    content: entry.content,
    tags: entry.tags.join(', '),
    revision: entry.revision,
  }
}

function createDraft(scope: MemoryDraft['scope']): MemoryDraft {
  return {
    scope,
    kind: 'fact',
    title: '',
    content: '',
    tags: '',
  }
}

function parseTags(value: string): string[] {
  return [...new Set(value.split(',').map((tag) => tag.trim()).filter(Boolean))]
}

function entryWorkspaceSlug(entry: MemoryEntry, workspaceSlug: string | null): string | undefined {
  return entry.scope === 'workspace' ? workspaceSlug ?? entry.workspaceSlug : undefined
}

export function MemoryView(): React.ReactElement {
  const [workspaces, setWorkspaces] = useAtom(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const currentWorkspace = workspaces.find((workspace) => workspace.id === currentWorkspaceId)
  const workspaceSlug = currentWorkspace?.slug ?? null

  const [memoryWorkspaceSlug, setMemoryWorkspaceSlug] = useAtom(memoryWorkspaceSlugAtom)
  const [scope, setScope] = useAtom(memoryScopeFilterAtom)
  const [kind, setKind] = useAtom(memoryKindFilterAtom)
  const [includeArchived, setIncludeArchived] = useAtom(memoryIncludeArchivedAtom)
  const [query, setQuery] = useAtom(memoryQueryAtom)
  const [entries, setEntries] = useAtom(memoryEntriesAtom)
  const [stats, setStats] = useAtom(memoryStatsAtom)
  const [memoryPolicy, setMemoryPolicy] = useAtom(memoryPolicyAtom)
  const [defaultMemoryPolicy, setDefaultMemoryPolicy] = useAtom(memoryDefaultPolicyAtom)
  const [maintenanceState, setMaintenanceState] = useAtom(memoryMaintenanceStateAtom)
  const [selectedId, setSelectedId] = useAtom(memorySelectedIdAtom)
  const [history, setHistory] = useAtom(memoryHistoryAtom)
  const [draft, setDraft] = useAtom(memoryDraftAtom)
  const [editorMode, setEditorMode] = useAtom(memoryEditorModeAtom)
  const [dirty, setDirty] = useAtom(memoryDirtyAtom)
  const [listLoading, setListLoading] = useAtom(memoryListLoadingAtom)
  const [historyLoading, setHistoryLoading] = useAtom(memoryHistoryLoadingAtom)
  const [saving, setSaving] = useAtom(memorySavingAtom)
  const [conflict, setConflict] = useAtom(memoryConflictAtom)
  const setRefreshToken = useSetAtom(memoryRefreshTokenAtom)
  const refreshToken = useAtomValue(memoryRefreshTokenAtom)

  const selectedEntry = entries.find((entry) => entry.id === selectedId) ?? null

  React.useEffect(() => {
    setMemoryWorkspaceSlug(workspaceSlug)
    setSelectedId(null)
    setDraft(null)
    setHistory([])
    setEditorMode('view')
    setConflict(null)
    setMemoryPolicy(currentWorkspace?.memoryPolicy ?? defaultMemoryPolicy)
    setMaintenanceState(null)
  }, [currentWorkspace?.memoryPolicy, defaultMemoryPolicy, setDraft, setEditorMode, setHistory, setMemoryPolicy, setMemoryWorkspaceSlug, setSelectedId, setConflict, setMaintenanceState, workspaceSlug])

  React.useEffect(() => {
    void window.electronAPI.getSettings().then((settings) => {
      const policy = settings.defaultMemoryPolicy ?? 'writable'
      setDefaultMemoryPolicy(policy)
      if (!currentWorkspace) setMemoryPolicy(policy)
    }).catch((error) => console.warn('[Memory] 读取默认策略失败:', error))
  }, [currentWorkspace, setDefaultMemoryPolicy, setMemoryPolicy])

  const loadHistory = React.useCallback(async (entry: MemoryEntry): Promise<void> => {
    setHistoryLoading(true)
    try {
      const revisions = await memoryApi.history(entry.id, entryWorkspaceSlug(entry, workspaceSlug))
      setHistory(revisions)
    } catch (error) {
      console.error('[Memory] 加载修订历史失败:', error)
      toast.error(error instanceof Error ? error.message : '加载修订历史失败')
      setHistory([])
    } finally {
      setHistoryLoading(false)
    }
  }, [setHistory, setHistoryLoading, workspaceSlug])

  const loadData = React.useCallback(async (): Promise<void> => {
    setListLoading(true)
    try {
      const [list, nextStats, nextMaintenance] = await Promise.all([
        memoryApi.list({
          workspaceSlug: memoryWorkspaceSlug ?? undefined,
          query,
          scope,
          kind,
          includeArchived,
          limit: 50,
        }),
        memoryApi.stats(memoryWorkspaceSlug ?? undefined),
        memoryWorkspaceSlug ? memoryApi.maintenanceState(memoryWorkspaceSlug) : Promise.resolve(null),
      ])
      setEntries(list.entries)
      setStats(nextStats)
      setMaintenanceState(nextMaintenance)
    } catch (error) {
      console.error('[Memory] 加载记忆列表失败:', error)
      toast.error(error instanceof Error ? error.message : '加载记忆列表失败')
    } finally {
      setListLoading(false)
    }
  }, [includeArchived, kind, memoryWorkspaceSlug, query, scope, setEntries, setListLoading, setMaintenanceState, setStats])

  React.useEffect(() => {
    const timer = window.setTimeout(() => { void loadData() }, query.trim() ? 220 : 0)
    return () => window.clearTimeout(timer)
  }, [loadData, query, refreshToken])

  const handleMemoryPolicyChange = React.useCallback(async (nextPolicy: MemoryPolicy): Promise<void> => {
    try {
      if (currentWorkspaceId && currentWorkspace) {
        const updated = await window.electronAPI.updateAgentWorkspace(currentWorkspaceId, { memoryPolicy: nextPolicy })
        setWorkspaces((items) => items.map((item) => item.id === updated.id ? updated : item))
      } else {
        const updated = await window.electronAPI.updateSettings({ defaultMemoryPolicy: nextPolicy })
        setDefaultMemoryPolicy(updated.defaultMemoryPolicy ?? 'writable')
      }
      setMemoryPolicy(nextPolicy)
      setRefreshToken((value) => value + 1)
      toast.success('Memory 策略已更新')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '更新 Memory 策略失败')
    }
  }, [currentWorkspace, currentWorkspaceId, setDefaultMemoryPolicy, setMemoryPolicy, setRefreshToken, setWorkspaces])

  const selectEntry = React.useCallback((entry: MemoryEntry): void => {
    setSelectedId(entry.id)
    setDraft(draftFromEntry(entry))
    setEditorMode('view')
    setDirty(false)
    setConflict(null)
    void loadHistory(entry)
  }, [loadHistory, setDirty, setDraft, setEditorMode, setSelectedId, setConflict])

  React.useEffect(() => {
    if (editorMode === 'create') return
    if (selectedId && entries.some((entry) => entry.id === selectedId)) return
    const first = entries[0]
    if (first) selectEntry(first)
    else {
      setSelectedId(null)
      setDraft(null)
      setHistory([])
    }
  }, [editorMode, entries, selectEntry, selectedId, setDraft, setHistory, setSelectedId])

  const handleNew = React.useCallback((): void => {
    setSelectedId(null)
    setDraft(createDraft(workspaceSlug ? 'workspace' : 'user'))
    setHistory([])
    setEditorMode('create')
    setDirty(false)
    setConflict(null)
  }, [setDirty, setDraft, setEditorMode, setHistory, setSelectedId, setConflict, workspaceSlug])

  const handleDraftChange = React.useCallback((nextDraft: MemoryDraft): void => {
    setDraft(nextDraft)
    setDirty(true)
    setConflict(null)
  }, [setDirty, setDraft, setConflict])

  const handleSave = React.useCallback(async (): Promise<void> => {
    if (!draft) return
    if (draft.scope === 'workspace' && !workspaceSlug) {
      toast.error('请先选择工作区，再保存工作区记忆')
      return
    }
    setSaving(true)
    try {
      if (editorMode === 'create') {
        const response = await memoryApi.capture({
          scope: draft.scope,
          workspaceSlug: draft.scope === 'workspace' ? workspaceSlug ?? undefined : undefined,
          kind: draft.kind,
          title: draft.title,
          content: draft.content,
          tags: parseTags(draft.tags),
          source: 'user',
        })
        setSelectedId(response.entry.id)
        setDraft(draftFromEntry(response.entry))
        setEditorMode('view')
        setDirty(false)
        toast.success(response.deduplicated ? '已使用已有记忆条目' : '记忆已创建')
        await loadData()
        await loadHistory(response.entry)
      } else if (selectedEntry) {
        const updated = await memoryApi.rewrite(selectedEntry.id, {
          workspaceSlug: entryWorkspaceSlug(selectedEntry, workspaceSlug),
          title: draft.title,
          content: draft.content,
          kind: draft.kind,
          tags: parseTags(draft.tags),
          expectedRevision: draft.revision ?? selectedEntry.revision,
        })
        setDraft(draftFromEntry(updated))
        setEditorMode('view')
        setDirty(false)
        setConflict(null)
        toast.success('记忆已保存')
        await loadData()
        await loadHistory(updated)
      }
    } catch (error) {
      if (error instanceof MemoryApiError && error.status === 409 && error.current) {
        setConflict({ current: error.current, message: error.message })
        toast.error('记忆版本已变化，本地草稿已保留')
      } else {
        console.error('[Memory] 保存记忆失败:', error)
        toast.error(error instanceof Error ? error.message : '保存记忆失败')
      }
    } finally {
      setSaving(false)
    }
  }, [draft, editorMode, loadData, loadHistory, selectedEntry, setDirty, setDraft, setEditorMode, setSaving, setSelectedId, setConflict, workspaceSlug])

  const handleArchive = React.useCallback(async (): Promise<void> => {
    if (!selectedEntry || selectedEntry.archived) return
    if (!window.confirm(`确定归档「${selectedEntry.title}」吗？`)) return
    try {
      await memoryApi.archive(selectedEntry.id, entryWorkspaceSlug(selectedEntry, workspaceSlug))
      toast.success('记忆已归档')
      setSelectedId(null)
      setDraft(null)
      setHistory([])
      await loadData()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '归档记忆失败')
    }
  }, [loadData, selectedEntry, setDraft, setHistory, setSelectedId, workspaceSlug])

  const handleRestore = React.useCallback(async (revision: MemoryRevision): Promise<void> => {
    if (!selectedEntry) return
    if (!window.confirm(`将记忆恢复到 v${revision.revision} 吗？`)) return
    try {
      const restored = await memoryApi.restore(selectedEntry.id, {
        workspaceSlug: entryWorkspaceSlug(selectedEntry, workspaceSlug),
        revision: revision.revision,
      })
      setDraft(draftFromEntry(restored))
      setEditorMode('view')
      setDirty(false)
      setConflict(null)
      toast.success(`已恢复为 v${revision.revision} 的内容`)
      await loadData()
      await loadHistory(restored)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '恢复记忆失败')
    }
  }, [loadData, loadHistory, selectedEntry, setDirty, setDraft, setEditorMode, setConflict, workspaceSlug])

  const handleCancel = React.useCallback((): void => {
    if (editorMode === 'create') {
      setDraft(null)
      setEditorMode('view')
      setDirty(false)
      return
    }
    if (selectedEntry) setDraft(draftFromEntry(selectedEntry))
    setEditorMode('view')
    setDirty(false)
    setConflict(null)
  }, [editorMode, selectedEntry, setDirty, setDraft, setEditorMode, setConflict])

  const handleEdit = React.useCallback((): void => {
    if (selectedEntry?.archived) {
      toast.error('归档记忆不能直接编辑，请先从历史恢复')
      return
    }
    setEditorMode('edit')
    setDirty(false)
    setConflict(null)
  }, [selectedEntry, setDirty, setEditorMode, setConflict])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-content-area">
      <header className="titlebar-no-drag flex shrink-0 items-center justify-between px-6 pb-3 pt-14">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <BookOpen className="size-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-foreground">记忆</h1>
            <p className="mt-0.5 text-xs text-foreground/45">
              {memoryWorkspaceSlug ? `当前工作区：${memoryWorkspaceSlug}` : '当前仅显示用户记忆'}
            </p>
          </div>
        </div>
        {listLoading && <Loader2 className="size-4 animate-spin text-foreground/35" />}
      </header>

      <MemoryToolbar
        query={query}
        scope={scope}
        kind={kind}
        includeArchived={includeArchived}
        stats={stats}
        memoryPolicy={memoryPolicy}
        maintenanceState={maintenanceState}
        loading={listLoading}
        onQueryChange={setQuery}
        onScopeChange={setScope}
        onKindChange={setKind}
        onIncludeArchivedChange={setIncludeArchived}
        onNew={handleNew}
        onRefresh={() => setRefreshToken((value) => value + 1)}
        onMemoryPolicyChange={(value) => { void handleMemoryPolicyChange(value) }}
      />

      <div className="flex min-h-0 flex-1">
        <MemoryList entries={entries} selectedId={selectedId} loading={listLoading} query={query} onSelect={selectEntry} />
        <MemoryEditor
          entry={selectedEntry}
          draft={draft}
          mode={editorMode}
          dirty={dirty}
          saving={saving}
          workspaceSlug={workspaceSlug}
          conflict={conflict}
          history={history}
          historyLoading={historyLoading}
          onDraftChange={handleDraftChange}
          onEdit={handleEdit}
          onCancel={handleCancel}
          onSave={() => { void handleSave() }}
          onArchive={() => { void handleArchive() }}
          onRestore={(revision) => { void handleRestore(revision) }}
        />
      </div>
    </div>
  )
}
