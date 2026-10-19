import { rm } from 'node:fs/promises'
import type { ChromeDesktopAllowedKey, ChromeDesktopBounds, ChromeDesktopErrorCode, ChromeDesktopWindowInfo } from '@copis/shared'
import {
  componentEnvironment, componentError, createComponentRuntime, executeComponentCommand, helperFailure,
  MAX_COMPONENT_OUTPUT_BYTES, readComponentImage, resolveComponentInstallation,
  type ChromeDesktopComponentClientOptions, type ComponentRuntime,
} from './chrome-desktop-component-client-runtime'

export interface ChromeDesktopComponentFrame {
  frameId: string
  width: number
  height: number
  capturedAt: number
  bounds: ChromeDesktopBounds
  data: string
}
export type ChromeDesktopComponentAction =
  | { action: 'click'; x: number; y: number; clickCount: 1 | 2 }
  | { action: 'scroll'; x: number; y: number; deltaY: number }
  | { action: 'type'; text: string }
  | { action: 'press'; key: ChromeDesktopAllowedKey }

export interface ChromeDesktopBackend {
  checkPermissions(): Promise<{ accessibility: boolean; screenRecording: boolean; helperPath: string; componentVersion: string }>
  listWindows(): Promise<ChromeDesktopWindowInfo[]>
  connectWindow(windowId: number, pid: number): Promise<ChromeDesktopWindowInfo>
  observe(): Promise<ChromeDesktopComponentFrame>
  input(frameId: string, action: ChromeDesktopComponentAction): Promise<void>
  disconnect(): Promise<void>
  cancel(): Promise<void>
  stop(): void
}
export type { ChromeDesktopComponentClientOptions } from './chrome-desktop-component-client-runtime'

type JsonObject = Record<string, unknown>
interface Connection { runtime: ComponentRuntime; id: string; generation: number }

const nativeErrors: Record<string, ChromeDesktopErrorCode> = {
  CONNECTION_BUSY: 'CHROME_BUSY', BUSY: 'CHROME_BUSY',
  CONNECTION_INVALID: 'CHROME_WINDOW_UNAVAILABLE', WINDOW_UNAVAILABLE: 'CHROME_WINDOW_UNAVAILABLE', CHROME_WINDOW_UNAVAILABLE: 'CHROME_WINDOW_UNAVAILABLE',
  FRAME_UNKNOWN: 'CHROME_FRAME_STALE', FRAME_GEOMETRY_CHANGED: 'CHROME_GEOMETRY_CHANGED', IMAGE_GEOMETRY_CHANGED: 'CHROME_GEOMETRY_CHANGED',
  FOCUS_LOST: 'CHROME_FOCUS_LOST', FOCUS_UNVERIFIED: 'CHROME_FOCUS_LOST',
  SCREEN_PERMISSION_REQUIRED: 'CHROME_SCREEN_PERMISSION_REQUIRED', SCREEN_RECORDING_REQUIRED: 'CHROME_SCREEN_PERMISSION_REQUIRED',
  ACCESSIBILITY_PERMISSION_REQUIRED: 'CHROME_INPUT_PERMISSION_REQUIRED', ACCESSIBILITY_REQUIRED: 'CHROME_INPUT_PERMISSION_REQUIRED',
  CAPTURE_FAILED: 'CHROME_CAPTURE_FAILED', IMAGE_TOO_LARGE: 'CHROME_CAPTURE_FAILED',
  CAPTURE_TIMEOUT: 'CHROME_ACTION_UNCERTAIN', HELPER_TIMEOUT: 'CHROME_ACTION_UNCERTAIN', HELPER_EOF: 'CHROME_ACTION_UNCERTAIN', DAEMON_UNAVAILABLE: 'CHROME_ACTION_UNCERTAIN',
  DAEMON_STOP_TIMEOUT: 'CHROME_ACTION_UNCERTAIN', UNSUPPORTED_PLATFORM: 'CHROME_UNSUPPORTED_CONTEXT', CANCELLED: 'CHROME_CANCELLED',
}

export class ChromeDesktopComponentClient implements ChromeDesktopBackend {
  private generation = 0
  private connection?: Connection
  private readonly runtimes = new Set<ComponentRuntime>()
  private preparation: Promise<unknown> = Promise.resolve()
  private stopping: Promise<void> = Promise.resolve()

  constructor(private readonly options: ChromeDesktopComponentClientOptions = {}) {}

  checkPermissions(): ReturnType<ChromeDesktopBackend['checkPermissions']> {
    return this.prepare(async runtime => {
      const result = await this.permissions(runtime)
      return { accessibility: result.accessibility, screenRecording: result.screenRecording, helperPath: runtime.helperPath, componentVersion: runtime.version }
    })
  }

  listWindows(): Promise<ChromeDesktopWindowInfo[]> {
    return this.prepare(runtime => this.windows(runtime))
  }

