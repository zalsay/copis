import { app, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { WebJavascriptPromptRequest, WebJavascriptPromptResolveInput } from '@copis/shared'

export interface ShowWebJavascriptPromptWindowInput {
  hostWindow: BrowserWindow
  message: string
  defaultPrompt?: string
  /** 仅取消本次 prompt，避免按宿主窗口误关其它网页页签的对话框。 */
  signal?: AbortSignal
}

export type WebJavascriptPromptResult = { accept: boolean; promptText?: string }

interface WebJavascriptPromptEnvironment {
  COPIS_DEV_SERVER_URL?: string
}

interface PendingPrompt {
  request: WebJavascriptPromptRequest
  senderId: number
  window: BrowserWindow
  resolve: (result: WebJavascriptPromptResult) => void
  cleanup: () => void
}

const pendingPrompts = new Map<string, PendingPrompt>()
const hostCleanup = new Map<BrowserWindow, () => void>()
const DEFAULT_DEV_SERVER_URL = 'http://127.0.0.1:5174'

function isUsableWindow(window: BrowserWindow | null | undefined): window is BrowserWindow {
  return Boolean(window && !window.isDestroyed() && !window.webContents.isDestroyed())
}

function getParentWindow(window: BrowserWindow): BrowserWindow | null {
  return typeof window.getParentWindow === 'function' ? window.getParentWindow() : null
}

function closePromptWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  try {
    window.close()
  } catch (error) {
    console.error('[网页 prompt] 关闭输入窗口失败:', error)
    if (!window.isDestroyed() && typeof window.destroy === 'function') {
      try {
        window.destroy()
      } catch (destroyError) {
        console.error('[网页 prompt] 销毁输入窗口失败:', destroyError)
      }
    }
  }
}

function cleanupHost(hostWindow: BrowserWindow): void {
  const cleanup = hostCleanup.get(hostWindow)
  if (!cleanup) return
  cleanup()
  hostCleanup.delete(hostWindow)
}

function settlePrompt(requestId: string, result: WebJavascriptPromptResult, closeWindow: boolean): boolean {
  const pending = pendingPrompts.get(requestId)
  if (!pending) return false
  pendingPrompts.delete(requestId)
  pending.cleanup()
  pending.resolve(result)
  if (closeWindow) closePromptWindow(pending.window)
  const parent = getParentWindow(pending.window)
  if (parent && ![...pendingPrompts.values()].some((item) => getParentWindow(item.window) === parent)) cleanupHost(parent)
  return true
}

function watchHost(hostWindow: BrowserWindow): void {
  if (hostCleanup.has(hostWindow)) return
  const cancelForHost = (): void => {
    for (const pending of [...pendingPrompts.values()]) {
      if (getParentWindow(pending.window) === hostWindow) {
        settlePrompt(pending.request.requestId, { accept: false }, true)
      }
    }
    cleanupHost(hostWindow)
  }
  hostWindow.on('closed', cancelForHost)
  hostWindow.webContents.on('destroyed', cancelForHost)
  hostCleanup.set(hostWindow, () => {
    hostWindow.removeListener('closed', cancelForHost)
    hostWindow.webContents.removeListener('destroyed', cancelForHost)
  })
}

export function resolveWebJavascriptPromptUrl(
  requestId: string,
  envSource: WebJavascriptPromptEnvironment | NodeJS.ProcessEnv = process.env,
): string {
  const url = new URL(envSource.COPIS_DEV_SERVER_URL ?? DEFAULT_DEV_SERVER_URL)
  url.searchParams.set('window', 'web-javascript-prompt')
  url.searchParams.set('requestId', requestId)
  return url.toString()
}

