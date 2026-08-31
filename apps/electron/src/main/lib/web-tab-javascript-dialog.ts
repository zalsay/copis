import { dialog, type BrowserWindow } from 'electron'
import { showWebJavascriptPromptWindow } from './web-tab-javascript-prompt-window'

export type JavascriptDialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload'

export interface JavascriptDialogOpeningInput {
  type: JavascriptDialogType
  message: string
  defaultPrompt?: string
}

export interface JavascriptDialogResult {
  accept: boolean
  promptText?: string
}

export interface JavascriptDialogPresenter {
  present(input: JavascriptDialogOpeningInput, signal?: AbortSignal): Promise<JavascriptDialogResult>
}

interface CdpDebuggerLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
  isAttached?: () => boolean
  attach?: (version?: string) => void
  sendCommand?: (method: string, params?: Record<string, unknown>) => Promise<unknown>
}

export interface WebTabJavascriptDialogBridgeInput {
  hostWindow?: BrowserWindow | null
  debugger: CdpDebuggerLike
  /** 使用网页页签管理器的 attachCdp，确保与其它主进程 CDP 使用者共享连接。 */
  attach?: () => void | Promise<void>
  /** 使用网页页签管理器的 sendCommand，或直接传入 debugger.sendCommand。 */
  sendCommand?: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  /** 可选的统一 CDP 消息订阅；未提供时直接订阅 debugger。 */
  subscribe?: (listener: (method: string, params: Record<string, unknown>) => void) => () => void
  /** 可选的网页页签管理器 detach 订阅。 */
  subscribeDetach?: (listener: (reason: string) => void) => () => void
  /** WebContentsView 销毁状态；销毁后不再向 debugger 发送命令。 */
  isDestroyed?: () => boolean
  presenter?: JavascriptDialogPresenter
}

export interface WebTabJavascriptDialogBridge {
  start(): Promise<void>
  dispose(): void
}

interface PendingDialog {
  cancel: Promise<JavascriptDialogResult>
  cancelResolve: (result: JavascriptDialogResult) => void
  abortController: AbortController
  settled: boolean
  chromiumOutstanding: boolean
}

function isDialogType(value: unknown): value is JavascriptDialogType {
  return value === 'alert' || value === 'confirm' || value === 'prompt' || value === 'beforeunload'
}

function normalizeDialogInput(params: Record<string, unknown>): JavascriptDialogOpeningInput | null {
  if (!isDialogType(params.type)) return null
  return {
    type: params.type,
    message: String(params.message ?? ''),
    ...(params.defaultPrompt !== undefined ? { defaultPrompt: String(params.defaultPrompt) } : {}),
  }
}

function isUsableHostWindow(window: BrowserWindow | null | undefined): window is BrowserWindow {
  return Boolean(window && !window.isDestroyed() && !window.webContents.isDestroyed())
}

/** 主窗口关联的默认网页 JavaScript 对话框呈现器。 */
export function createDefaultJavascriptDialogPresenter(hostWindow: BrowserWindow | null | undefined): JavascriptDialogPresenter {
  return {
    async present(input, signal): Promise<JavascriptDialogResult> {
      if (input.type === 'prompt') {
        if (!isUsableHostWindow(hostWindow)) return { accept: false }
        return showWebJavascriptPromptWindow({
          hostWindow,
          message: input.message,
          defaultPrompt: input.defaultPrompt,
          signal,
        })
      }

      if (!isUsableHostWindow(hostWindow)) return { accept: false }
      const isAlert = input.type === 'alert'
      try {
        const response = await dialog.showMessageBox(hostWindow, {
          type: isAlert ? 'info' : 'question',
          title: input.type === 'beforeunload' ? '网页离开确认' : '网页提示',
          message: input.message,
          buttons: isAlert ? ['确定'] : ['取消', '确定'],
          defaultId: isAlert ? 0 : 1,
          cancelId: isAlert ? 0 : 0,
        })
        return { accept: isAlert || response.response === 1 }
      } catch (error) {
        console.warn('[网页对话框] 显示原生消息框失败:', error)
        return { accept: false }
      }
    },
  }
}

/**
 * 将 Chromium Page.javascriptDialogOpening 事件桥接到主进程原生窗口。
 * 一个 WebContents 的事件严格按到达顺序串行呈现，释放时所有未完成项都取消。
 */
