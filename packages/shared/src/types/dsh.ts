/**
 * DeepSeek Harness (dsh) 与 Cordis 模式相关类型与 IPC 常量。
 */

export interface DshCordisStatus {
  running: boolean
  port?: number
  url?: string
  error?: string
}

export interface DshViewBounds {
  x: number
  y: number
  width: number
  height: number
  visible: boolean
}

export type DshClientEvent =
  | { type: 'COPIS_NAVIGATE'; view: string; tab?: string }
  | { type: 'COPIS_SWITCH_MODE'; mode: string }
  | { type: 'COPIS_OPEN_SEARCH' }
  | { type: 'COPIS_OPEN_SETTINGS' }
  | { type: 'COPIS_OPEN_FEEDBACK' }
  | { type: 'COPIS_DSH_SIDEBAR_INFO'; width: number; wide?: boolean; collapsed?: boolean }

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
  SHOW_ITEM_IN_FOLDER: 'dsh-cordis:show-item-in-folder',
  LIST_DIRECTORY: 'dsh-cordis:list-directory',
} as const

export type DshCordisIpcChannel = (typeof DSH_CORDIS_IPC_CHANNELS)[keyof typeof DSH_CORDIS_IPC_CHANNELS]


