import { atom } from 'jotai'
import type {
  MemoryEntry,
  MemoryKind,
  MemoryKindFilter,
  MemoryMaintenanceState,
  MemoryPolicy,
  MemoryRevision,
  MemoryScope,
  MemoryScopeFilter,
  MemoryStats,
} from '@copis/shared'

export type MemoryEditorMode = 'view' | 'edit' | 'create'

export interface MemoryDraft {
  scope: MemoryScope
  kind: MemoryKind
  title: string
  content: string
  tags: string
  revision?: number
}

export interface MemoryConflictState {
  current: MemoryEntry
  message: string
}

export const memoryWorkspaceSlugAtom = atom<string | null>(null)
export const memoryScopeFilterAtom = atom<MemoryScopeFilter>('all')
export const memoryKindFilterAtom = atom<MemoryKindFilter>('all')
export const memoryIncludeArchivedAtom = atom(false)
export const memoryQueryAtom = atom('')
export const memoryEntriesAtom = atom<MemoryEntry[]>([])
export const memoryStatsAtom = atom<MemoryStats>({ userCount: 0, workspaceCount: 0, archivedCount: 0 })
export const memorySelectedIdAtom = atom<string | null>(null)
export const memoryHistoryAtom = atom<MemoryRevision[]>([])
export const memoryDraftAtom = atom<MemoryDraft | null>(null)
export const memoryEditorModeAtom = atom<MemoryEditorMode>('view')
export const memoryDirtyAtom = atom(false)
export const memoryListLoadingAtom = atom(false)
export const memoryHistoryLoadingAtom = atom(false)
export const memorySavingAtom = atom(false)
export const memoryRefreshTokenAtom = atom(0)
export const memoryConflictAtom = atom<MemoryConflictState | null>(null)
export const memoryPolicyAtom = atom<MemoryPolicy>('writable')
export const memoryDefaultPolicyAtom = atom<MemoryPolicy>('writable')
export const memoryMaintenanceStateAtom = atom<MemoryMaintenanceState | null>(null)
