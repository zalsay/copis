/**
 * 网页保存密码与自动填充相关类型与 IPC 通道
 */

/** 数据库中脱敏展示的密码凭据项（不含明文密码） */
export interface WebPasswordEntry {
  id: string
  originUrl: string
  username: string
  passwordMasked: string
  signonRealm?: string
  actionUrl?: string
  usernameElement?: string
  passwordElement?: string
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
  useCount: number
}

/** 包含解密后明文的密码凭据项（仅在内部自动填充或用户显式解密时使用） */
export interface WebPasswordEntryWithSecret extends WebPasswordEntry {
  passwordPlain: string
}

/** 密码保存 / 更新请求提示信息 */
export interface WebPasswordSavePrompt {
  id: string
  tabId: string
  originUrl: string
  username: string
  passwordPlain: string
  isUpdate: boolean
  existingEntryId?: string
  title?: string
  faviconUrl?: string
  actionUrl?: string
  usernameElement?: string
  passwordElement?: string
}

/** 提示响应动作 */
export type WebPasswordPromptAction = 'save' | 'never' | 'dismiss'

export interface WebPasswordPromptResolveInput {
  promptId: string
  action: WebPasswordPromptAction
  username?: string
  passwordPlain?: string
}

/** 从不保存密码的网站（黑名单）项 */
export interface WebPasswordDisabledOrigin {
  id: string
  originUrl: string
  createdAt: number
}

/** 密码管理器通用设置 */
export interface WebPasswordSettings {
  offerToSavePasswords: boolean
  autoFillPasswords: boolean
}

/** 密码保存与自动填充相关 IPC 通道定义 */
export const WEB_PASSWORD_IPC_CHANNELS = {
  // 凭据查询与 CRUD
  LIST: 'web-passwords:list',
  GET_BY_ORIGIN: 'web-passwords:get-by-origin',
  REVEAL: 'web-passwords:reveal',
  SAVE_OR_UPDATE: 'web-passwords:save-or-update',
  REMOVE: 'web-passwords:remove',

  // 提示交互
  GET_ACTIVE_PROMPT: 'web-passwords:get-active-prompt',
  RESOLVE_PROMPT: 'web-passwords:resolve-prompt',
  PROMPT_CHANGED: 'web-passwords:prompt-changed',

  // 从不保存此网站（黑名单）
  LIST_DISABLED_ORIGINS: 'web-passwords:list-disabled-origins',
  ADD_DISABLED_ORIGIN: 'web-passwords:add-disabled-origin',
  REMOVE_DISABLED_ORIGIN: 'web-passwords:remove-disabled-origin',

  // 自动填充
  FILL_CREDENTIALS: 'web-passwords:fill-credentials',

  // 设置
  GET_SETTINGS: 'web-passwords:get-settings',
  UPDATE_SETTINGS: 'web-passwords:update-settings',
} as const

export type WebPasswordIpcChannel =
  (typeof WEB_PASSWORD_IPC_CHANNELS)[keyof typeof WEB_PASSWORD_IPC_CHANNELS]
