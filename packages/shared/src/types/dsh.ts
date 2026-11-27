/**
 * DeepSeek Harness (dsh) 与 Cordis 模式相关类型与 IPC 常量。
 */

export interface DshCordisStatus {
  running: boolean
  port?: number
  url?: string
  error?: string
}

export const DEFAULT_DSH_PINNED_MENU_IDS = ['search', 'schedule', 'automations'] as const

/** DSH RC2 原生展开侧栏的宽度区间，不含折叠栏。 */
export const DSH_SIDEBAR_MIN_WIDTH = 264
export const DSH_SIDEBAR_MAX_WIDTH = 420

export function isDshExpandedSidebarWidth(width: unknown): width is number {
  return typeof width === 'number' && width >= DSH_SIDEBAR_MIN_WIDTH && width <= DSH_SIDEBAR_MAX_WIDTH
}

export interface DshViewBounds {
  x: number
  y: number
  width: number
  height: number
  visible: boolean
}

export type DshClientEvent =
  | { type: 'COPIS_DSH_SESSION_COMPLETED'; sessionId: string; title: string; completionSeq: number; viewed: boolean; windowFocused: boolean }
  | { type: 'COPIS_DSH_SESSION_VIEWED'; sessionId: string }
  | { type: 'COPIS_NAVIGATE'; view: string; tab?: string }
  | { type: 'COPIS_SWITCH_MODE'; mode: string }
  | { type: 'COPIS_OPEN_SEARCH' }
  | { type: 'COPIS_OPEN_SETTINGS' }
  | { type: 'COPIS_OPEN_FEEDBACK' }
  | { type: 'COPIS_DSH_SIDEBAR_INFO'; width: number; wide?: boolean; collapsed?: boolean }
  | { type: 'COPIS_OPEN_SESSION'; sessionType: 'agent' | 'chat'; sessionId: string; title?: string }

export interface DshReadFileResult {
  success: boolean
  content?: string
  error?: string
  path?: string
  size?: number
  isImage?: boolean
  tooLarge?: boolean
  binary?: boolean
}

/** 媒体 URL 是短期单文件令牌，只驻留于预览组件内，不写入会话或设置。 */
export type DshMediaPreviewResult =
  | { success: true; url: string; kind: 'video' | 'audio'; mimeType: string }
  | { success: false; error: string }

export interface DshFileEntry {
  name: string
  path: string
  isDirectory: boolean
  size?: number
}

export const DSH_CORDIS_IPC_CHANNELS = {
  START: 'dsh-cordis:start',
  GET_STATUS: 'dsh-cordis:get-status',
  STOP: 'dsh-cordis:stop',
  RELOAD: 'dsh-cordis:reload',
  ON_STATUS_CHANGE: 'dsh-cordis:status-change',
  UPDATE_VIEW_BOUNDS: 'dsh-cordis:update-view-bounds',
  SET_VIEW_VISIBLE: 'dsh-cordis:set-view-visible',
  CLIENT_EVENT: 'dsh-cordis:client-event',
  DISPATCH_EVENT_TO_CLIENT: 'dsh-cordis:dispatch-to-client',
  READ_FILE: 'dsh-cordis:read-file',
  PREPARE_MEDIA_PREVIEW: 'dsh-cordis:prepare-media-preview',
  RELEASE_MEDIA_PREVIEW: 'dsh-cordis:release-media-preview',
  SHOW_ITEM_IN_FOLDER: 'dsh-cordis:show-item-in-folder',
  LIST_DIRECTORY: 'dsh-cordis:list-directory',
  GET_ACTIVE_WORKSPACE_PATH: 'dsh-cordis:get-active-workspace-path',
} as const

export type DshCordisIpcChannel = (typeof DSH_CORDIS_IPC_CHANNELS)[keyof typeof DSH_CORDIS_IPC_CHANNELS]



export const ROOM_ACTION_LABELS = { roster: '群智能体', copy: '复制分享码', leave: '退出群', dissolve: '解散群' } as const
export type RoomMenuAction = keyof typeof ROOM_ACTION_LABELS
export function roomMenuActions(role: 'host' | 'member' | null, shareCodeEnabled: boolean): RoomMenuAction[] {
  if (role === 'host') return shareCodeEnabled ? ['roster', 'copy', 'dissolve'] : ['roster', 'dissolve']
  return role === 'member' ? ['roster', 'leave'] : []
}

/** 给原生 DSH 侧栏的只读摘要；房间凭据、分享码和消息始终留在主窗口。 */
export interface DshRoomSidebarSnapshot {
  type: 'COPIS_SHARED_ROOM_SIDEBAR'
  epoch: number
  rooms: Array<{ id: string; name: string; actions: RoomMenuAction[] }>
  selected: string | null
  status: 'loading' | 'ready' | 'error' | 'signed-out'
  busy: boolean
}
