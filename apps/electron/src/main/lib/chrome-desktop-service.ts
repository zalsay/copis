/**
 * macOS 本机 Chrome 桌面视觉自动化核心服务
 *
 * 职责：
 * - 全局唯一占用管控，禁止跨会话并发
 * - 内存状态机管理：idle, awaiting_user, starting, active, paused, stopping, stopped, error
 * - Start 授权等待、轮询去重与 120 秒超时兜底
 * - 几何版本追踪与帧校验（Observe 2s / 同一观察帧支持多次输入，不限制模型推理耗时）
 * - 焦点丢失与几何改变时立即停止新输入并进入 paused
 * - 全局紧急停止快捷键集成
 * - 依赖可注入以供 BDD 自动化测试
 */

import { createHash, randomUUID } from 'node:crypto'
import type {
  ChromeDesktopAllowedKey,
  ChromeDesktopBounds,
  ChromeDesktopErrorCode,
  ChromeDesktopFrameMeta,
  ChromeDesktopFrameResult,
  ChromeDesktopSessionState,
  ChromeDesktopState,
  ChromeDesktopMode,
  ChromeDesktopSystemStatus,
  ChromeDesktopToolName,
  ChromeDesktopToolRequest,
  ChromeDesktopToolResponse,
  ChromeDesktopWindowInfo,
} from '@copis/shared'
import {
  CHROME_DESKTOP_ALLOWED_KEYS,
  CHROME_DESKTOP_DEFAULT_SHORTCUT,
  isRecoverableChromeDesktopPauseReason,
} from '@copis/shared'
import {
  ChromeDesktopHelperClient,
  type IChromeDesktopHelperClient,
} from './chrome-desktop-helper-client'

export const MAX_ACTION_HISTORY_SIZE = 50
export const ACTION_HISTORY_TTL_MS = 5 * 60 * 1000

interface CachedActionEntry {
  toolName: ChromeDesktopToolName
  inputHash: string
  response: ChromeDesktopToolResponse
  timestamp: number
}

export interface FrameCaptureRequest {
  controlId: string
  geometryVersion: number
}

export type FrameCapturer = (req: FrameCaptureRequest) => Promise<{
  width: number
  height: number
  capturedAt: number
  data: string
  presentedFrames?: number
  mediaTime?: number
  encodedAt?: number
}>

export interface ChromeDesktopServiceDependencies {
  helperClient?: IChromeDesktopHelperClient
  captureFrame?: FrameCapturer
  registerGlobalShortcut?: (shortcut: string, callback: () => void) => boolean
  unregisterGlobalShortcut?: (shortcut: string) => void
  setBackgroundThrottling?: (enabled: boolean) => void
  onStateChanged?: (state: ChromeDesktopSessionState) => void
  getScreenAccessStatus?: () => boolean
}

interface ActiveControlRecord {
  controlId: string
  sessionId: string
  capabilityToken?: string
  runGeneration: number
  state: ChromeDesktopState
  mode: ChromeDesktopMode
  createdAt: number
  toolCallId?: string
  targetWindow: ChromeDesktopWindowInfo | null
  geometryVersion: number
  latestFrame: ChromeDesktopFrameMeta | null
  inFlightAction: boolean
  pauseReason?: ChromeDesktopErrorCode
  errorMessage?: string
  shortcut: string
  authorizationTimer?: ReturnType<typeof setTimeout>
  seenObserveToolCallIds: Set<string>
  latestObservedFrame?: {
    toolCallId: string
    inputHash: string
    response: ChromeDesktopToolResponse
    timestamp: number
  }
}

export class ChromeDesktopService {
  private helper: IChromeDesktopHelperClient
  private captureFrameFn?: FrameCapturer
  private registerShortcutFn: (shortcut: string, callback: () => void) => boolean
  private unregisterShortcutFn: (shortcut: string) => void
  private setThrottlingFn: (enabled: boolean) => void
  private getScreenAccessStatusFn: () => boolean
  private stateChangedListener?: (state: ChromeDesktopSessionState) => void

  private activeControl: ActiveControlRecord | null = null
  private nextRunGeneration = 1
  private actionHistory = new Map<string, CachedActionEntry>()

  constructor(deps?: ChromeDesktopServiceDependencies) {
    this.helper = deps?.helperClient ?? new ChromeDesktopHelperClient()
    this.captureFrameFn = deps?.captureFrame
    this.registerShortcutFn = deps?.registerGlobalShortcut ?? this.defaultRegisterShortcut
    this.unregisterShortcutFn = deps?.unregisterGlobalShortcut ?? this.defaultUnregisterShortcut
    this.setThrottlingFn = deps?.setBackgroundThrottling ?? this.defaultSetBackgroundThrottling
    this.getScreenAccessStatusFn = deps?.getScreenAccessStatus ?? this.defaultGetScreenAccessStatus
    this.stateChangedListener = deps?.onStateChanged
  }

  private defaultRegisterShortcut(shortcut: string, callback: () => void): boolean {
    if (process.versions?.electron) {
      try {
        const { globalShortcut } = require('electron')
        return globalShortcut.register(shortcut, callback)
      } catch {
        return false
      }
    }
    return true
  }

  private defaultUnregisterShortcut(shortcut: string): void {
    if (process.versions?.electron) {
      try {
        const { globalShortcut } = require('electron')
        globalShortcut.unregister(shortcut)
      } catch {
        // ignore
      }
    }
  }

