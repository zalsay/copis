import { app, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { WebJavascriptPromptRequest, WebJavascriptPromptResolveInput } from '@copis/shared'

export interface ShowWebJavascriptPromptWindowInput {
  hostWindow: BrowserWindow
  message: string
  defaultPrompt?: string
}

export type WebJavascriptPromptResult = { accept: boolean; promptText?: string }

interface PendingPrompt {
  request: WebJavascriptPromptRequest
  senderId: number
  window: BrowserWindow
  resolve: (result: WebJavascriptPromptResult) => void
}

const pendingPrompts = new Map<string, PendingPrompt>()
const hostCleanup = new Map<BrowserWindow, () => void>()

function isUsableWindow(window: BrowserWindow | null | undefined): window is BrowserWindow {
  return Boolean(window && !window.isDestroyed() && !window.webContents.isDestroyed())
}

function getParentWindow(window: BrowserWindow): BrowserWindow | null {
  return typeof window.getParentWindow === 'function' ? window.getParentWindow() : null
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
  pending.resolve(result)
  if (closeWindow && isUsableWindow(pending.window)) pending.window.close()
  const parent = getParentWindow(pending.window)
  if (parent && ![...pendingPrompts.values()].some((item) => getParentWindow(item.window) === parent)) cleanupHost(parent)
  return true
}

function watchHost(hostWindow: BrowserWindow): void {
  if (hostCleanup.has(hostWindow)) return
  const cancelForHost = (): void => {
    for (const pending of [...pendingPrompts.values()]) {
      if (getParentWindow(pending.window) === hostWindow) {
        settlePrompt(pending.request.requestId, { accept: false }, false)
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

function getPromptUrl(requestId: string): string {
  return `http://127.0.0.1:5174/?window=web-javascript-prompt&requestId=${encodeURIComponent(requestId)}`
}

/** 创建由主窗口托管的最小权限 prompt 输入窗口。 */
export function showWebJavascriptPromptWindow(input: ShowWebJavascriptPromptWindowInput): Promise<WebJavascriptPromptResult> {
  const hostWindow = input.hostWindow
  if (!isUsableWindow(hostWindow)) return Promise.resolve({ accept: false })

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
  pendingPrompts.set(requestId, { request, senderId: promptWindow.webContents.id, window: promptWindow, resolve: resolveResult })
  watchHost(hostWindow)

  const cancel = (): void => { settlePrompt(requestId, { accept: false }, false) }
  const cancelAndClose = (): void => { settlePrompt(requestId, { accept: false }, true) }
  promptWindow.once('closed', cancel)
  promptWindow.webContents.on('did-fail-load', cancelAndClose)
  promptWindow.once('ready-to-show', () => {
    if (!pendingPrompts.has(requestId) || !isUsableWindow(promptWindow)) return
    promptWindow.show()
    promptWindow.focus()
  })

  try {
    if (app.isPackaged) {
      void promptWindow.loadFile(join(__dirname, 'renderer', 'index.html'), {
        query: { window: 'web-javascript-prompt', requestId },
      }).catch(cancelAndClose)
    } else {
      void promptWindow.loadURL(getPromptUrl(requestId)).catch(cancelAndClose)
    }
  } catch (error) {
    console.error('[网页 prompt] 加载输入窗口失败:', error)
    cancel()
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
