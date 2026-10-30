/**
 * 内置 Chrome 工具的会话与授权层。
 * 原生截图、坐标、焦点与输入统一由可更新的 Rust + Swift 组件负责。
 */
import { createHash, randomUUID } from 'node:crypto'
import type {
  ChromeDesktopBounds, ChromeDesktopErrorCode, ChromeDesktopFrameMeta,
  ChromeDesktopSessionState, ChromeDesktopState, ChromeDesktopMode,
  ChromeDesktopSystemStatus, ChromeDesktopToolName, ChromeDesktopToolRequest,
  ChromeDesktopToolResponse, ChromeDesktopWindowInfo,
} from '@copis/shared'
import { CHROME_DESKTOP_ALLOWED_KEYS, CHROME_DESKTOP_DEFAULT_SHORTCUT, isRecoverableChromeDesktopPauseReason, retainsChromeDesktopAuthorization } from '@copis/shared'
import { ChromeDesktopComponentClient, type ChromeDesktopBackend, type ChromeDesktopComponentAction } from './chrome-desktop-component-client'
import { isValidChromeDesktopFilePath } from './chrome-desktop-file-path'

export const MAX_ACTION_HISTORY_SIZE = 50
export const ACTION_HISTORY_TTL_MS = 5 * 60 * 1000
const MAX_CONTROL_FRAMES = 32
const USER_PAUSED_TERMINAL_ERRORS = new Set<ChromeDesktopErrorCode>([
  'CHROME_WINDOW_UNAVAILABLE', 'CHROME_HELPER_FAILED', 'CHROME_ACTION_UNCERTAIN', 'CHROME_CANCELLED',
])

export interface ChromeDesktopServiceDependencies {
  componentClient?: ChromeDesktopBackend
  registerGlobalShortcut?: (shortcut: string, callback: () => void) => boolean
  unregisterGlobalShortcut?: (shortcut: string) => void
  setBackgroundThrottling?: (enabled: boolean) => void
  onStateChanged?: (state: ChromeDesktopSessionState) => void
}
interface CachedActionEntry {
  toolName: ChromeDesktopToolName
  inputHash: string
  response: ChromeDesktopToolResponse
  timestamp: number
}
interface ActiveControlRecord {
  controlId: string
  sessionId: string
  capabilityToken: string
  state: ChromeDesktopState
  mode: ChromeDesktopMode
  createdAt: number
  toolCallId: string
  targetWindow: ChromeDesktopWindowInfo | null
  geometryVersion: number
  frames: Map<string, ChromeDesktopFrameMeta>
  inFlightAction: boolean
  pauseReason?: ChromeDesktopErrorCode
  errorMessage?: string
  shortcut: string
  authorizationTimer?: ReturnType<typeof setTimeout>
  seenObserveToolCallIds: Set<string>
  latestObservedFrame?: { toolCallId: string; inputHash: string; response: ChromeDesktopToolResponse }
}
function sameBounds(left: ChromeDesktopBounds, right: ChromeDesktopBounds): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
}
function errorCode(error: unknown, fallback: ChromeDesktopErrorCode): ChromeDesktopErrorCode {
  const code = error instanceof Error ? error.message.match(/^(CHROME_[A-Z_]+)(?=:|$)/)?.[1] : undefined
  return (code ?? fallback) as ChromeDesktopErrorCode
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'Chrome 组件调用失败' }

export class ChromeDesktopService {
  private readonly backend: ChromeDesktopBackend
  private readonly registerShortcutFn: (shortcut: string, callback: () => void) => boolean
  private readonly unregisterShortcutFn: (shortcut: string) => void
  private readonly setThrottlingFn: (enabled: boolean) => void
  private stateChangedListener?: (state: ChromeDesktopSessionState) => void
  private activeControl: ActiveControlRecord | null = null
  private readonly actionHistory = new Map<string, CachedActionEntry>()
  private releasePromise: Promise<void> = Promise.resolve()
  private pendingRelease?: { record: ActiveControlRecord; operation: Promise<void> }

