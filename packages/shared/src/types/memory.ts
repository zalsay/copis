/** Copis Memory 长期记忆的共享数据契约。 */

export type MemoryScope = 'user' | 'workspace'

export type MemoryKind = 'fact' | 'preference' | 'decision' | 'project' | 'scratch'

export type MemorySource = 'agent' | 'user' | 'import'

export type MemoryOperation = 'capture' | 'rewrite' | 'restore' | 'archive'

export interface MemoryEntry {
  id: string
  scope: MemoryScope
  workspaceSlug?: string
  kind: MemoryKind
  title: string
  content: string
  tags: string[]
  source: MemorySource
  createdAt: number
  updatedAt: number
  revision: number
  archived: boolean
}

export interface MemoryRevision {
  memoryId: string
  revision: number
  operation: MemoryOperation
  snapshot: MemoryEntry
  createdAt: number
}

export type MemoryScopeFilter = MemoryScope | 'all'

export type MemoryKindFilter = MemoryKind | 'all'

export interface MemoryListResponse {
  entries: MemoryEntry[]
  total: number
  limit: number
}

export interface MemoryStats {
  userCount: number
  workspaceCount: number
  archivedCount: number
}

export interface MemoryCaptureInput {
  workspaceSlug?: string
  scope: MemoryScope
  kind: MemoryKind
  title: string
  content: string
  tags?: string[]
  source: MemorySource
}

export interface MemoryCaptureResponse {
  entry: MemoryEntry
  deduplicated: boolean
}

export interface MemoryRewriteInput {
  workspaceSlug?: string
  title?: string
  content?: string
  kind?: MemoryKind
  tags?: string[]
  expectedRevision: number
}

export interface MemoryRestoreInput {
  workspaceSlug?: string
  revision: number
}

export interface MemoryHistoryResponse {
  revisions: MemoryRevision[]
}

export interface MemoryRecallItem {
  id: string
  scope: MemoryScope
  workspaceSlug?: string
  kind: MemoryKind
  title: string
  excerpt: string
  tags: string[]
  updatedAt: number
  revision: number
}

export interface MemoryRecallResponse {
  entries: MemoryRecallItem[]
  total: number
  limit: number
}