  connectWindow(windowId: number, pid: number): Promise<ChromeDesktopWindowInfo> {
    return this.prepare(async (runtime, generation) => {
      if (this.connection) throw componentError('CHROME_BUSY', '已有 Chrome 控制连接')
      try {
        let permissions = await this.permissions(runtime)
        this.assertGeneration(generation)
        // connectWindow 仅在用户确认后调用；自动检查和列窗不能触发系统授权。
        if (!permissions.screenRecording || !permissions.accessibility) {
          permissions = await this.permissions(runtime, true)
          this.assertGeneration(generation)
        }
        if (!permissions.screenRecording) throw componentError('CHROME_SCREEN_PERMISSION_REQUIRED', '请在系统设置中允许 Chrome 组件录制屏幕后重试')
        // AX 尚未授权时仍可只读连接，输入权限继续由原生组件检查。
        const windows = await this.windows(runtime)
        this.assertGeneration(generation)
        if (!windows.some(window => window.windowId === windowId && window.pid === pid)) {
          throw componentError('CHROME_WINDOW_UNAVAILABLE', '所选 Chrome 窗口或进程已变化')
        }
        const result = await this.invoke(runtime, ['connect', '--window', String(windowId)])
        this.assertGeneration(generation)
        const window = parseWindow(result.window)
        if (window.windowId !== windowId || window.pid !== pid) throw componentError('CHROME_WINDOW_UNAVAILABLE', '连接的 Chrome 窗口或进程已变化')
        if (result.connected !== true || typeof result.connectionId !== 'string' || !result.connectionId) throw helperFailure()
        this.connection = { runtime, id: result.connectionId, generation }
        return window
      } catch (error) {
        if (generation !== this.generation) throw componentError('CHROME_CANCELLED', 'Chrome 操作已取消')
        await this.closeRuntime(runtime)
        throw error
      }
    })
  }

  async observe(): Promise<ChromeDesktopComponentFrame> {
    const connection = this.requireConnection()
    const result = await this.invoke(connection.runtime, ['observe', '--connection', connection.id])
    this.assertConnection(connection)
    if (result.connectionId !== connection.id || typeof result.frameId !== 'string' || !result.frameId
      || !dimension(result.width) || !dimension(result.height) || !Number.isSafeInteger(result.capturedAtMs) || (result.capturedAtMs as number) < 0) throw helperFailure()
    const bounds = parseBounds(result.bounds)
    const data = await readComponentImage(connection.runtime, result.imagePath, result.width as number, result.height as number)
    this.assertConnection(connection)
    return { frameId: result.frameId, width: result.width as number, height: result.height as number, capturedAt: result.capturedAtMs as number, bounds, data }
  }

  async input(frameId: string, action: ChromeDesktopComponentAction): Promise<void> {
    const connection = this.requireConnection()
    if (!frameId) throw componentError('CHROME_FRAME_STALE', '缺少原生帧标识，请重新观察')
    const args = [action.action, '--connection', connection.id, '--frame', frameId]
    switch (action.action) {
      case 'click': args.push('--x', String(action.x), '--y', String(action.y), '--count', String(action.clickCount)); break
      case 'scroll': args.push('--x', String(action.x), '--y', String(action.y), '--delta-y', String(action.deltaY)); break
      case 'type': args.push('--text', action.text); break
      case 'press': args.push('--key', action.key); break
    }
    const result = await this.invoke(connection.runtime, args)
    this.assertConnection(connection)
    if (result.sent !== true || result.connectionId !== connection.id || result.frameId !== frameId) throw helperFailure()
  }

  disconnect(): Promise<void> { return this.cancel() }

  cancel(): Promise<void> {
    ++this.generation
    this.connection = undefined
    // 不进入 preparation 或输入队列，立即向各自 runtime 发出独立停止命令。
    const operation = Promise.all([...this.runtimes].map(runtime => this.closeRuntime(runtime))).then(() => {})
    this.stopping = operation
    // stop() 无返回值，且新连接仍会等待这次停止的实际结果。
    void operation.catch(() => {})
    return operation
  }

  stop(): void { void this.cancel().catch(() => {}) }

  private prepare<T>(operation: (runtime: ComponentRuntime, generation: number) => Promise<T>): Promise<T> {
    const generation = this.generation
    const prepared = this.preparation.catch(() => {}).then(async () => {
      await this.stopping
      this.assertGeneration(generation)
      let runtime = this.connection?.runtime
      if (!runtime) {
        const installation = await resolveComponentInstallation(this.options)
        this.assertGeneration(generation)
        runtime = [...this.runtimes].find(item => item.path === installation.path && item.version === installation.version && !item.controller.signal.aborted)
        for (const old of this.runtimes) if (old !== runtime) await this.closeRuntime(old)
        this.assertGeneration(generation)
        if (!runtime) {
          runtime = await createComponentRuntime(installation)
          this.runtimes.add(runtime)
          if (generation !== this.generation) {
            await this.closeRuntime(runtime)
            this.assertGeneration(generation)
          }
        }
      }
      const result = await operation(runtime, generation)
      this.assertGeneration(generation)
      return result
    })
    this.preparation = prepared
    return prepared
  }

