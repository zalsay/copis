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
  /** 是否正在加载。 */
  isLoading: boolean
  /** 是否可以后退。 */
  canGoBack: boolean
  /** 是否可以前进。 */
  canGoForward: boolean
  /** 是否已在主进程中自动连接 Chrome DevTools Protocol。 */
  cdpAttached: boolean
}

/** 网页页签集合及当前激活项。 */
export interface WebTabsSnapshot {
  tabs: WebTabState[]
  activeTabId: string | null
}

/** 创建网页页签的参数。 */
export interface CreateWebTabInput {
  /** 初始地址，缺省为 about:blank。 */
  url?: string
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

/** 发送 CDP 命令的参数。 */
export interface SendWebTabCdpCommandInput {
  tabId: string
  method: string
  params?: Record<string, unknown>
}

/** 网页页签相关 IPC 通道。 */
export const WEB_IPC_CHANNELS = {
  LIST: 'web-tabs:list',
  CREATE: 'web-tabs:create',
  ACTIVATE: 'web-tabs:activate',
  CLOSE: 'web-tabs:close',
  NAVIGATE: 'web-tabs:navigate',
  UPDATE_BOUNDS: 'web-tabs:update-bounds',
  GO_BACK: 'web-tabs:go-back',
  GO_FORWARD: 'web-tabs:go-forward',
  RELOAD: 'web-tabs:reload',
  SEND_CDP_COMMAND: 'web-tabs:send-cdp-command',
  STATE_CHANGED: 'web-tabs:state-changed',
} as const

/** 网页页签 IPC 通道类型。 */
export type WebIpcChannel = (typeof WEB_IPC_CHANNELS)[keyof typeof WEB_IPC_CHANNELS]
