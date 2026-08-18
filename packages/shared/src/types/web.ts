/**
 * 内嵌 Chromium 网页页签类型与 IPC 通道。
 */

/** 单个内嵌网页的可展示状态。 */
export interface WebTabState {
  /** 页签唯一 ID。 */
  id: string
  /** 页签标题，优先使用网页 title。 */
  title: string
  /** 当前主框架 URL。 */
  url: string
  /** 网页 favicon 地址；没有可用 favicon 时为 null。 */
  faviconUrl: string | null
  /** 是否正在加载。 */
  isLoading: boolean
  /** 是否可以后退。 */
  canGoBack: boolean
  /** 是否可以前进。 */
  canGoForward: boolean
  /** 是否为无痕页签。 */
  isIncognito: boolean
  /** 是否可以将当前空白页签切换为无痕页签。 */
  canActivateIncognito: boolean
}

/** 网页页签集合及当前激活项。 */
export interface WebTabsSnapshot {
  tabs: WebTabState[]
  activeTabId: string | null
}

/** 单个网页收藏分组。 */
export interface WebBookmarkGroup {
  id: string
  name: string
  createdAt: number
}

/** 单个网页收藏。 */
export interface WebBookmark {
  id: string
  title: string
  url: string
  /** 收藏时网页提供的 favicon 地址；没有可用图标时为 null。 */
  faviconUrl: string | null
  createdAt: number
  /** 所属分组；null 表示未分组。 */
  groupId: string | null
}

/** 网页收藏夹快照。 */
export interface WebBookmarksSnapshot {
  groups: WebBookmarkGroup[]
  bookmarks: WebBookmark[]
}

/** 页面与 Agent 项目的持久化关联。 */
export interface WebPageProjectAssociation {
  /** 规范化后的 HTTP(S) 页面地址。 */
  url: string
  /** AgentWorkspace ID。 */
  workspaceId: string
  /** 最近一次关联时间戳。 */
  updatedAt: number
}

/** 保存页面与 Agent 项目关联的参数。 */
export interface SaveWebPageProjectAssociationInput {
  url: string
  workspaceId: string
}

/** 保存网页收藏的参数。 */
export interface SaveWebBookmarkInput {
  title: string
  url: string
  /** 网页 favicon 地址；未传时保留已有收藏的图标，null 表示清除。 */
  faviconUrl?: string | null
  /** 未传时保留已有收藏的分组；null 表示移动到未分组。 */
  groupId?: string | null
}

/** 创建网页收藏分组的参数。 */
export interface CreateWebBookmarkGroupInput {
  name: string
}

/** 重命名网页收藏分组的参数。 */
export interface RenameWebBookmarkGroupInput {
  groupId: string
  name: string
}

/** 创建网页页签的参数。 */
export interface CreateWebTabInput {
  /** 初始地址，缺省为 about:blank。 */
  url?: string
  /** 主进程内部可选的 Chromium Session partition；Renderer 输入会被主进程校验。 */
  partition?: string
  /** 是否创建使用临时 Session 的无痕页签。 */
  incognito?: boolean
  /** 是否创建后立即激活，缺省为 true。 */
  activate?: boolean
}

/** 网页导航参数。 */
export interface NavigateWebTabInput {
  tabId: string
  url: string
}

/** 原生 WebContentsView 的窗口坐标。 */
export interface WebTabBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 更新原生网页视图尺寸的参数。 */
export interface UpdateWebTabBoundsInput {
  tabId: string
  bounds: WebTabBounds
}

/** 打开收藏夹浮层窗口的参数。 */
export interface OpenWebBookmarksWindowInput {
  bounds: WebTabBounds
}

/** 调整收藏夹浮层窗口尺寸的参数。 */
export interface ResizeWebBookmarksWindowInput {
  width: number
  height: number
}

/** 网页页签相关 IPC 通道。 */
export const WEB_IPC_CHANNELS = {
  LIST: 'web-tabs:list',
  CREATE: 'web-tabs:create',
  ACTIVATE: 'web-tabs:activate',
  INCOGNITO_ACTIVATE: 'web-tabs:incognito-activate',
  CLOSE: 'web-tabs:close',
  NAVIGATE: 'web-tabs:navigate',
  UPDATE_BOUNDS: 'web-tabs:update-bounds',
  BOOKMARKS_WINDOW_OPEN: 'web-bookmarks:window-open',
  BOOKMARKS_WINDOW_CLOSE: 'web-bookmarks:window-close',
  BOOKMARKS_WINDOW_RESIZE: 'web-bookmarks:window-resize',
  GO_BACK: 'web-tabs:go-back',
  GO_FORWARD: 'web-tabs:go-forward',
  RELOAD: 'web-tabs:reload',
  STATE_CHANGED: 'web-tabs:state-changed',
  BOOKMARKS_LIST: 'web-bookmarks:list',
  BOOKMARKS_SAVE: 'web-bookmarks:save',
  BOOKMARKS_REMOVE: 'web-bookmarks:remove',
  BOOKMARK_GROUP_CREATE: 'web-bookmarks:group-create',
  BOOKMARK_GROUP_RENAME: 'web-bookmarks:group-rename',
  BOOKMARK_GROUP_REMOVE: 'web-bookmarks:group-remove',
  PROJECT_ASSOCIATION_GET: 'web-tabs:project-association-get',
  PROJECT_ASSOCIATION_SAVE: 'web-tabs:project-association-save',
} as const

/** 网页页签 IPC 通道类型。 */
export type WebIpcChannel = (typeof WEB_IPC_CHANNELS)[keyof typeof WEB_IPC_CHANNELS]
