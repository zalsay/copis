export type InspectorTabKind = 'files' | 'side-chat' | 'team'

export interface InspectorTab {
  id: string
  kind: InspectorTabKind
  label: string
  title?: string
  closable?: boolean
  meta?: Record<string, any>
}

export interface TeamMemberInfo {
  id: string
  name: string
  role: 'lead' | 'expert' | 'worker'
  status: 'idle' | 'running' | 'ready' | 'failed'
  description?: string
  skills?: string[]
}

export interface TeamTaskInfo {
  id: string
  subject: string
  description?: string
  ownerName?: string
  status: 'completed' | 'in_progress' | 'pending'
  ready?: boolean
  blockedBy?: string[]
  writeScopes?: string[]
}

export interface SideChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  status?: 'pending' | 'streaming' | 'done' | 'error'
}

export interface DirectoryEntry {
  name: string
  path: string
  isDirectory: boolean
  size?: number
  extension?: string
}

export interface FilePreviewState {
  loading: boolean
  content: string
  error: string | null
  isImage: boolean
  imageUrl: string
  lineCount?: number
}