export function createWebTabJavascriptDialogBridge(input: WebTabJavascriptDialogBridgeInput): WebTabJavascriptDialogBridge {
  const presenter = input.presenter ?? createDefaultJavascriptDialogPresenter(input.hostWindow)
  const pending = new Set<PendingDialog>()
  let disposed = false
  let started = false
  let startPromise: Promise<void> | undefined
  let queue = Promise.resolve()
  let removeMessageListener: (() => void) | undefined
  let removeDetachListener: (() => void) | undefined
  let reconnectPromise: Promise<void> | undefined
  let detachGeneration = 0
  let pendingDismissal: { generation: number; item: PendingDialog } | undefined
  // pending 包含尚未走完本地 Promise 的项，只有该引用代表 Chromium 当前暂停的 dialog。
  let chromiumOutstanding: PendingDialog | undefined

  const isDestroyed = (): boolean => Boolean(input.isDestroyed?.())

  const sendCommand = async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (disposed || isDestroyed()) throw new Error('网页对话框 WebContents 已销毁')
    if (input.sendCommand) return params === undefined ? input.sendCommand(method) : input.sendCommand(method, params)
    if (!input.debugger.sendCommand) throw new Error('网页 CDP sendCommand 不可用')
    return params === undefined ? input.debugger.sendCommand(method) : input.debugger.sendCommand(method, params)
  }

  const attach = async (): Promise<void> => {
    if (disposed || isDestroyed()) return
    if (input.attach) {
      await input.attach()
    } else if (input.debugger.isAttached && !input.debugger.isAttached()) {
      input.debugger.attach?.('1.3')
    }
  }

  const enablePage = async (): Promise<boolean> => {
    if (disposed || isDestroyed()) return false
    try {
      await attach()
      if (disposed || isDestroyed()) return false
      await sendCommand('Page.enable')
      return true
    } catch (error) {
      if (!disposed && !isDestroyed()) console.warn('[网页对话框] 启用 CDP Page 域失败:', error)
      return false
    }
  }

  const cancelPending = (): void => {
    for (const item of pending) {
      if (item.settled) continue
      item.settled = true
      item.abortController.abort()
      item.cancelResolve({ accept: false })
    }
  }

  const processDialog = async (opening: JavascriptDialogOpeningInput, item: PendingDialog): Promise<void> => {
    if (item.settled || disposed || isDestroyed()) {
      pending.delete(item)
      return
    }
    if (!chromiumOutstanding) {
      item.chromiumOutstanding = true
      chromiumOutstanding = item
    }
    try {
      const presented = await Promise.race([
        presenter.present(opening, item.abortController.signal).catch((error) => {
          if (!disposed && !isDestroyed()) console.warn('[网页对话框] 呈现原生窗口失败:', error)
          return { accept: false } satisfies JavascriptDialogResult
        }),
        item.cancel,
      ])
      if (item.settled || disposed || isDestroyed()) return
      const params: Record<string, unknown> = { accept: presented.accept }
      if (opening.type === 'prompt' && presented.accept) params.promptText = presented.promptText ?? ''
      item.chromiumOutstanding = false
      if (chromiumOutstanding === item) chromiumOutstanding = undefined
      try {
        await sendCommand('Page.handleJavaScriptDialog', params)
      } catch (error) {
        if (!disposed && !isDestroyed()) console.warn('[网页对话框] 回传对话框结果失败:', error)
      }
    } finally {
      pending.delete(item)
    }
  }

  const onMessage = (method: unknown, params: unknown): void => {
    if (disposed || method !== 'Page.javascriptDialogOpening' || !params || typeof params !== 'object') return
    const raw = params as Record<string, unknown>
    if (raw.hasBrowserHandler === true) return
    const opening = normalizeDialogInput(raw)
    if (!opening) return

    let cancelResolve: (result: JavascriptDialogResult) => void = () => undefined
    const cancel = new Promise<JavascriptDialogResult>((resolve) => { cancelResolve = resolve })
    const item: PendingDialog = {
      cancel,
      cancelResolve,
      abortController: new AbortController(),
      settled: false,
      chromiumOutstanding: false,
    }
    if (chromiumOutstanding?.settled) {
      chromiumOutstanding.chromiumOutstanding = false
      chromiumOutstanding = undefined
    }
    if (!chromiumOutstanding) {
      item.chromiumOutstanding = true
      chromiumOutstanding = item
    }
    pending.add(item)
    queue = queue.then(() => processDialog(opening, item)).catch((error) => {
      if (!disposed && !isDestroyed()) console.warn('[网页对话框] 处理 CDP 对话框失败:', error)
      pending.delete(item)
    })
  }

  const onDetach = (_reason?: string): void => {
    if (disposed) return
    const generation = ++detachGeneration
    const outstanding = chromiumOutstanding?.chromiumOutstanding ? chromiumOutstanding : undefined
    if (pendingDismissal) {
      pendingDismissal = { ...pendingDismissal, generation }
    } else if (outstanding) {
      pendingDismissal = { generation, item: outstanding }
    }
    cancelPending()
    if (reconnectPromise) return

    let chain: Promise<void>
    chain = Promise.resolve().then(async () => {
      if (!await enablePage()) return
      const dismissal = pendingDismissal
      pendingDismissal = undefined
      if (!dismissal || dismissal.generation !== detachGeneration) return
      if (disposed || isDestroyed()) return
      dismissal.item.chromiumOutstanding = false
      if (chromiumOutstanding === dismissal.item) chromiumOutstanding = undefined
      try {
        await sendCommand('Page.handleJavaScriptDialog', { accept: false })
      } catch (error) {
        if (!disposed && !isDestroyed()) console.warn('[网页对话框] 重连后拒绝 CDP 对话框失败:', error)
      }
    }).catch((error) => {
      if (!disposed && !isDestroyed()) console.warn('[网页对话框] CDP 断开后重连失败:', error)
    }).finally(() => {
      if (reconnectPromise === chain) reconnectPromise = undefined
    })
    reconnectPromise = chain
  }

  const subscribe = (): void => {
    if (input.subscribe) {
      removeMessageListener = input.subscribe(onMessage)
    } else {
      const listener = (...args: unknown[]): void => onMessage(args[1], args[2])
      input.debugger.on('message', listener)
      removeMessageListener = () => input.debugger.removeListener('message', listener)
    }
    if (input.subscribeDetach) {
      removeDetachListener = input.subscribeDetach(onDetach)
    } else {
      const listener = (...args: unknown[]): void => onDetach(String(args[1] ?? args[0] ?? ''))
      input.debugger.on('detach', listener)
      removeDetachListener = () => input.debugger.removeListener('detach', listener)
    }
  }

  return {
    async start(): Promise<void> {
      if (disposed) return
      if (started) return startPromise
      started = true
      subscribe()
      startPromise = enablePage().then(() => undefined)
      await startPromise
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      removeMessageListener?.()
      removeDetachListener?.()
      removeMessageListener = undefined
      removeDetachListener = undefined
      cancelPending()
    },
  }
}
