import type { BrowserPageSnapshot } from '@copis/shared'

/**
 * CDP 会话所有者类型
 */
export type BrowserCdpOwner = 'agent' | 'recording' | 'workflow'

/**
 * 允许在主进程内部调用的受控 CDP 方法白名单
 */
export type BrowserCdpMethod =
  | 'DOM.setFileInputFiles'
  | 'Input.dispatchKeyEvent'
  | 'Input.dispatchMouseEvent'
  | 'Input.insertText'
  | 'Page.addScriptToEvaluateOnNewDocument'
  | 'Page.captureScreenshot'
  | 'Page.createIsolatedWorld'
  | 'Page.enable'
  | 'Page.getFrameTree'
  | 'Page.handleJavaScriptDialog'
  | 'Page.removeScriptToEvaluateOnNewDocument'
  | 'Runtime.addBinding'
  | 'Runtime.enable'
  | 'Runtime.evaluate'
  | 'Runtime.releaseObject'
  | 'Runtime.removeBinding'

/**
 * 底层 CDP 目标适配器（由 web-tab-manager 提供，解耦 Electron）
 */
export interface BrowserCdpTarget {
  readonly identity: number
  isDestroyed(): boolean
  isAttached(): boolean
  getSnapshot(): BrowserPageSnapshot
  attach(): void
  detach(): void
  sendCommand(method: BrowserCdpMethod, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>
  onMessage(listener: (method: string, params: Record<string, unknown>, sessionId?: string) => void): () => void
  onDetach(listener: (reason: string) => void): () => void
  onDestroyed(listener: () => void): () => void
}

/**
 * 暴露给 Agent / Recording / Workflow 的窄接口端口
 */
export interface BrowserPagePort {
  readonly tabId: string
  readonly owner: BrowserCdpOwner
  readonly generation: number
  readonly documentEpoch: number
  getSnapshot(): BrowserPageSnapshot
  send(method: BrowserCdpMethod, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>
  onMessage(listener: (method: string, params: Record<string, unknown>, sessionId?: string) => void): () => void
  onDetached(listener: (reason: string) => void): () => void
  onDestroyed(listener: () => void): () => void
  release(): void
}

/**
 * 主进程 CDP 会话路由器接口
 */
export interface CdpSessionRouter {
  registerTarget(tabId: string, target: BrowserCdpTarget): void
  replaceTarget(tabId: string, target: BrowserCdpTarget): void
  unregisterTarget(tabId: string): void
  acquire(tabId: string, owner: BrowserCdpOwner): BrowserPagePort
  hasLease(tabId: string): boolean
  getLeaseCount(tabId: string): number
  onLeaseStateChange(tabId: string, listener: (active: boolean) => void): () => void
  dispose(): void
}