/** 创建由主窗口托管的最小权限 prompt 输入窗口。 */
export function showWebJavascriptPromptWindow(input: ShowWebJavascriptPromptWindowInput): Promise<WebJavascriptPromptResult> {
  const hostWindow = input.hostWindow
  if (!isUsableWindow(hostWindow) || input.signal?.aborted) return Promise.resolve({ accept: false })

  const requestId = randomUUID()
  let resolveResult: (result: WebJavascriptPromptResult) => void = () => undefined
  const result = new Promise<WebJavascriptPromptResult>((resolve) => { resolveResult = resolve })
  let promptWindow: BrowserWindow
  try {
    promptWindow = new BrowserWindow({
      parent: hostWindow,
      modal: true,
      show: false,
      width: 420,
      height: 220,
      resizable: false,
      webPreferences: {
        preload: join(__dirname, 'web-javascript-prompt-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
  } catch (error) {
    console.error('[网页 prompt] 创建输入窗口失败:', error)
    return Promise.resolve({ accept: false })
  }
  const request: WebJavascriptPromptRequest = {
    requestId,
    message: String(input.message ?? ''),
    defaultPrompt: String(input.defaultPrompt ?? ''),
  }
  let cleanupPromptListeners = (): void => undefined
  pendingPrompts.set(requestId, {
    request,
    senderId: promptWindow.webContents.id,
    window: promptWindow,
    resolve: resolveResult,
    cleanup: () => cleanupPromptListeners(),
  })
  watchHost(hostWindow)

  const cancel = (): void => { settlePrompt(requestId, { accept: false }, false) }
  const cancelAndClose = (): void => { settlePrompt(requestId, { accept: false }, true) }
  const onClosed = (): void => cancel()
  const onDidFailLoad = (): void => cancelAndClose()
  const onDestroyed = (): void => cancelAndClose()
  const onRenderProcessGone = (): void => cancelAndClose()
  const onAbort = (): void => cancelAndClose()
  let onPromptEntryNavigation: ((event: Electron.Event, url: string) => void) | undefined
  const onReadyToShow = (): void => {
    if (!pendingPrompts.has(requestId) || !isUsableWindow(promptWindow)) return
    promptWindow.show()
    promptWindow.focus()
  }
  promptWindow.on('closed', onClosed)
  promptWindow.on('ready-to-show', onReadyToShow)
  promptWindow.webContents.on('did-fail-load', onDidFailLoad)
  promptWindow.webContents.on('destroyed', onDestroyed)
  promptWindow.webContents.on('render-process-gone', onRenderProcessGone)
  promptWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  cleanupPromptListeners = (): void => {
    promptWindow.removeListener('closed', onClosed)
    promptWindow.removeListener('ready-to-show', onReadyToShow)
    promptWindow.webContents.removeListener('did-fail-load', onDidFailLoad)
    promptWindow.webContents.removeListener('destroyed', onDestroyed)
    promptWindow.webContents.removeListener('render-process-gone', onRenderProcessGone)
    if (onPromptEntryNavigation) {
      promptWindow.webContents.removeListener('will-navigate', onPromptEntryNavigation)
      promptWindow.webContents.removeListener('will-redirect', onPromptEntryNavigation)
    }
    input.signal?.removeEventListener('abort', onAbort)
  }

  if (input.signal?.aborted) {
    cancelAndClose()
  } else {
    input.signal?.addEventListener('abort', onAbort, { once: true })
  }

  try {
    const rendererPath = join(__dirname, 'renderer', 'index.html')
    const initialEntryUrl = app.isPackaged
      ? (() => {
          const url = pathToFileURL(rendererPath)
          url.searchParams.set('window', 'web-javascript-prompt')
          url.searchParams.set('requestId', requestId)
          return url.toString()
        })()
      : resolveWebJavascriptPromptUrl(requestId)
    onPromptEntryNavigation = (event, url): void => {
      if (url !== initialEntryUrl) event.preventDefault()
    }
    promptWindow.webContents.on('will-navigate', onPromptEntryNavigation)
    promptWindow.webContents.on('will-redirect', onPromptEntryNavigation)

    if (app.isPackaged) {
      void promptWindow.loadFile(rendererPath, {
        query: { window: 'web-javascript-prompt', requestId },
      }).catch(cancelAndClose)
    } else {
      void promptWindow.loadURL(initialEntryUrl).catch(cancelAndClose)
    }
  } catch (error) {
    console.error('[网页 prompt] 加载输入窗口失败:', error)
    cancelAndClose()
  }
  return result
}

/** 仅向创建该请求的 prompt 窗口返回请求数据。 */
export function getWebJavascriptPromptRequest(requestId: string, senderId: number): WebJavascriptPromptRequest | null {
  if (typeof requestId !== 'string' || !requestId) return null
  const pending = pendingPrompts.get(requestId)
  if (!pending || pending.senderId !== senderId || !isUsableWindow(pending.window)) return null
  return { ...pending.request }
}

/** 仅接受待处理且身份匹配的 prompt 结果。 */
export function resolveWebJavascriptPromptRequest(input: WebJavascriptPromptResolveInput, senderId: number): boolean {
  if (!input || typeof input.requestId !== 'string' || typeof input.accept !== 'boolean') return false
  const pending = pendingPrompts.get(input.requestId)
  if (!pending || pending.senderId !== senderId) return false
  return settlePrompt(input.requestId, {
    accept: input.accept,
    ...(input.accept ? { promptText: String(input.promptText ?? '') } : {}),
  }, true)
}

/** 取消仅允许由创建该请求的 prompt 窗口发起。 */
export function cancelWebJavascriptPromptRequest(requestId: string, senderId: number): boolean {
  const pending = pendingPrompts.get(requestId)
  if (!pending || pending.senderId !== senderId) return false
  return settlePrompt(requestId, { accept: false }, true)
}

/** 应用退出或宿主销毁时取消全部待处理请求。 */
export function disposeWebJavascriptPromptWindows(): void {
  for (const pending of [...pendingPrompts.values()]) settlePrompt(pending.request.requestId, { accept: false }, true)
  for (const hostWindow of [...hostCleanup.keys()]) cleanupHost(hostWindow)
}
