/** Copis Memory 长期记忆的共享数据契约。 */

export type MemoryScope = 'user' | 'workspace'

export type MemoryKind = 'fact' | 'preference' | 'decision' | 'project' | 'scratch'

export type MemorySource = 'agent' | 'user' | 'import'

export type MemoryOperation = 'capture' | 'rewrite' | 'restore' | 'archive' | 'promote' | 'consolidate'

export type MemoryPolicy = 'off' | 'visible' | 'writable'

export const DEFAULT_MEMORY_POLICY: MemoryPolicy = 'writable'

export function normalizeMemoryPolicy(value: unknown, fallback: MemoryPolicy = DEFAULT_MEMORY_POLICY): MemoryPolicy {
  return value === 'off' || value === 'visible' || value === 'writable' ? value : fallback
}

export function normalizeOptionalMemoryPolicy(value: unknown): MemoryPolicy | undefined {
  return value === 'off' || value === 'visible' || value === 'writable' ? value : undefined
}

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
  capturedAt: number
  revision: number
  archived: boolean
  expiresAt?: number
}

export interface MemoryRevision {
  memoryId: string
  revision: number
  operation: MemoryOperation
  snapshot: MemoryEntry
  createdAt: number
  author?: string
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

export type MemoryExportScope = 'current-workspace' | 'all-workspaces' | 'user'

export type MemoryExportFormat = 'json' | 'markdown'

export interface MemoryExportInput {
  scope: MemoryExportScope
  workspaceSlug?: string
  workspaceNames?: Record<string, string>
  format: MemoryExportFormat
  includeArchived: boolean
  includeHistory: boolean
}

export interface MemoryExportResponse {
  fileName: string
  mimeType: 'application/json' | 'text/markdown'
  content: string
  entryCount: number
  revisionCount: number
}

export interface MemoryExportFileInput {
  fileName: string
  mimeType: MemoryExportResponse['mimeType']
  content: string
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

export interface MemoryRecallInput {
  workspaceSlug?: string
  query: string
  limit?: number
}

export interface MemoryContextInput {
  workspaceSlug?: string
  query?: string
  maxChars?: number
}

export interface MemoryContextResponse {
  text: string
  entries: MemoryRecallItem[]
  generatedAt: number
}

export interface MemoryCaptureBatchInput {
  workspaceSlug: string
  items: Array<Pick<MemoryCaptureInput, 'kind' | 'title' | 'content' | 'tags'>>
}

export interface MemoryCaptureBatchResponse {
  entries: MemoryEntry[]
  added: number
  deduplicated: number
}

export type MemoryMaintenanceAction =
  | { operation: 'promote'; id: string; expectedRevision: number; kind: Exclude<MemoryKind, 'scratch'> }
  | { operation: 'rewrite'; id: string; expectedRevision: number; title?: string; content?: string; tags?: string[]; kind?: MemoryKind }
  | { operation: 'archive'; id: string; expectedRevision: number }
  | { operation: 'capture'; kind: Exclude<MemoryKind, 'scratch'>; title: string; content: string; tags: string[] }

export interface MemoryMaintenanceApplyInput {
  workspaceSlug: string
  expectedCaptureCount: number
  actions: MemoryMaintenanceAction[]
}

export interface MemoryMaintenanceState {
  workspaceSlug: string
  captureCount: number
  lastConsolidatedCaptureCount: number
  lastPromotedAt?: number
  lastCleanupAt?: number
}

export interface MemoryMaintenanceApplyResponse {
  entries: MemoryEntry[]
  state: MemoryMaintenanceState
}

export interface MemoryImportItemInput {
  kind: MemoryKind
  title: string
  content: string
  tags?: string[]
}

export interface MemoryImportInput {
  scope: MemoryScope
  workspaceSlug?: string
  items: MemoryImportItemInput[]
}

export interface MemoryImportResponse {
  entries: MemoryEntry[]
  imported: number
  deduplicated: number
  total: number
}