  constructor(deps: ChromeDesktopServiceDependencies = {}) {
    this.backend = deps.componentClient ?? new ChromeDesktopComponentClient()
    this.registerShortcutFn = deps.registerGlobalShortcut ?? this.defaultRegisterShortcut
    this.unregisterShortcutFn = deps.unregisterGlobalShortcut ?? this.defaultUnregisterShortcut
    this.setThrottlingFn = deps.setBackgroundThrottling ?? this.defaultSetBackgroundThrottling
    this.stateChangedListener = deps.onStateChanged
  }
  private defaultRegisterShortcut(shortcut: string, callback: () => void): boolean {
    if (!process.versions?.electron) return true
    try { return require('electron').globalShortcut.register(shortcut, callback) } catch { return false }
  }
  private defaultUnregisterShortcut(shortcut: string): void {
    if (process.versions?.electron) { try { require('electron').globalShortcut.unregister(shortcut) } catch {} }
  }
  private defaultSetBackgroundThrottling(enabled: boolean): void {
    if (process.versions?.electron) {
      try {
        for (const window of require('electron').BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.setBackgroundThrottling(enabled)
        }
      } catch {}
    }
  }
  setStateChangedListener(listener: (state: ChromeDesktopSessionState) => void): void { this.stateChangedListener = listener }
  private broadcastState(record?: ActiveControlRecord): void {
    const state = record ? this.sessionState(record) : this.getSessionState()
    if (state) this.stateChangedListener?.(state)
  }
  getSessionState(): ChromeDesktopSessionState | null {
    const failedRelease = this.pendingRelease?.record.state === 'error' ? this.pendingRelease.record : null
    const record = this.activeControl ?? failedRelease
    return record ? this.sessionState(record) : null
  }
  private sessionState(record: ActiveControlRecord): ChromeDesktopSessionState {
    return {
      controlId: record.controlId, sessionId: record.sessionId, state: record.state, mode: record.mode,
      targetWindow: record.targetWindow, pauseReason: record.pauseReason, errorMessage: record.errorMessage,
      shortcut: record.shortcut, createdAt: record.createdAt,
    }
  }
  getPendingCaptureTarget(): { controlId: string; windowId: number; pid: number } | null {
    const record = this.activeControl
    return record && ['awaiting_user', 'starting', 'active'].includes(record.state) && record.targetWindow
      ? { controlId: record.controlId, windowId: record.targetWindow.windowId, pid: record.targetWindow.pid } : null
  }
  hasPendingCapture(): boolean { return this.getPendingCaptureTarget() !== null }
  async checkSystemStatus(): Promise<ChromeDesktopSystemStatus> {
    const base = { visionModelSupported: true, shortcut: CHROME_DESKTOP_DEFAULT_SHORTCUT }
    if (process.platform !== 'darwin') return { ...base, supported: false, screenRecordingGranted: false, accessibilityGranted: false, shortcutAvailable: false, error: '仅支持 macOS 平台' }
    try {
      const permissions = await this.backend.checkPermissions()
      return { ...base, supported: true, screenRecordingGranted: permissions.screenRecording, accessibilityGranted: permissions.accessibility, shortcutAvailable: true, componentVersion: permissions.componentVersion }
    } catch (error) {
      return { ...base, supported: false, screenRecordingGranted: false, accessibilityGranted: false, shortcutAvailable: false, error: errorMessage(error) }
    }
  }
  async listWindows(): Promise<ChromeDesktopWindowInfo[]> { return process.platform === 'darwin' ? this.backend.listWindows() : [] }
  private inputHash(input: Record<string, unknown>): string { return createHash('sha256').update(JSON.stringify(input)).digest('hex') }
  private cacheKey(record: ActiveControlRecord, toolCallId: string): string { return `${record.sessionId}:${record.controlId}:${toolCallId}` }
  private cache(record: ActiveControlRecord, request: ChromeDesktopToolRequest, response: ChromeDesktopToolResponse): void {
    if (request.toolName === 'ChromeDesktopObserve') {
      record.seenObserveToolCallIds.add(request.toolCallId)
      record.latestObservedFrame = { toolCallId: request.toolCallId, inputHash: this.inputHash(request.toolInput), response }
      return
    }
    if (this.actionHistory.size >= MAX_ACTION_HISTORY_SIZE) {
      const key = this.actionHistory.keys().next().value
      if (key) this.actionHistory.delete(key)
    }
    this.actionHistory.set(this.cacheKey(record, request.toolCallId), { toolName: request.toolName, inputHash: this.inputHash(request.toolInput), response, timestamp: Date.now() })
  }
  async handleToolRequest(request: ChromeDesktopToolRequest): Promise<ChromeDesktopToolResponse> {
    if (!request.capabilityToken) throw new Error('CHROME_CAPABILITY_STALE: 缺少调用凭据')
    if (request.toolName === 'ChromeDesktopStart') return this.handleStart(request)
    if (request.toolName === 'ChromeDesktopStop') return this.handleStop(request)
    const record = this.validateActiveControl(request.sessionId, request.toolInput.controlId, request.capabilityToken)
    const hash = this.inputHash(request.toolInput)
    if (request.toolName === 'ChromeDesktopObserve') {
      const cached = record.latestObservedFrame
      if (cached?.toolCallId === request.toolCallId) {
        if (cached.inputHash !== hash) throw new Error('CHROME_TOOL_CALL_COLLISION: 同一 toolCallId 提交了不同输入')
        return cached.response
      }
      if (record.seenObserveToolCallIds.has(request.toolCallId)) throw new Error('CHROME_ACTION_UNCERTAIN: 旧观察回执已释放，请使用新的 toolCallId')
      return this.handleObserve(record, request)
    }
    const cached = this.actionHistory.get(this.cacheKey(record, request.toolCallId))
    if (cached && Date.now() - cached.timestamp <= ACTION_HISTORY_TTL_MS) {
      if (cached.toolName !== request.toolName || cached.inputHash !== hash) throw new Error('CHROME_TOOL_CALL_COLLISION: 同一 toolCallId 提交了不同输入')
      return cached.response
    }
    if (request.toolName === 'ChromeDesktopSelectFile') return this.handleSelectFile(record, request)
    return this.handleInput(record, request)
  }

