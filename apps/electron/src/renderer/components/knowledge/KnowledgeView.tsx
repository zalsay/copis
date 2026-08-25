import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { Loader2 } from 'lucide-react'
import type { MemoryEntry, MemoryPolicy, MemoryRevision, MemoryStats } from '@copis/shared'
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
  memorySelectedWorkspaceIdAtom,
  memoryWorkspaceSlugAtom,
  type MemoryDraft,
} from '@/atoms/memory-atoms'
import { agentWorkspacesAtom, currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import { MemoryApiError, memoryApi } from '@/lib/memory-api'
import { KnowledgeNav, type KnowledgePage } from './KnowledgeNav'
import { MemoryImportView } from '@/components/memory/MemoryImportView'
import { MemoryExportView } from '@/components/memory/MemoryExportView'
import { MemoryEditor } from '@/components/memory/MemoryEditor'
import { MemoryList } from '@/components/memory/MemoryList'
import { MemoryToolbar } from '@/components/memory/MemoryToolbar'
import { MemoryProjectSelector } from '@/components/memory/MemoryProjectSelector'
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
  return value
    .split(/[,，\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
}

function entryWorkspaceSlug(entry: MemoryEntry, currentWorkspaceSlug: string | null): string | undefined {
  if (entry.scope === 'user') return undefined
  return entry.workspaceSlug ?? currentWorkspaceSlug ?? undefined
}

export function KnowledgeView(): React.ReactElement {
  const [page, setPage] = React.useState<KnowledgePage>('ingest')
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useAtom(memorySelectedWorkspaceIdAtom)
  const [workspaceSlug, setWorkspaceSlug] = useAtom(memoryWorkspaceSlugAtom)
  const [scope, setScope] = useAtom(memoryScopeFilterAtom)
  const [kind, setKind] = useAtom(memoryKindFilterAtom)
  const [includeArchived, setIncludeArchived] = useAtom(memoryIncludeArchivedAtom)
  const [query, setQuery] = useAtom(memoryQueryAtom)
  const [entries, setEntries] = useAtom(memoryEntriesAtom)
  const [stats, setStats] = useAtom(memoryStatsAtom)
  const [selectedId, setSelectedId] = useAtom(memorySelectedIdAtom)
  const [history, setHistory] = useAtom(memoryHistoryAtom)
  const [draft, setDraft] = useAtom(memoryDraftAtom)
  const [editorMode, setEditorMode] = useAtom(memoryEditorModeAtom)
  const [dirty, setDirty] = useAtom(memoryDirtyAtom)
  const [listLoading, setListLoading] = useAtom(memoryListLoadingAtom)
  const [historyLoading, setHistoryLoading] = useAtom(memoryHistoryLoadingAtom)
  const [saving, setSaving] = useAtom(memorySavingAtom)
  const [refreshToken, setRefreshToken] = useAtom(memoryRefreshTokenAtom)
  const [conflict, setConflict] = useAtom(memoryConflictAtom)
  const [memoryPolicy, setMemoryPolicy] = useAtom(memoryPolicyAtom)
  const defaultMemoryPolicy = useAtomValue(memoryDefaultPolicyAtom)
  const maintenanceState = useAtomValue(memoryMaintenanceStateAtom)

  // 保持当前工作区选中态
  React.useEffect(() => {
    if (selectedWorkspaceId) {
      const exists = workspaces.some((w) => w.id === selectedWorkspaceId)
      if (exists) return
    }
    if (currentWorkspaceId && workspaces.some((w) => w.id === currentWorkspaceId)) {
      setSelectedWorkspaceId(currentWorkspaceId)
      return
    }
    setSelectedWorkspaceId(workspaces[0]?.id ?? null)
  }, [currentWorkspaceId, selectedWorkspaceId, setSelectedWorkspaceId, workspaces])

  const selectedWorkspace = React.useMemo(
    () => workspaces.find((w) => w.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces],
  )

  React.useEffect(() => {
    setWorkspaceSlug(selectedWorkspace?.slug ?? null)
  }, [selectedWorkspace, setWorkspaceSlug])

  const loadData = React.useCallback(async (): Promise<void> => {
    setListLoading(true)
    try {
      const effectiveScope = page === 'global' ? 'user' : scope
      const [listRes, statsRes] = await Promise.all([
        memoryApi.list({
          workspaceSlug: effectiveScope === 'user' ? undefined : (workspaceSlug ?? undefined),
          scope: effectiveScope,
          kind,
          includeArchived,
          query: query.trim() ? query.trim() : undefined,
          limit: 50,
        }),
        memoryApi.stats(workspaceSlug ?? undefined),
      ])
      setEntries(listRes.entries)
      setStats(statsRes)

      if (listRes.entries.length === 0) {
        setSelectedId(null)
        setDraft(null)
        setEditorMode('view')
        setDirty(false)
        setConflict(null)
      } else if (!selectedId || !listRes.entries.some((e) => e.id === selectedId)) {
        const first = listRes.entries[0]
        if (first) {
          setSelectedId(first.id)
          setDraft(draftFromEntry(first))
          setEditorMode('view')
          setDirty(false)
          setConflict(null)
        }
      } else {
        const current = listRes.entries.find((e) => e.id === selectedId)
        if (current && editorMode === 'view') {
          setDraft(draftFromEntry(current))
        }
      }
    } catch (error) {
      console.error('[Knowledge] 加载知识数据失败:', error)
    } finally {
      setListLoading(false)
    }
  }, [
    editorMode,
    includeArchived,
    kind,
    page,
    query,
    scope,
    selectedId,
    setConflict,
    setDirty,
    setDraft,
    setEditorMode,
    setEntries,
    setListLoading,
    setSelectedId,
    setStats,
    workspaceSlug,
  ])

  React.useEffect(() => {
    if (page === 'workspace' || page === 'global') {
      void loadData()
    }
  }, [loadData, page, refreshToken])

  const selectedEntry = React.useMemo(
    () => entries.find((e) => e.id === selectedId) ?? null,
    [entries, selectedId],
  )

  const loadHistory = React.useCallback(
    async (entry: MemoryEntry | null): Promise<void> => {
      if (!entry) {
        setHistory([])
        return
      }
      setHistoryLoading(true)
      try {
        const revisions = await memoryApi.history(entry.id, entryWorkspaceSlug(entry, workspaceSlug))
        setHistory(revisions)
      } catch (error) {
        console.error('[Knowledge] 加载知识版本失败:', error)
      } finally {
        setHistoryLoading(false)
      }
    },
    [setHistory, setHistoryLoading, workspaceSlug],
  )

  React.useEffect(() => {
    if (selectedEntry && (page === 'workspace' || page === 'global')) {
      void loadHistory(selectedEntry)
    }
  }, [loadHistory, page, selectedEntry])

  const selectEntry = React.useCallback((entry: MemoryEntry): void => {
    setSelectedId(entry.id)
    setDraft(draftFromEntry(entry))
    setEditorMode('view')
    setDirty(false)
    setConflict(null)
    void loadHistory(entry)
  }, [loadHistory, setConflict, setDirty, setDraft, setEditorMode, setSelectedId])

  const handleNew = React.useCallback((): void => {
    const newScope = page === 'global' ? 'user' : (selectedWorkspace ? 'workspace' : 'user')
    setSelectedId(null)
    setDraft(createDraft(newScope))
    setEditorMode('create')
    setDirty(false)
    setConflict(null)
    setHistory([])
  }, [page, selectedWorkspace, setConflict, setDirty, setDraft, setEditorMode, setHistory, setSelectedId])

  const handleDraftChange = (nextDraft: MemoryDraft): void => {
    setDraft(nextDraft)
    setDirty(true)
  }

  const handleSave = React.useCallback(async (): Promise<void> => {
    if (!draft) return
    if (!draft.title.trim() || !draft.content.trim()) {
      toast.error('知识标题和内容不能为空')
      return
    }

    setSaving(true)
    try {
      if (editorMode === 'create') {
        const res = await memoryApi.capture({
          scope: draft.scope,
          workspaceSlug: draft.scope === 'workspace' ? (workspaceSlug ?? undefined) : undefined,
          kind: draft.kind,
          title: draft.title.trim(),
          content: draft.content.trim(),
          tags: parseTags(draft.tags),
          source: 'user',
        })
        toast.success(res.deduplicated ? '已存在相同知识卡片' : '知识条目已保存')
        setEditorMode('view')
        setDirty(false)
        setSelectedId(res.entry.id)
        setDraft(draftFromEntry(res.entry))
        await loadData()
        await loadHistory(res.entry)
      } else if (editorMode === 'edit' && selectedEntry) {
        const updated = await memoryApi.rewrite(selectedEntry.id, {
          workspaceSlug: entryWorkspaceSlug(selectedEntry, workspaceSlug),
          title: draft.title.trim(),
          content: draft.content.trim(),
          kind: draft.kind,
          tags: parseTags(draft.tags),
          expectedRevision: draft.revision ?? selectedEntry.revision,
        })
        toast.success('知识条目已更新')
        setEditorMode('view')
        setDirty(false)
        setDraft(draftFromEntry(updated))
        await loadData()
        await loadHistory(updated)
      }
    } catch (error) {
      if (error instanceof MemoryApiError && error.status === 409) {
        toast.error('知识条目已被修改，请检查冲突')
      } else {
        toast.error(error instanceof Error ? error.message : '保存知识失败')
      }
    } finally {
      setSaving(false)
    }
  }, [draft, editorMode, loadData, loadHistory, selectedEntry, setDirty, setDraft, setEditorMode, setSaving, setSelectedId, workspaceSlug])

  const handleArchive = React.useCallback(async (): Promise<void> => {
    if (!selectedEntry) return
    try {
      await memoryApi.archive(selectedEntry.id, entryWorkspaceSlug(selectedEntry, workspaceSlug))
      toast.success('知识条目已归档')
      await loadData()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '归档失败')
    }
  }, [loadData, selectedEntry, workspaceSlug])

  const handleRestore = React.useCallback(async (revision: MemoryRevision): Promise<void> => {
    if (!selectedEntry) return
    try {
      await memoryApi.restore(selectedEntry.id, {
        revision: revision.revision,
        workspaceSlug: entryWorkspaceSlug(selectedEntry, workspaceSlug),
      })
      toast.success(`已恢复至版本 #${revision.revision}`)
      await loadData()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '恢复版本失败')
    }
  }, [loadData, selectedEntry, workspaceSlug])

  const handleCancel = (): void => {
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
  }

  const handleEdit = (): void => {
    if (selectedEntry?.archived) {
      toast.error('归档条目不能直接编辑，请先从历史恢复')
      return
    }
    setEditorMode('edit')
    setDirty(false)
    setConflict(null)
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-content-area">
      {/* 顶部 Header */}
      <header className="titlebar-no-drag flex shrink-0 items-center justify-between px-6 pb-3 pt-14">
        <div className="flex min-w-0 items-center">
          <div>
            <h1 className="text-xl font-semibold text-foreground">知识库</h1>
            <p className="mt-0.5 text-xs text-foreground/45">
              {selectedWorkspace ? `当前项目：${selectedWorkspace.name}` : '全局用户知识库'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {(page === 'workspace' || page === 'ingest') && (
            <MemoryProjectSelector
              workspaces={workspaces}
              selectedWorkspaceId={selectedWorkspaceId}
              onChange={setSelectedWorkspaceId}
            />
          )}
          {listLoading && <Loader2 className="size-4 animate-spin text-foreground/35" />}
        </div>
      </header>

      {/* 主体分栏 */}
      <div className="flex min-h-0 flex-1">
        <KnowledgeNav page={page} onPageChange={setPage} />
        <div className="flex min-w-0 min-h-0 flex-1 flex-col">
          {page === 'ingest' && (
            <MemoryImportView workspaceSlug={workspaceSlug} workspaces={workspaces} />
          )}

          {(page === 'workspace' || page === 'global') && (
            <>
              <MemoryToolbar
                query={query}
                scope={page === 'global' ? 'user' : scope}
                kind={kind}
                includeArchived={includeArchived}
                stats={stats}
                memoryPolicy={memoryPolicy}
                memoryDefaultPolicy={defaultMemoryPolicy}
                memoryPolicyOverride={selectedWorkspace?.memoryPolicy ?? null}
                workspaceAvailable={page === 'global' ? false : !!selectedWorkspace}
                maintenanceState={maintenanceState}
                loading={listLoading}
                onQueryChange={setQuery}
                onScopeChange={setScope}
                onKindChange={setKind}
                onIncludeArchivedChange={setIncludeArchived}
                onNew={handleNew}
                onRefresh={() => setRefreshToken((value) => value + 1)}
                onMemoryPolicyChange={(value) => { if (value) setMemoryPolicy(value) }}
              />
              <div className="flex min-h-0 flex-1">
                <MemoryList
                  entries={entries}
                  selectedId={selectedId}
                  loading={listLoading}
                  query={query}
                  onSelect={selectEntry}
                />
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
            </>
          )}

          {page === 'export' && (
            <MemoryExportView workspaceSlug={workspaceSlug} workspaces={workspaces} />
          )}
        </div>
      </div>
    </div>
  )
}