  private async permissions(runtime: ComponentRuntime, request = false): Promise<{ accessibility: boolean; screenRecording: boolean }> {
    const result = await this.invoke(runtime, request ? ['permissions', '--request'] : ['permissions'])
    if (typeof result.accessibility !== 'boolean' || typeof result.screenRecording !== 'boolean') throw helperFailure()
    return { accessibility: result.accessibility, screenRecording: result.screenRecording }
  }

  private async windows(runtime: ComponentRuntime): Promise<ChromeDesktopWindowInfo[]> {
    const result = await this.invoke(runtime, ['windows'])
    if (!Array.isArray(result.windows)) throw helperFailure()
    return result.windows.map(parseWindow)
  }

  private requireConnection(): Connection {
    if (!this.connection) throw componentError('CHROME_WINDOW_UNAVAILABLE', '尚未连接 Chrome 窗口')
    return this.connection
  }
  private assertGeneration(generation: number): void {
    if (generation !== this.generation) throw componentError('CHROME_CANCELLED', 'Chrome 操作已取消')
  }
  private assertConnection(connection: Connection): void {
    this.assertGeneration(connection.generation)
    if (this.connection !== connection) throw componentError('CHROME_CANCELLED', 'Chrome 操作已取消')
  }

  private async invoke(runtime: ComponentRuntime, args: string[], stopping = false): Promise<JsonObject> {
    const signal = stopping ? undefined : runtime.controller.signal
    if (signal?.aborted) throw componentError('CHROME_CANCELLED', 'Chrome 操作已取消')
    const execute = this.options.executeCommand ?? executeComponentCommand
    const command = Promise.resolve().then(() => {
      if (signal?.aborted) throw componentError('CHROME_CANCELLED', 'Chrome 操作已取消')
      return execute({ executable: runtime.path, args: [...args, '--json'], env: componentEnvironment(runtime), signal,
        timeoutMs: stopping ? 8000 : this.options.commandTimeoutMs ?? 60_000, maxOutputBytes: MAX_COMPONENT_OUTPUT_BYTES })
    })
    if (!stopping) runtime.commands.add(command)
    let output
    try { output = await command } catch (error) {
      if (signal?.aborted) throw componentError('CHROME_CANCELLED', 'Chrome 操作已取消')
      if (error instanceof Error && error.message.startsWith('CHROME_ACTION_UNCERTAIN:')) throw componentError('CHROME_ACTION_UNCERTAIN', 'Chrome 组件响应超时，动作结果无法确认')
      throw helperFailure()
    } finally { runtime.commands.delete(command) }
    if (signal?.aborted) throw componentError('CHROME_CANCELLED', 'Chrome 操作已取消')
    let result: JsonObject
    try {
      if (Buffer.byteLength(output.stdout) > MAX_COMPONENT_OUTPUT_BYTES) throw helperFailure()
      result = parseObject(JSON.parse(output.stdout))
      if (result.protocolVersion !== 1 || typeof result.ok !== 'boolean') throw helperFailure()
    } catch { throw helperFailure() }
    if (result.ok === false) {
      const error = parseObject(result.error)
      const code = typeof error.code === 'string' && Object.hasOwn(nativeErrors, error.code) ? nativeErrors[error.code] : undefined
      throw componentError(code ?? 'CHROME_HELPER_FAILED', 'Chrome 组件无法完成操作，请按错误类型检查权限、窗口或重新观察')
    }
    if (output.exitCode !== 0) throw helperFailure()
    return result
  }

  private closeRuntime(runtime: ComponentRuntime): Promise<void> {
    if (runtime.stopping) return runtime.stopping
    runtime.controller.abort()
    const operation = (async () => {
      const result = await this.invoke(runtime, ['daemon', 'stop'], true)
      if (result.running !== false) throw helperFailure()
      await Promise.allSettled([...runtime.commands])
      try { await rm(runtime.directory, { recursive: true, force: true }) } catch { throw helperFailure() }
      this.runtimes.delete(runtime)
    })()
    runtime.stopping = operation
    // 停止失败保留目录与固定版本路径，允许后续 cancel 重试，避免丢失后台进程。
    void operation.catch(() => { runtime.stopping = undefined })
    return operation
  }
}

function parseObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw helperFailure()
  return value as JsonObject
}
function dimension(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 1600 }
function parseBounds(value: unknown): ChromeDesktopBounds {
  const bounds = parseObject(value)
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(value => typeof value === 'number' && Number.isFinite(value))
    || (bounds.width as number) <= 0 || (bounds.height as number) <= 0) throw helperFailure()
  return { x: bounds.x as number, y: bounds.y as number, width: bounds.width as number, height: bounds.height as number }
}
function parseWindow(value: unknown): ChromeDesktopWindowInfo {
  const window = parseObject(value)
  if (!Number.isSafeInteger(window.windowId) || (window.windowId as number) <= 0
    || !Number.isSafeInteger(window.pid) || (window.pid as number) <= 0 || typeof window.title !== 'string') throw helperFailure()
  return { windowId: window.windowId as number, pid: window.pid as number, title: window.title, bounds: parseBounds(window.bounds) }
}