  private async handleSelectFile(record: ActiveControlRecord, request: ChromeDesktopToolRequest): Promise<ChromeDesktopToolResponse> {
    if (record.inFlightAction) throw new Error('CHROME_BUSY: 已有动作正在执行')
    const input = request.toolInput
    const path = input.path
    if (Object.keys(input).some(key => key !== 'controlId' && key !== 'path')
      || !isValidChromeDesktopFilePath(path)) {
      throw new Error('CHROME_FILE_PATH_INVALID: 必须提供绝对本地文件路径')
    }

    record.inFlightAction = true
    // 与普通输入一致，仅释放Observe重试缓存；用户暂停拒绝时会恢复该缓存。
    const previousObservedFrame = record.latestObservedFrame
    record.latestObservedFrame = undefined
    try {
      await this.backend.selectFile(path)
      this.completeInputAction(record)
      const response: ChromeDesktopToolResponse = {
        kind: 'json',
        value: {
          ok: true,
          selected: true,
          dialogClosed: true,
          uploadConfirmed: false,
          requiresObserve: true,
          targetWindowId: record.targetWindow?.windowId,
        },
      }
      this.cache(record, request, response)
      return response
    } catch (error) {
      const code = errorCode(error, 'CHROME_FILE_SELECTION_FAILED')
      if (code === 'CHROME_USER_PAUSED') record.latestObservedFrame = previousObservedFrame
      if (this.shouldPauseAfterOperationFailure(record, code, ['CHROME_BUSY'])) {
        this.transitionToPaused(record, code, errorMessage(error))
      }
      throw error
    } finally { record.inFlightAction = false }
  }