  private defaultGetScreenAccessStatus(): boolean {
    if (process.versions?.electron) {
      try {
        const { systemPreferences } = require('electron')
        return systemPreferences.getMediaAccessStatus('screen') === 'granted'
      } catch {
        return false
      }
    }
    return false
  }

  private defaultSetBackgroundThrottling(enabled: boolean): void {
    if (process.versions?.electron) {
      try {
        const { getMainWindow } = require('../index')
        const mainWindow = getMainWindow?.()
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents?.setBackgroundThrottling(enabled)
        }
      } catch {
        // ignore
      }
    }
  }

  setFrameCapturer(capturer: FrameCapturer): void {
    this.captureFrameFn = capturer
  }

  setStateChangedListener(listener: (state: ChromeDesktopSessionState) => void): void {
    this.stateChangedListener = listener
  }

  private broadcastState(): void {
    const snapshot = this.getSessionState()
    if (!snapshot) return
    // 不记录截图、窗口标题、输入文字或 capability token，仅记录状态和阶段耗时。
    console.info('[ChromeDesktopService] 控制状态更新', {
      controlId: snapshot.controlId,
      state: snapshot.state,
      mode: snapshot.mode,
      reason: snapshot.pauseReason,
      elapsedMs: Date.now() - snapshot.createdAt,
      windowId: snapshot.targetWindow?.windowId ?? null,
    })
    this.stateChangedListener?.(snapshot)
  }

  getSessionState(): ChromeDesktopSessionState | null {
    if (!this.activeControl) return null
    return {
      controlId: this.activeControl.controlId,
      sessionId: this.activeControl.sessionId,
      state: this.activeControl.state,
      mode: this.activeControl.mode,
      targetWindow: this.activeControl.targetWindow,
      pauseReason: this.activeControl.pauseReason,
      errorMessage: this.activeControl.errorMessage,
      shortcut: this.activeControl.shortcut,
      createdAt: this.activeControl.createdAt,
    }
  }

  getPendingCaptureTarget(): { controlId: string; windowId: number; pid: number } | null {
    if (!this.activeControl) return null
    if (this.activeControl.state !== 'starting' && this.activeControl.state !== 'awaiting_user') {
      return null
    }
    return this.activeControl.targetWindow
      ? { controlId: this.activeControl.controlId, windowId: this.activeControl.targetWindow.windowId, pid: this.activeControl.targetWindow.pid }
      : null
  }

  hasPendingCapture(): boolean {
    return this.getPendingCaptureTarget() !== null
  }

  async checkSystemStatus(): Promise<ChromeDesktopSystemStatus> {
    if (process.platform !== 'darwin') {
      return {
        supported: false,
        screenRecordingGranted: false,
        accessibilityGranted: false,
        visionModelSupported: true,
        shortcut: CHROME_DESKTOP_DEFAULT_SHORTCUT,
        shortcutAvailable: false,
        error: '仅支持 macOS 平台',
      }
    }

    try {
      const screenRecording = this.getScreenAccessStatusFn()
      const perms = await this.helper.checkPermissions()
      return {
        supported: true,
        screenRecordingGranted: screenRecording,
        accessibilityGranted: perms.accessibility,
        visionModelSupported: true,
        shortcut: CHROME_DESKTOP_DEFAULT_SHORTCUT,
        shortcutAvailable: true,
      }
    } catch (e: any) {
      return {
        supported: false,
        screenRecordingGranted: false,
        accessibilityGranted: false,
        visionModelSupported: true,
        shortcut: CHROME_DESKTOP_DEFAULT_SHORTCUT,
        shortcutAvailable: false,
        error: e.message,
      }
    }
  }

  async listWindows(): Promise<ChromeDesktopWindowInfo[]> {
    if (process.platform !== 'darwin') return []
    return this.helper.listWindows()
  }

  private getActionCacheKey(sessionId: string, controlId: string | undefined, toolCallId: string): string {
    return `${sessionId}:${controlId ?? ''}:${toolCallId}`
  }

  private computeInputHash(input: Record<string, unknown> | undefined): string {
    try {
      return createHash('sha256').update(JSON.stringify(input ?? {})).digest('hex')
    } catch {
      return ''
    }
  }

  private setCachedAction(
    sessionId: string,
    controlId: string | undefined,
    toolCallId: string,
    toolName: ChromeDesktopToolName,
    inputHash: string,
    response: ChromeDesktopToolResponse,
  ): void {
    if (toolName === 'ChromeDesktopObserve') {
      // P1-4: Observe 独立维护单帧缓存，绝不把空 base64 作为成功结果返回；
      // 该单帧缓存绑定在 activeControl 生命周期上，发生其他动作或 control 释放时立即销毁
      if (this.activeControl) {
        this.activeControl.seenObserveToolCallIds.add(toolCallId)
        if (response.kind === 'image') {
          this.activeControl.latestObservedFrame = {
            toolCallId,
            inputHash,
            response,
            timestamp: Date.now(),
          }
        }
      }
      return
    }

    const key = this.getActionCacheKey(sessionId, controlId, toolCallId)

    // 容量上限：超额时先淘汰最旧项 (FIFO)
    if (this.actionHistory.size >= MAX_ACTION_HISTORY_SIZE) {
      const oldestKey = this.actionHistory.keys().next().value
      if (oldestKey) {
        this.actionHistory.delete(oldestKey)
      }
    }

    this.actionHistory.set(key, {
      toolName,
      inputHash,
      response,
      timestamp: Date.now(),
    })
  }

  /**
   * 处理 Agent Worker 发起的工具请求
   */
  async handleToolRequest(request: ChromeDesktopToolRequest): Promise<ChromeDesktopToolResponse> {
    const { sessionId, capabilityToken, toolCallId, toolName, toolInput } = request

    // 缓存不是授权来源，重放前也必须核对所属控制实例。
    if (toolName !== 'ChromeDesktopStart' && toolName !== 'ChromeDesktopStop') {
      this.validateActiveControl(sessionId, toolInput.controlId as string, capabilityToken)
    }
    const inputHash = this.computeInputHash(toolInput)
    const currentControlId = this.activeControl?.controlId
    const cacheKey = this.getActionCacheKey(sessionId, currentControlId, toolCallId)

    // 幂等去重检查：
    if (toolName === 'ChromeDesktopObserve') {
      const record = this.activeControl
      if (record) {
        const cachedFrame = record.latestObservedFrame
        if (cachedFrame && cachedFrame.toolCallId === toolCallId) {
          if (Date.now() - cachedFrame.timestamp <= 30_000) {
            if (cachedFrame.inputHash === inputHash) {
              return cachedFrame.response
            }
            throw new Error('CHROME_TOOL_CALL_COLLISION: 同一 toolCallId 提交了不同的输入参数')
          }
        } else if (record.seenObserveToolCallIds.has(toolCallId)) {
          // 该 toolCallId 之前已观察过，但帧已失效或被后续动作冲刷
          throw new Error('CHROME_ACTION_UNCERTAIN: Observe 动作帧已失效，请重新发起 Observe')
        }
      }
    } else if (toolName !== 'ChromeDesktopStart') {
      const cached = this.actionHistory.get(cacheKey)
      if (cached) {
        if (Date.now() - cached.timestamp <= ACTION_HISTORY_TTL_MS) {
          if (cached.toolName === toolName && cached.inputHash === inputHash) {
            return cached.response
          }
          throw new Error('CHROME_TOOL_CALL_COLLISION: 同一 toolCallId 提交了不同的输入参数')
        }
        this.actionHistory.delete(cacheKey)
      }
    }

    switch (toolName) {
      case 'ChromeDesktopStart':
        return this.handleStart(sessionId, toolCallId, capabilityToken)
      case 'ChromeDesktopObserve':
        return this.handleObserve(sessionId, toolCallId, toolInput, capabilityToken)
      case 'ChromeDesktopClick':
        return this.handleClick(sessionId, toolCallId, toolInput, capabilityToken)
      case 'ChromeDesktopScroll':
        return this.handleScroll(sessionId, toolCallId, toolInput, capabilityToken)
      case 'ChromeDesktopType':
        return this.handleType(sessionId, toolCallId, toolInput, capabilityToken)
      case 'ChromeDesktopPress':
        return this.handlePress(sessionId, toolCallId, toolInput, capabilityToken)
      case 'ChromeDesktopStop':
        return this.handleStop(sessionId, toolCallId, toolInput, capabilityToken)
      default:
        throw new Error(`不支持的工具: ${toolName}`)
    }
  }

  /**
   * ChromeDesktopStart
   */
  private async handleStart(sessionId: string, toolCallId: string, capabilityToken?: string): Promise<ChromeDesktopToolResponse> {
    // 检查是否有其他会话正在占用
    if (this.activeControl && this.activeControl.sessionId !== sessionId && !['stopped', 'error', 'paused'].includes(this.activeControl.state)) {
      return {
        kind: 'json',
        value: {
          error: 'CHROME_BUSY',
          message: '当前已有其他会话正在控制或等待控制 Chrome',
        },
      }
    }

    // 普通 Agent turn 结束后控制权会保留；同一会话下一轮 Start 直接复用当前 control。
    if (this.activeControl && this.activeControl.sessionId === sessionId) {
      if (this.activeControl.capabilityToken && this.activeControl.capabilityToken !== capabilityToken) {
        return { kind: 'json', value: { error: 'CHROME_CAPABILITY_STALE', message: '当前 Start 请求携带的 capability token 与控制实例不匹配' } }
      }
      if (this.activeControl.state === 'active') {
        return {
          kind: 'json',
          value: {
            status: 'active',
            controlId: this.activeControl.controlId,
            targetWindow: this.activeControl.targetWindow,
            shortcut: this.activeControl.shortcut,
          },
        }
      }
      if (this.activeControl.state === 'awaiting_user' || this.activeControl.state === 'starting') {
        return { kind: 'json', value: { status: this.activeControl.state, controlId: this.activeControl.controlId } }
      }
    }

    // 焦点/几何变化造成的 paused 仍属于同一次授权，新的 Start 不应再次等待用户选择窗口。
    if (
      this.activeControl
      && this.activeControl.sessionId === sessionId
      && isRecoverableChromeDesktopPauseReason(this.activeControl.pauseReason)
    ) {
      if (this.activeControl.capabilityToken && this.activeControl.capabilityToken !== capabilityToken) {
        return { kind: 'json', value: { error: 'CHROME_CAPABILITY_STALE', message: '当前 Start 请求携带的 capability token 与控制实例不匹配' } }
      }
      if (!this.resumeRecoverableControl(this.activeControl)) {
        return { kind: 'json', value: { status: 'error', controlId: this.activeControl.controlId, error: this.activeControl.pauseReason ?? 'CHROME_STOP_SHORTCUT_UNAVAILABLE', message: this.activeControl.errorMessage } }
      }
      return {
        kind: 'json',
        value: {
          status: 'active',
          controlId: this.activeControl.controlId,
          targetWindow: this.activeControl.targetWindow,
          shortcut: this.activeControl.shortcut,
        },
      }
    }

    // 同一会话且同一 toolCallId 的轮询
    if (this.activeControl && this.activeControl.sessionId === sessionId && this.activeControl.toolCallId === toolCallId) {
      const record = this.activeControl
      if (record.capabilityToken && (!capabilityToken || record.capabilityToken !== capabilityToken)) {
        return {
          kind: 'json',
          value: {
            error: 'CHROME_CAPABILITY_STALE',
            message: '当前 Start 请求携带的 capability token 与控制实例不匹配',
          },
        }
      }
      if (record.state === 'active') {
        return {
          kind: 'json',
          value: {
            status: 'active',
            controlId: record.controlId,
            targetWindow: record.targetWindow,
            shortcut: record.shortcut,
          },
        }
      }
      if (record.state === 'error' || record.state === 'stopped' || record.state === 'paused') {
        return {
          kind: 'json',
          value: {
            status: record.state,
            controlId: record.controlId,
            error: record.pauseReason ?? 'CHROME_CANCELLED',
            message: record.errorMessage,
          },
        }
      }
      return {
        kind: 'json',
        value: {
          status: record.state,
          controlId: record.controlId,
        },
      }
    }

    // 若有旧的已停止控制，先清理
    if (this.activeControl) {
      this.releaseCurrentControl(false)
    }

    const controlId = `cd_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const generation = this.nextRunGeneration++

    const record: ActiveControlRecord = {
      controlId,
      sessionId,
      capabilityToken,
      runGeneration: generation,
      state: 'awaiting_user',
      mode: 'observe',
      createdAt: Date.now(),
      toolCallId,
      targetWindow: null,
      geometryVersion: 1,
      latestFrame: null,
      inFlightAction: false,
      shortcut: CHROME_DESKTOP_DEFAULT_SHORTCUT,
      seenObserveToolCallIds: new Set(),
    }

    this.activeControl = record
    this.broadcastState()

    // 120 秒超时兜底
    record.authorizationTimer = setTimeout(() => {
      if (this.activeControl === record && record.state === 'awaiting_user') {
        this.transitionToError(record, 'CHROME_CANCELLED', '等待用户授权超时 (120s)')
      }
    }, 120_000)
    record.authorizationTimer.unref?.()

    return {
      kind: 'json',
      value: {
        status: 'awaiting_user',
        controlId,
      },
    }
  }

  /**
   * 预选采集目标窗口（供 getDisplayMedia 捕获前绑定）
   */
  prepareCapture(params: {
    sessionId: string
    controlId: string
    windowId: number
    pid: number
  }): { ok: boolean; error?: ChromeDesktopErrorCode; message?: string } {
    const record = this.activeControl
    if (!record || record.controlId !== params.controlId || record.sessionId !== params.sessionId) {
      return { ok: false, error: 'CHROME_CAPABILITY_STALE', message: '控制标识已失效' }
    }

    if (record.state !== 'awaiting_user') {
      return { ok: false, error: 'CHROME_BUSY', message: `当前状态不允许准备采集 (${record.state})` }
    }

    record.targetWindow = {
      windowId: params.windowId,
      pid: params.pid,
      title: '',
      bounds: { x: 0, y: 0, width: 0, height: 0 },
    }
    console.info('[ChromeDesktopService] 用户已选择采集目标，等待媒体采集确认', {
      controlId: record.controlId,
      windowId: params.windowId,
      elapsedMs: Date.now() - record.createdAt,
    })
    return { ok: true }
  }

  /**
   * 用户在渲染进程确认启动
   */
  async confirmStart(params: {
    sessionId: string
    controlId: string
    windowId: number
    pid: number
  }): Promise<{ ok: boolean; error?: ChromeDesktopErrorCode; message?: string }> {
    const record = this.activeControl
    if (!record || record.controlId !== params.controlId || record.sessionId !== params.sessionId) {
      return { ok: false, error: 'CHROME_CAPABILITY_STALE', message: '控制标识已失效' }
    }

    if (record.state !== 'awaiting_user') {
      return { ok: false, error: 'CHROME_BUSY', message: `当前状态不允许启动 (${record.state})` }
    }

    record.targetWindow = {
      windowId: params.windowId,
      pid: params.pid,
      title: '',
      bounds: { x: 0, y: 0, width: 0, height: 0 },
    }

    // 注册全局紧急停止快捷键；观察模式也需要它来结束采集。
    const shortcutSuccess = this.registerShortcutFn(record.shortcut, () => {
      this.handleEmergencyStop()
    })

    if (!shortcutSuccess) {
      record.state = 'error'
      record.errorMessage = '无法注册全局停止快捷键，可能被占用'
      record.pauseReason = 'CHROME_STOP_SHORTCUT_UNAVAILABLE'
      this.broadcastState()
      return { ok: false, error: 'CHROME_STOP_SHORTCUT_UNAVAILABLE', message: record.errorMessage }
    }

    record.state = 'starting'
    this.broadcastState()

    try {
      const boundsResult = await this.helper.getWindowBounds(params.windowId, params.pid)
      this.assertCurrentRecord(record, 'starting')
      if (!boundsResult.ok || !boundsResult.bounds) {
        const message = `目标窗口不可用${boundsResult.error ? `：${boundsResult.error}` : ''}`
        this.transitionToError(record, 'CHROME_WINDOW_UNAVAILABLE', message)
        return { ok: false, error: 'CHROME_WINDOW_UNAVAILABLE', message }
      }
      record.targetWindow = {
        windowId: params.windowId,
        pid: params.pid,
        title: record.targetWindow?.title ?? '',
        bounds: boundsResult.bounds,
      }
      clearTimeout(record.authorizationTimer)
      record.mode = 'observe'
      this.setThrottlingFn(false)
      record.state = 'active'
      this.broadcastState()
      return { ok: true }
    } catch (e: any) {
      if (this.activeControl !== record || record.state !== 'starting') {
        return { ok: false, error: 'CHROME_CAPABILITY_STALE', message: '控制已结束' }
      }
      this.transitionToError(record, 'CHROME_HELPER_FAILED', e.message)
      return { ok: false, error: 'CHROME_HELPER_FAILED', message: e.message }
    }
  }

  /**
   * 紧急停止快捷键触发
   */
  private handleEmergencyStop(): void {
    const record = this.activeControl
    if (!record || (record.state !== 'active' && record.state !== 'starting')) return

    console.warn('[ChromeDesktopService] 紧急停止快捷键触发！立即撤销授权与输入。')
    this.helper.cancel().catch(() => {})
    this.transitionToPaused(record, 'CHROME_CANCELLED', '用户按下全局停止快捷键')
  }

  /**
   * ChromeDesktopObserve
   */
  private async handleObserve(sessionId: string, toolCallId: string, input: Record<string, unknown>, capabilityToken?: string): Promise<ChromeDesktopToolResponse> {
    const record = this.validateActiveControl(sessionId, input.controlId as string, capabilityToken)

    if (record.inFlightAction) throw new Error('CHROME_BUSY: 已有操作正在执行')
    record.inFlightAction = true
    record.latestFrame = null
    record.latestObservedFrame = undefined
    try {
      const targetCheck = await this.helper.getWindowBounds(record.targetWindow!.windowId, record.targetWindow!.pid)
      this.assertCurrentRecord(record)
      if (!targetCheck.ok || !targetCheck.bounds) {
        this.transitionToPaused(record, 'CHROME_FOCUS_LOST', 'Chrome 窗口失去焦点或已关闭')
        throw new Error('CHROME_FOCUS_LOST')
      }

      // 更新最新几何位置
      record.targetWindow!.bounds = targetCheck.bounds

      if (!this.captureFrameFn) {
        throw new Error('未注册帧捕获处理器')
      }

      // 请求一帧（最长 2 秒）
      const capturePromise = this.captureFrameFn({
        controlId: record.controlId,
        geometryVersion: record.geometryVersion,
      })

      let frameTimer: ReturnType<typeof setTimeout> | undefined
      const timeoutPromise = new Promise<never>((_, reject) => {
        frameTimer = setTimeout(() => reject(new Error('CHROME_CAPTURE_FAILED: 帧捕获超时 (2s)')), 2000)
      })

      const captured = await Promise.race([capturePromise, timeoutPromise]).finally(() => clearTimeout(frameTimer))
      this.assertCurrentRecord(record)

      if (!Number.isInteger(captured.width) || !Number.isInteger(captured.height) || captured.width <= 0 || captured.height <= 0 || Math.max(captured.width, captured.height) > 1600 || !captured.data || captured.data.length > 1_398_104) {
        throw new Error('CHROME_CAPTURE_FAILED: 图片尺寸或内容不合法')
      }

      // 校验抓取时间戳是否在 2 秒内
      const age = Date.now() - captured.capturedAt
      if (age > 2000 || age < 0) {
        throw new Error('CHROME_FRAME_STALE: 采集帧已过期，请重试 ChromeDesktopObserve，无需重新授权')
      }

      const frameId = `frm_${randomUUID().replace(/-/g, '').slice(0, 16)}`
      record.geometryVersion += 1
      record.latestFrame = {
        controlId: record.controlId,
        frameId,
        width: captured.width,
        height: captured.height,
        capturedAt: captured.capturedAt,
        geometryVersion: record.geometryVersion,
        ...(captured.presentedFrames !== undefined ? { presentedFrames: captured.presentedFrames } : {}),
        ...(captured.mediaTime !== undefined ? { mediaTime: captured.mediaTime } : {}),
        ...(captured.encodedAt !== undefined ? { encodedAt: captured.encodedAt } : {}),
      }

      const response: ChromeDesktopToolResponse = {
        kind: 'image',
        frame: record.latestFrame,
        image: {
          mimeType: 'image/jpeg',
          data: captured.data,
        },
      }

      this.setCachedAction(sessionId, record.controlId, toolCallId, 'ChromeDesktopObserve', this.computeInputHash(input), response)
      return response
    } catch (error) {
      const message = error instanceof Error ? error.message : '取帧失败'
      // 暂时没有新帧不等于授权失效；旧帧在 Observe 开始时已清空，重试不会绕过新鲜度校验。
      if (this.activeControl === record && record.state === 'active' && !message.startsWith('CHROME_FRAME_STALE')) {
        this.transitionToPaused(record, 'CHROME_CAPTURE_FAILED', message)
      }
      throw error
    } finally {
      record.inFlightAction = false
    }
  }

  /**
   * 前置动作校验与坐标换算
   */
  private async prepareAction(
    sessionId: string,
    toolCallId: string,
    input: Record<string, unknown>,
    capabilityToken?: string,
  ): Promise<{
    record: ActiveControlRecord
    bounds: ChromeDesktopBounds
    screenX?: number
    screenY?: number
  }> {
    const record = this.validateActiveControl(sessionId, input.controlId as string, capabilityToken)

    // 串行守卫：同一时刻最多一个输入动作在途
    if (record.inFlightAction) {
      throw new Error('CHROME_BUSY: 同一控制内已有动作在途')
    }

    const frameId = input.frameId as string
    if (!record.latestFrame || record.latestFrame.frameId !== frameId) {
      throw new Error('CHROME_FRAME_STALE: 提供的 frameId 与最新观察帧不符')
    }

    record.inFlightAction = true
    try {
      // 输入后不再把旧 Observe 响应重放成新观察结果；frameId 本身仍可复用于后续输入。
      record.latestObservedFrame = undefined

      // frameId 是可复用的截图坐标参考，不是一次性令牌，也不按模型推理耗时失效。

      // 真正输入前才激活 Chrome，观察模式不会抢占前台。
      if (record.mode !== 'control') {
        const activated = await this.helper.activateWindow(record.targetWindow!.windowId, record.targetWindow!.pid)
        this.assertCurrentRecord(record)
        if (!activated.ok || !activated.bounds) {
          throw new Error(activated.error ?? 'CHROME_FOCUS_LOST')
        }
        record.mode = 'control'
        record.targetWindow!.bounds = activated.bounds
        this.broadcastState()
      }

      // 检查前台目标与几何是否一致
      const targetCheck = await this.helper.checkTarget(record.targetWindow!.windowId, record.targetWindow!.pid)
      this.assertCurrentRecord(record)
      if (!targetCheck.ok || !targetCheck.bounds) {
        this.transitionToPaused(record, 'CHROME_FOCUS_LOST', '前台应用不是目标 Chrome 窗口')
        throw new Error('CHROME_FOCUS_LOST')
      }

      const bounds = targetCheck.bounds
      // 检查几何变化（位置或尺寸改变）
      const prevBounds = record.targetWindow!.bounds
      if (
        Math.abs(bounds.x - prevBounds.x) > 2 ||
        Math.abs(bounds.y - prevBounds.y) > 2 ||
        Math.abs(bounds.width - prevBounds.width) > 2 ||
        Math.abs(bounds.height - prevBounds.height) > 2
      ) {
        this.transitionToPaused(record, 'CHROME_GEOMETRY_CHANGED', 'Chrome 窗口位置或大小发生改变')
        throw new Error('CHROME_GEOMETRY_CHANGED')
      }


      let screenX: number | undefined
      let screenY: number | undefined

      if (typeof input.x === 'number' && typeof input.y === 'number') {
        const x = input.x
        const y = input.y
        if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= record.latestFrame.width || y < 0 || y >= record.latestFrame.height) {
          throw new Error('坐标超出截图范围')
        }
        screenX = bounds.x + (x / record.latestFrame.width) * bounds.width
        screenY = bounds.y + (y / record.latestFrame.height) * bounds.height
      }

      return { record, bounds, screenX, screenY }
    } catch (error) {
      record.inFlightAction = false
      throw error
    }
  }

  /**
   * ChromeDesktopClick
   */
  private async handleClick(sessionId: string, toolCallId: string, input: Record<string, unknown>, capabilityToken?: string): Promise<ChromeDesktopToolResponse> {
    if (!Number.isInteger(input.x) || !Number.isInteger(input.y)) throw new Error('图片坐标必须为整数')
    const { record, screenX, screenY } = await this.prepareAction(sessionId, toolCallId, input, capabilityToken)
    const clickCount = input.clickCount === 2 ? 2 : 1

    record.inFlightAction = true
    try {
      const res = await this.helper.click(
        record.targetWindow!.windowId,
        record.targetWindow!.pid,
        screenX!,
        screenY!,
        clickCount,
      )

      this.assertCurrentRecord(record)

      if (!res.ok) {
        throw new Error(res.error ?? 'CHROME_HELPER_FAILED')
      }

      const response: ChromeDesktopToolResponse = {
        kind: 'json',
        value: {
          ok: true,
          action: 'click',
          clickCount,
          targetWindowId: record.targetWindow!.windowId,
        },
      }
      this.setCachedAction(sessionId, record.controlId, toolCallId, 'ChromeDesktopClick', this.computeInputHash(input), response)
      return response
    } catch (e: any) {
      if (e.message?.includes('timeout') || e.message?.includes('超时')) {
        this.transitionToPaused(record, 'CHROME_ACTION_UNCERTAIN', '点击动作执行超时，结果未知')
        throw new Error('CHROME_ACTION_UNCERTAIN')
      }
      throw e
    } finally {
      record.inFlightAction = false
    }
  }

  /**
   * ChromeDesktopScroll
   */
  private async handleScroll(sessionId: string, toolCallId: string, input: Record<string, unknown>, capabilityToken?: string): Promise<ChromeDesktopToolResponse> {
    const deltaY = Number(input.deltaY)
    if (!Number.isInteger(deltaY) || deltaY < -1200 || deltaY > 1200 || deltaY === 0) {
      throw new Error('deltaY 必须为 [-1200, 1200] 区间内非零整数')
    }

    if (!Number.isInteger(input.x) || !Number.isInteger(input.y)) throw new Error('图片坐标必须为整数')
    const { record, screenX, screenY } = await this.prepareAction(sessionId, toolCallId, input, capabilityToken)

    record.inFlightAction = true
    try {
      const res = await this.helper.scroll(
        record.targetWindow!.windowId,
        record.targetWindow!.pid,
        screenX!,
        screenY!,
        deltaY,
      )

      this.assertCurrentRecord(record)

      if (!res.ok) {
        throw new Error(res.error ?? 'CHROME_HELPER_FAILED')
      }

      const response: ChromeDesktopToolResponse = {
        kind: 'json',
        value: {
          ok: true,
          action: 'scroll',
          deltaY,
        },
      }
      this.setCachedAction(sessionId, record.controlId, toolCallId, 'ChromeDesktopScroll', this.computeInputHash(input), response)
      return response
    } catch (e: any) {
      if (e.message?.includes('timeout') || e.message?.includes('超时')) {
        this.transitionToPaused(record, 'CHROME_ACTION_UNCERTAIN', '滚动动作执行超时，结果未知')
        throw new Error('CHROME_ACTION_UNCERTAIN')
      }
      throw e
    } finally {
      record.inFlightAction = false
    }
  }

  /**
   * ChromeDesktopType
   */
  private async handleType(sessionId: string, toolCallId: string, input: Record<string, unknown>, capabilityToken?: string): Promise<ChromeDesktopToolResponse> {
    const text = input.text
    if (typeof text !== 'string' || !text || [...text].length > 4096) {
      throw new Error('text 长度必须在 1-4096 之间')
    }
    // 拒绝控制字符（允许常见非控制文本）
    if (/[\u0000-\u001F\u007F-\u009F]/.test(text)) {
      throw new Error('text 包含不合法的控制字符')
    }

    const { record } = await this.prepareAction(sessionId, toolCallId, input, capabilityToken)

    record.inFlightAction = true
    try {
      const res = await this.helper.type(
        record.targetWindow!.windowId,
        record.targetWindow!.pid,
        text,
      )

      this.assertCurrentRecord(record)

      if (!res.ok) {
        throw new Error(res.error ?? 'CHROME_HELPER_FAILED')
      }

      const response: ChromeDesktopToolResponse = {
        kind: 'json',
        value: {
          ok: true,
          action: 'type',
          characterCount: [...text].length,
        },
      }
      this.setCachedAction(sessionId, record.controlId, toolCallId, 'ChromeDesktopType', this.computeInputHash(input), response)
      return response
    } catch (e: any) {
      if (e.message?.includes('timeout') || e.message?.includes('超时')) {
        this.transitionToPaused(record, 'CHROME_ACTION_UNCERTAIN', '文本输入超时，结果未知')
        throw new Error('CHROME_ACTION_UNCERTAIN')
      }
      throw e
    } finally {
      record.inFlightAction = false
    }
  }

  /**
   * ChromeDesktopPress
   */
  private async handlePress(sessionId: string, toolCallId: string, input: Record<string, unknown>, capabilityToken?: string): Promise<ChromeDesktopToolResponse> {
    const key = input.key as ChromeDesktopAllowedKey
    if (!CHROME_DESKTOP_ALLOWED_KEYS.includes(key)) {
      throw new Error(`不允许的按键: ${key}`)
    }

    const { record } = await this.prepareAction(sessionId, toolCallId, input, capabilityToken)

    record.inFlightAction = true
    try {
      const res = await this.helper.press(
        record.targetWindow!.windowId,
        record.targetWindow!.pid,
        key,
      )

      this.assertCurrentRecord(record)

      if (!res.ok) {
        throw new Error(res.error ?? 'CHROME_HELPER_FAILED')
      }

      const response: ChromeDesktopToolResponse = {
        kind: 'json',
        value: {
          ok: true,
          action: 'press',
          key,
        },
      }
      this.setCachedAction(sessionId, record.controlId, toolCallId, 'ChromeDesktopPress', this.computeInputHash(input), response)
      return response
    } catch (e: any) {
      if (e.message?.includes('timeout') || e.message?.includes('超时')) {
        this.transitionToPaused(record, 'CHROME_ACTION_UNCERTAIN', '按键操作超时，结果未知')
        throw new Error('CHROME_ACTION_UNCERTAIN')
      }
      throw e
    } finally {
      record.inFlightAction = false
    }
  }

  /**
   * ChromeDesktopStop
   */
  private async handleStop(sessionId: string, toolCallId: string, input: Record<string, unknown>, capabilityToken?: string): Promise<ChromeDesktopToolResponse> {
    const controlId = input.controlId as string | undefined
    if (this.activeControl?.sessionId === sessionId && controlId && this.activeControl.controlId === controlId) {
      if (!capabilityToken || !this.activeControl.capabilityToken || this.activeControl.capabilityToken === capabilityToken) {
        this.releaseCurrentControl(true)
      }
    }

    const response: ChromeDesktopToolResponse = {
      kind: 'json',
      value: {
        ok: true,
        status: 'stopped',
      },
    }
    this.setCachedAction(sessionId, controlId, toolCallId, 'ChromeDesktopStop', this.computeInputHash(input), response)
    return response
  }

  /**
   * 校验当前活跃会话与状态
   */
  private validateActiveControl(sessionId: string, controlId?: string, capabilityToken?: string): ActiveControlRecord {
    if (!this.activeControl || this.activeControl.sessionId !== sessionId) {
      throw new Error('CHROME_CAPABILITY_STALE: 无活跃的 Chrome 控制任务')
    }

    if (!controlId || this.activeControl.controlId !== controlId) {
      throw new Error('CHROME_CAPABILITY_STALE: controlId 不匹配')
    }

    if (capabilityToken && this.activeControl.capabilityToken && this.activeControl.capabilityToken !== capabilityToken) {
      throw new Error('CHROME_CAPABILITY_STALE: capabilityToken 不匹配')
    }

    if (isRecoverableChromeDesktopPauseReason(this.activeControl.pauseReason)) {
      if (!this.resumeRecoverableControl(this.activeControl)) {
        throw new Error('CHROME_CAPABILITY_STALE: 无法恢复已授权的 Chrome 控制')
      }
    }

    if (this.activeControl.state !== 'active') {
      throw new Error(`CHROME_CAPABILITY_STALE: 当前控制处于 ${this.activeControl.state} 状态`)
    }

    return this.activeControl
  }

  private assertCurrentRecord(record: ActiveControlRecord, state: ChromeDesktopState = 'active'): void {
    if (this.activeControl !== record || record.state !== state) {
      throw new Error('CHROME_CAPABILITY_STALE: 控制已取消或切换')
    }
  }

  private clearControlFrames(record: ActiveControlRecord): void {
    clearTimeout(record.authorizationTimer)
    record.latestFrame = null
    record.latestObservedFrame = undefined
    record.seenObserveToolCallIds.clear()
    this.actionHistory.clear()
  }

  /** 恢复焦点/几何暂停的同一授权，不重新申请屏幕采集。 */
  private resumeRecoverableControl(record: ActiveControlRecord): boolean {
    if (this.activeControl !== record || record.state !== 'paused' || !isRecoverableChromeDesktopPauseReason(record.pauseReason)) {
      return record.state === 'active'
    }

    const shortcutSuccess = this.registerShortcutFn(record.shortcut, () => this.handleEmergencyStop())
    if (!shortcutSuccess) {
      this.transitionToError(record, 'CHROME_STOP_SHORTCUT_UNAVAILABLE', '无法恢复全局停止快捷键，可能被占用')
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

  private transitionToPaused(record: ActiveControlRecord, reason: ChromeDesktopErrorCode, message: string): void {
    if (this.activeControl !== record) return
    this.clearControlFrames(record)
    record.state = 'paused'
    record.pauseReason = reason
    record.errorMessage = message
    this.helper.cancel().catch(() => {})
    this.unregisterShortcutFn(record.shortcut)
    this.setThrottlingFn(true)
    this.broadcastState()
  }

  private transitionToError(record: ActiveControlRecord, error: ChromeDesktopErrorCode, message: string): void {
    if (this.activeControl !== record) return
    this.clearControlFrames(record)
    record.state = 'error'
    record.pauseReason = error
    record.errorMessage = message
    this.helper.cancel().catch(() => {})
    this.unregisterShortcutFn(record.shortcut)
    this.setThrottlingFn(true)
    this.broadcastState()
  }

  /**
   * 释放当前控制并清理全部资源
   */
  releaseCurrentControl(resetStateToStopped = true): void {
    if (!this.activeControl) {
      this.actionHistory.clear()
      return
    }

    const record = this.activeControl
    this.nextRunGeneration++
    this.clearControlFrames(record)

    this.helper.cancel().catch(() => {})
    this.unregisterShortcutFn(record.shortcut)
    this.setThrottlingFn(true)
    this.actionHistory.clear()

    if (resetStateToStopped) {
      record.state = 'stopped'
      this.broadcastState()
      this.activeControl = null
    }
  }

  /**
   * 当指定会话结束或切出时调用
   * 支持传入 capabilityToken / controlId 进行代次绑定，防止旧 run 迟到释放破坏新控制
   */
  releaseSessionControl(sessionId: string, capabilityToken?: string, controlId?: string): void {
    if (!this.activeControl || this.activeControl.sessionId !== sessionId) {
      return
    }

    if (capabilityToken && this.activeControl.capabilityToken && this.activeControl.capabilityToken !== capabilityToken) {
      console.warn('[ChromeDesktopService] 忽略迟到的释放请求: capabilityToken 与当前控制不匹配', {
        sessionId,
      })
      return
    }

    if (controlId && this.activeControl.controlId !== controlId) {
      console.warn('[ChromeDesktopService] 忽略迟到的释放请求: controlId 与当前控制不匹配', {
        expected: this.activeControl.controlId,
        received: controlId,
      })
      return
    }

    this.releaseCurrentControl(true)
  }
}

export const chromeDesktopService = new ChromeDesktopService()
