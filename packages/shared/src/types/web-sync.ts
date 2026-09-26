/**
 * 浏览器收藏夹与页面 Profile 增量同步相关类型与 IPC 通道。
 */

/** 页面级个性化偏好 */
export interface WebPageDisplayPreferences {
  /** 页面缩放比例，如 1.0, 1.25 */
  zoomFactor?: number
  /** 阅读模式偏好 */
  readerMode?: 'auto' | 'enabled' | 'disabled'
  /** 针对该站点的注入样式 */
  customCss?: string
  /** 视图模拟模式 */
  deviceMode?: 'desktop' | 'mobile'
}

/** 页面级 AI 画像与上下文记忆 */
export interface WebPageAiContext {
  /** AI 提取的该网页核心摘要 */
  summary?: string
  /** 网页分类/知识标签，如 ["开发文档", "财务报告"] */
  tags?: string[]
  /** 提炼的关键要点列表 */
  keyInsights?: string[]
  /** 针对该域名/页面的专用 AI 系统指令 */
  customPrompt?: string
}

/** 网页 Profile 实体 */
export interface WebPageProfile {
  id: string
  /** 规范化后的完整页面 URL */
  url: string
  /** 域名/Host，支持跨页面层级匹配 */
  domain: string
  /** 关联绑定的 Copis Agent 项目 ID，null 表示未绑定 */
  workspaceId: string | null
  /** 页面展示与交互偏好 */
  preferences: WebPageDisplayPreferences
  /** AI 画像与上下文记忆 */
  aiContext: WebPageAiContext
  createdAt: number
  updatedAt: number
  version: number
  /** 墓碑标记：true 表示已被软删除 */
  isDeleted: boolean
  deletedAt?: number
}

/** 保存或更新网页 Profile 的输入参数 */
export interface SaveWebPageProfileInput {
  url: string
  workspaceId?: string | null
  preferences?: Partial<WebPageDisplayPreferences>
  aiContext?: Partial<WebPageAiContext>
}

/** 网页 Profile 快照 */
export interface WebPageProfilesSnapshot {
  profiles: WebPageProfile[]
}

/** 本地同步状态元数据 */
export interface WebSyncState {
  /** 当前本地存储/同步分区的稳定账号键；guest 为 null。 */
  accountId: string | null
  /** 同步生命周期状态；idle 表示尚未完成本次会话的同步判断。 */
  status: 'idle' | 'signed-out' | 'pending' | 'syncing' | 'synced' | 'error'
  /** 本地客户端唯一设备 ID */
  deviceId: string
  /** 客户端已确认的服务端增量游标（初始为 0） */
  serverCursor: number
  /** 上次成功同步时间戳 (ms) */
  lastSyncedAt: number
  /** 当前是否正在执行网络同步 */
  isSyncing: boolean
  /** 本地是否存在未同步的变更 */
  hasLocalChanges: boolean
  /** 上次同步错误信息，null 表示正常 */
  lastSyncError: string | null
}

/** 收藏分组变更项 */
export interface WebBookmarkGroupChange {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  version: number
  isDeleted: boolean
  deletedAt?: number
}

/** 收藏项变更项 */
export interface WebBookmarkChange {
  id: string
  title: string
  url: string
  faviconUrl: string | null
  groupId: string | null
  createdAt: number
  updatedAt: number
  version: number
  isDeleted: boolean
  deletedAt?: number
}

/** 页面 Profile 变更项 */
export interface WebPageProfileChange {
  id: string
  url: string
  domain: string
  workspaceId: string | null
  preferences: WebPageDisplayPreferences
  aiContext: WebPageAiContext
  createdAt: number
  updatedAt: number
  version: number
  isDeleted: boolean
  deletedAt?: number
}

/** 增量变更集合 */
export interface BrowserSyncChanges {
  groups: WebBookmarkGroupChange[]
  bookmarks: WebBookmarkChange[]
  pageProfiles: WebPageProfileChange[]
}

/** 浏览器增量同步请求 (客户端 -> 服务端) */
export interface BrowserSyncRequest {
  clientDeviceId: string
  clientCursor: number
  /** Rust 网关必须在捕获认证 token 的同一临界区验证该稳定用户 ID。 */
  expectedUserId: string
  changes: BrowserSyncChanges
}

/** 增量同步冲突记录 */
export interface SyncConflictRecord {
  entityType: 'group' | 'bookmark' | 'pageProfile'
  entityId: string
  resolution: 'client_wins' | 'server_wins' | 'merged'
  reason?: string
}

/** 浏览器增量同步响应 (服务端 -> 客户端) */
export interface BrowserSyncResponse {
  serverCursor: number
  hasMore?: boolean
  serverChanges: BrowserSyncChanges
  conflicts?: SyncConflictRecord[]
}

/** 浏览器同步相关 IPC 通道 */
export const WEB_SYNC_IPC_CHANNELS = {
  /** 触发立即同步 */
  SYNC_NOW: 'web-sync:sync-now',
  /** 获取当前同步状态 */
  GET_STATE: 'web-sync:get-state',
  /** 同步状态变更通知 */
  STATE_CHANGED: 'web-sync:state-changed',
  /** 获取全部活跃页面 Profile 列表 */
  PROFILES_LIST: 'web-page-profiles:list',
  /** 根据 URL 获取单个页面 Profile */
  PROFILE_GET: 'web-page-profiles:get',
  /** 保存单个页面 Profile */
  PROFILE_SAVE: 'web-page-profiles:save',
  /** 删除单个页面 Profile */
  PROFILE_REMOVE: 'web-page-profiles:remove',
} as const

export type WebSyncIpcChannel = (typeof WEB_SYNC_IPC_CHANNELS)[keyof typeof WEB_SYNC_IPC_CHANNELS]