  private async handleStart(request: ChromeDesktopToolRequest): Promise<ChromeDesktopToolResponse> {
    if (this.pendingRelease) {
      try { await this.pendingRelease.operation } catch {
        return { kind: 'json', value: { error: 'CHROME_BUSY', message: '上次 Chrome 组件停止尚未确认，请重试停止原控制' } }
      }
      if (this.pendingRelease) return { kind: 'json', value: { error: 'CHROME_BUSY', message: 'Chrome 组件正在停止，请稍后重试' } }
    }
    const current = this.activeControl
    if (current) {
      const holdsControl = ['awaiting_user', 'starting', 'active'].includes(current.state)
        || retainsChromeDesktopAuthorization(current.pauseReason)
      if (current.sessionId !== request.sessionId && holdsControl) return { kind: 'json', value: { error: 'CHROME_BUSY', message: '已有其他会话持有 Chrome 控制或授权' } }
      if (current.sessionId === request.sessionId) {
        if (current.capabilityToken !== request.capabilityToken) return { kind: 'json', value: { error: 'CHROME_CAPABILITY_STALE', message: '调用凭据与当前授权不匹配' } }
        if (isRecoverableChromeDesktopPauseReason(current.pauseReason)) this.resumeRecoverableControl(current)
        if (holdsControl || current.toolCallId === request.toolCallId) return this.startResponse(current)
      }
      this.releaseCurrentControl(false)
      await this.releasePromise
      if (this.activeControl) return this.handleStart(request)
    }
    const record: ActiveControlRecord = {
      controlId: `cd_${randomUUID().replaceAll('-', '').slice(0, 16)}`, sessionId: request.sessionId,
      capabilityToken: request.capabilityToken, state: 'awaiting_user', mode: 'observe', createdAt: Date.now(),
      toolCallId: request.toolCallId, targetWindow: null, geometryVersion: 1, frames: new Map(),
      inFlightAction: false, shortcut: CHROME_DESKTOP_DEFAULT_SHORTCUT, seenObserveToolCallIds: new Set(),
    }
    this.activeControl = record
    record.authorizationTimer = setTimeout(() => {
      if (this.activeControl === record && record.state === 'awaiting_user') this.transitionToError(record, 'CHROME_CANCELLED', '等待用户选择 Chrome 窗口超时 (120s)')
    }, 120_000)
    record.authorizationTimer.unref?.()
    this.broadcastState()
    return this.startResponse(record)
  }
  private startResponse(record: ActiveControlRecord): ChromeDesktopToolResponse {
    return { kind: 'json', value: { status: record.state, controlId: record.controlId, targetWindow: record.targetWindow, shortcut: record.shortcut, ...(record.pauseReason ? { error: record.pauseReason, message: record.errorMessage } : {}) } }
  }
  prepareCapture(params: { sessionId: string; controlId: string; windowId: number; pid: number }): { ok: boolean; error?: ChromeDesktopErrorCode; message?: string } {
    const record = this.activeControl
    if (!record || record.controlId !== params.controlId || record.sessionId !== params.sessionId) return { ok: false, error: 'CHROME_CAPABILITY_STALE', message: '控制标识已失效' }
    if (record.state === 'active' && record.targetWindow?.windowId === params.windowId && record.targetWindow.pid === params.pid) return { ok: true }
    if (record.state !== 'awaiting_user') return { ok: false, error: 'CHROME_BUSY', message: '当前状态不允许更换已授权的窗口' }
    if (!Number.isSafeInteger(params.windowId) || params.windowId <= 0 || !Number.isSafeInteger(params.pid) || params.pid <= 0) return { ok: false, error: 'CHROME_WINDOW_UNAVAILABLE', message: '窗口标识不合法' }
    record.targetWindow = { windowId: params.windowId, pid: params.pid, title: '', bounds: { x: 0, y: 0, width: 0, height: 0 } }
    return { ok: true }
  }
  async confirmStart(params: { sessionId: string; controlId: string; windowId: number; pid: number }): Promise<{ ok: boolean; error?: ChromeDesktopErrorCode; message?: string }> {
    const record = this.activeControl
    if (!record || record.controlId !== params.controlId || record.sessionId !== params.sessionId) return { ok: false, error: 'CHROME_CAPABILITY_STALE', message: '控制标识已失效' }
    if (record.state !== 'awaiting_user') return { ok: false, error: 'CHROME_BUSY', message: '当前状态不允许连接' }
    if (!this.prepareCapture(params).ok) return { ok: false, error: 'CHROME_WINDOW_UNAVAILABLE', message: '目标窗口标识不合法' }
    if (!this.registerShortcutFn(record.shortcut, () => this.handleEmergencyStop())) {
      this.transitionToError(record, 'CHROME_STOP_SHORTCUT_UNAVAILABLE', '全局停止快捷键被占用，无法开始控制')
      return { ok: false, error: 'CHROME_STOP_SHORTCUT_UNAVAILABLE', message: record.errorMessage }
    }
    clearTimeout(record.authorizationTimer)
    record.state = 'starting'
    this.broadcastState()
    try {
      await this.releasePromise
      this.assertCurrentRecord(record, 'starting')
      const target = await this.backend.connectWindow(params.windowId, params.pid)
      this.assertCurrentRecord(record, 'starting')
      if (target.windowId !== params.windowId || target.pid !== params.pid) throw new Error('CHROME_WINDOW_UNAVAILABLE: 组件连接了非目标窗口')
      record.targetWindow = target
      record.mode = 'observe'
      record.state = 'active'
      this.setThrottlingFn(false)
      this.broadcastState()
      return { ok: true }
    } catch (error) {
      if (this.activeControl !== record || record.state !== 'starting') return { ok: false, error: 'CHROME_CAPABILITY_STALE', message: '连接期间控制已结束' }
      const code = errorCode(error, 'CHROME_HELPER_FAILED')
      this.transitionToError(record, code, errorMessage(error))
      return { ok: false, error: code, message: errorMessage(error) }
    }
  }
  private handleEmergencyStop(): void {
    const record = this.activeControl
    if (record && ['starting', 'active', 'paused'].includes(record.state)) this.transitionToPaused(record, 'CHROME_CANCELLED', '用户按下全局停止快捷键')
  }
  private async handleObserve(record: ActiveControlRecord, request: ChromeDesktopToolRequest): Promise<ChromeDesktopToolResponse> {
    if (record.inFlightAction) throw new Error('CHROME_BUSY: 已有动作正在执行')
    record.inFlightAction = true
    const previousObservedFrame = record.latestObservedFrame
    record.latestObservedFrame = undefined
    try {
      const captured = await this.backend.observe()
      this.assertCurrentControlRecord(record)
      if (!captured.frameId || !Number.isInteger(captured.width) || !Number.isInteger(captured.height) || captured.width <= 0 || captured.height <= 0 || captured.width > 1600 || captured.height > 8192 || !captured.data || captured.data.length > 1_398_104 || !Number.isFinite(captured.capturedAt) || captured.capturedAt < 0) throw new Error('CHROME_CAPTURE_FAILED: 组件截图元数据不合法')
      if (!record.targetWindow || !sameBounds(record.targetWindow.bounds, captured.bounds)) record.geometryVersion++
      record.targetWindow!.bounds = captured.bounds
      const frame: ChromeDesktopFrameMeta = { controlId: record.controlId, frameId: captured.frameId, width: captured.width, height: captured.height, capturedAt: captured.capturedAt, geometryVersion: record.geometryVersion }
      record.frames.set(frame.frameId, frame)
      if (record.frames.size > MAX_CONTROL_FRAMES) {
        const oldest = record.frames.keys().next().value
        if (oldest) record.frames.delete(oldest)
      }
      const response: ChromeDesktopToolResponse = { kind: 'image', frame, image: { mimeType: 'image/jpeg', data: captured.data } }
      this.cache(record, request, response)
      return response
    } catch (error) {
      if (this.isUserPaused(record)) record.latestObservedFrame = previousObservedFrame
      const code = errorCode(error, 'CHROME_CAPTURE_FAILED')
      if (this.shouldPauseAfterOperationFailure(record, code, ['CHROME_BUSY'])) {
        this.transitionToPaused(record, code, errorMessage(error))
      }
      throw error
    } finally { record.inFlightAction = false }
  }
  private actionFor(request: ChromeDesktopToolRequest, frame: ChromeDesktopFrameMeta): ChromeDesktopComponentAction {
    const input = request.toolInput
    switch (request.toolName) {
      case 'ChromeDesktopClick':
      case 'ChromeDesktopScroll': {
        const { x, y } = input
        if (typeof x !== 'number' || typeof y !== 'number' || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= frame.width || y >= frame.height) throw new Error('图片坐标必须为范围内的整数')
        if (request.toolName === 'ChromeDesktopClick') {
          const count = input.clickCount ?? 1
          if (count !== 1 && count !== 2) throw new Error('clickCount 只能为 1 或 2')
          return { action: 'click', x, y, clickCount: count }
        }
        const deltaY = input.deltaY
        if (typeof deltaY !== 'number' || !Number.isInteger(deltaY) || deltaY === 0 || Math.abs(deltaY) > 1200) throw new Error('deltaY 必须为 [-1200,1200] 范围内的非零整数')
        return { action: 'scroll', x, y, deltaY }
      }
      case 'ChromeDesktopType': {
        const text = input.text
        if (typeof text !== 'string' || [...text].length < 1 || [...text].length > 4096 || /[\u0000-\u001f\u007f-\u009f]/u.test(text)) throw new Error('text 必须为 1–4096 个字符且不包含控制字符')
        return { action: 'type', text }
      }
      case 'ChromeDesktopPress': {
        if (!CHROME_DESKTOP_ALLOWED_KEYS.includes(input.key as never)) throw new Error('按键不在允许的枚举范围内')
        return { action: 'press', key: input.key as typeof CHROME_DESKTOP_ALLOWED_KEYS[number] }
      }
      default: throw new Error('不支持的 Chrome 工具')
    }
  }
  private async handleInput(record: ActiveControlRecord, request: ChromeDesktopToolRequest): Promise<ChromeDesktopToolResponse> {
    if (record.inFlightAction) throw new Error('CHROME_BUSY: 已有动作正在执行')
    const frame = typeof request.toolInput.frameId === 'string' ? record.frames.get(request.toolInput.frameId) : undefined
    if (!frame) throw new Error('CHROME_FRAME_STALE: 该帧不属于当前控制或已超出最近 32 帧')
    const action = this.actionFor(request, frame)
    record.inFlightAction = true
    const previousObservedFrame = record.latestObservedFrame
    record.latestObservedFrame = undefined
    try {
      await this.backend.input(frame.frameId, action)
      this.completeInputAction(record)
      const response: ChromeDesktopToolResponse = { kind: 'json', value: { ok: true, action: action.action, targetWindowId: record.targetWindow!.windowId, ...(action.action === 'click' ? { clickCount: action.clickCount } : {}) } }
      this.cache(record, request, response)
      return response
    } catch (error) {
      const code = errorCode(error, 'CHROME_HELPER_FAILED')
      if (code === 'CHROME_USER_PAUSED') record.latestObservedFrame = previousObservedFrame
      if (this.shouldPauseAfterOperationFailure(record, code, ['CHROME_BUSY', 'CHROME_FRAME_STALE'])) {
        this.transitionToPaused(record, code, errorMessage(error))
      }
      throw error
    } finally { record.inFlightAction = false }
  }
  private async handleStop(request: ChromeDesktopToolRequest): Promise<ChromeDesktopToolResponse> {
    const record = this.activeControl ?? this.pendingRelease?.record
    if (record && record.sessionId === request.sessionId && record.controlId === request.toolInput.controlId && record.capabilityToken === request.capabilityToken) {
      await this.stopSessionControl(request.sessionId, record.controlId)
    }
    return { kind: 'json', value: { ok: true, status: 'stopped' } }
  }
  private validateActiveControl(sessionId: string, controlId: unknown, token: string): ActiveControlRecord {
    const record = this.activeControl
    if (!record || record.sessionId !== sessionId || record.controlId !== controlId || record.capabilityToken !== token) throw new Error('CHROME_CAPABILITY_STALE: 控制标识或调用凭据不匹配')
    if (isRecoverableChromeDesktopPauseReason(record.pauseReason)) this.resumeRecoverableControl(record)
    if (record.state === 'active' || this.isUserPaused(record)) return record
    throw new Error(`CHROME_CAPABILITY_STALE: 当前控制处于 ${record.state} 状态`)
  }
  private isUserPaused(record: ActiveControlRecord): boolean {
    return record.state === 'paused' && record.pauseReason === 'CHROME_USER_PAUSED'
  }
  private shouldPauseAfterOperationFailure(
    record: ActiveControlRecord,
    code: ChromeDesktopErrorCode,
    activeIgnoredCodes: ChromeDesktopErrorCode[],
  ): boolean {
    if (this.activeControl !== record) return false
    if (record.state === 'active') return !activeIgnoredCodes.includes(code)
    return this.isUserPaused(record) && USER_PAUSED_TERMINAL_ERRORS.has(code)
  }
  private assertCurrentControlRecord(record: ActiveControlRecord): void {
    if (this.activeControl !== record || (record.state !== 'active' && !this.isUserPaused(record))) {
      throw new Error('CHROME_CAPABILITY_STALE: 控制已取消或切换')
    }
  }
  private completeInputAction(record: ActiveControlRecord): void {
    this.assertCurrentControlRecord(record)
    if (this.isUserPaused(record)) {
      record.state = 'active'
      record.pauseReason = undefined
      record.errorMessage = undefined
      this.setThrottlingFn(false)
    }
    record.mode = 'control'
    this.broadcastState()
  }
  private assertCurrentRecord(record: ActiveControlRecord, state: ChromeDesktopState = 'active'): void {
    if (this.activeControl !== record || record.state !== state) throw new Error('CHROME_CAPABILITY_STALE: 控制已取消或切换')
  }
  private clearControlFrames(record: ActiveControlRecord): void {
    clearTimeout(record.authorizationTimer)
    record.frames.clear()
    record.latestObservedFrame = undefined
    record.seenObserveToolCallIds.clear()
    this.actionHistory.clear()
  }
  private resumeRecoverableControl(record: ActiveControlRecord): boolean {
    if (record.state !== 'paused' || !isRecoverableChromeDesktopPauseReason(record.pauseReason)) return false
    if (!this.registerShortcutFn(record.shortcut, () => this.handleEmergencyStop())) {
      this.transitionToError(record, 'CHROME_STOP_SHORTCUT_UNAVAILABLE', '无法重新注册全局停止快捷键')
      return false
    }
    record.state = 'active'
    record.mode = 'observe'
    record.pauseReason = undefined
    record.errorMessage = undefined
    this.setThrottlingFn(false)
    this.broadcastState()
    return true
  }
  private cancelBackend(record = this.activeControl ?? this.pendingRelease?.record): void {
    const operation = this.backend.cancel()
    this.releasePromise = operation
    if (record) {
      const pending = { record, operation }
      this.pendingRelease = pending
      void operation.then(() => {
        if (this.pendingRelease !== pending) return
        this.pendingRelease = undefined
        if (!this.activeControl && record.state === 'error') {
          record.state = 'stopped'
          this.broadcastState(record)
        }
      }, () => {
        if (this.pendingRelease !== pending || this.activeControl) return
        record.state = 'error'
        record.pauseReason = 'CHROME_HELPER_FAILED'
        record.errorMessage = 'Chrome 组件停止尚未确认，请重试结束控制'
        this.broadcastState(record)
      })
    }
    // 保留停止失败及所属 control；显式重试不能因 active 已清空而假报成功。
    void operation.catch(() => console.warn('[ChromeDesktopService] 组件停止未获确认，保留清理状态供重试'))
  }
  private transitionToPaused(record: ActiveControlRecord, reason: ChromeDesktopErrorCode, message: string): void {
    if (this.activeControl !== record) return
    // 旧 CLI 在参数解析阶段拒绝新命令时，连接与既有授权帧仍有效。
    const userPaused = reason === 'CHROME_USER_PAUSED'
    const retainsFrames = userPaused || reason === 'CHROME_COMPONENT_VERSION_UNSUPPORTED'
    const retainsConnection = retainsChromeDesktopAuthorization(reason)
    if (!retainsFrames) this.clearControlFrames(record)
    record.state = 'paused'
    record.pauseReason = reason
    record.errorMessage = message
    // 可恢复错误及用户暂停都保留授权连接；其余错误会清理组件。
    if (!retainsConnection) this.cancelBackend()
    if (!userPaused) this.unregisterShortcutFn(record.shortcut)
    this.setThrottlingFn(true)
    this.broadcastState()
  }
  private transitionToError(record: ActiveControlRecord, reason: ChromeDesktopErrorCode, message: string): void {
    this.transitionToPaused(record, reason, message)
    if (this.activeControl === record) { record.state = 'error'; this.broadcastState() }
  }
  releaseCurrentControl(resetStateToStopped = true): void {
    const record = this.activeControl
    this.actionHistory.clear()
    if (!record) { this.cancelBackend(); return }
    this.clearControlFrames(record)
    this.cancelBackend()
    this.unregisterShortcutFn(record.shortcut)
    this.setThrottlingFn(true)
    record.state = 'stopped'
    if (resetStateToStopped) this.broadcastState()
    this.activeControl = null
  }
  async stopSessionControl(sessionId: string, controlId: string): Promise<void> {
    const record = this.activeControl ?? this.pendingRelease?.record
    if (!record || record.sessionId !== sessionId || record.controlId !== controlId) return
    if (this.activeControl === record) this.releaseCurrentControl()
    else this.cancelBackend(record)
    await this.releasePromise
  }
  async shutdown(): Promise<void> {
    this.releaseCurrentControl()
    await this.releasePromise
  }
  releaseSessionControl(sessionId: string, capabilityToken?: string, controlId?: string): void {
    const record = this.activeControl
    if (!record || record.sessionId !== sessionId || (capabilityToken && record.capabilityToken !== capabilityToken) || (controlId && record.controlId !== controlId)) return
    this.releaseCurrentControl()
  }
}
export const chromeDesktopService = new ChromeDesktopService()
