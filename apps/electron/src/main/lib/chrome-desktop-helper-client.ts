/**
 * Chrome Desktop Swift Helper 客户端
 *
 * 负责与 native/chrome-desktop-helper 子进程通过 stdin/stdout JSON 通信。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ChromeDesktopAllowedKey,
  ChromeDesktopBounds,
  ChromeDesktopWindowInfo,
} from '@copis/shared'

export interface HelperPermissionsResult {
  accessibility: boolean
  screenRecording: boolean
  helperPath: string
}

export interface IChromeDesktopHelperClient {
  isAvailable(): boolean
  start(): Promise<void>
  stop(): void
  checkPermissions(): Promise<HelperPermissionsResult>
  listWindows(): Promise<ChromeDesktopWindowInfo[]>
  activateWindow(windowId: number, pid: number): Promise<{ ok: boolean; bounds?: ChromeDesktopBounds; error?: string }>
  getWindowBounds(windowId: number, pid: number): Promise<{ ok: boolean; bounds?: ChromeDesktopBounds; error?: string }>
  checkTarget(windowId: number, pid: number): Promise<{ ok: boolean; bounds?: ChromeDesktopBounds; error?: string }>
  click(windowId: number, pid: number, screenX: number, screenY: number, clickCount?: number): Promise<{ ok: boolean; error?: string }>
  scroll(windowId: number, pid: number, screenX: number, screenY: number, deltaY: number): Promise<{ ok: boolean; error?: string }>
  type(windowId: number, pid: number, text: string): Promise<{ ok: boolean; error?: string }>
  press(windowId: number, pid: number, key: ChromeDesktopAllowedKey): Promise<{ ok: boolean; error?: string }>
  cancel(): Promise<void>
}

export interface ResolveHelperBinaryOptions {
  isPackaged?: boolean
  resourcesPath?: string
}

export function resolveHelperBinaryPath(options?: ResolveHelperBinaryOptions): string | null {
  if (process.platform !== 'darwin') return null

  const arch = process.arch
  const targetDirName = `darwin-${arch}`
  const binName = 'chrome-desktop-helper'

  let isPackaged = options?.isPackaged
  let resourcesPath = options?.resourcesPath

  if (isPackaged === undefined) {
    if (process.versions?.electron) {
      try {
        const electron = require('electron')
        isPackaged = typeof electron?.app?.isPackaged === 'boolean' ? electron.app.isPackaged : false
        resourcesPath = isPackaged ? process.resourcesPath : undefined
      } catch {
        isPackaged = false
      }
    } else {
      isPackaged = false
    }
  }

  const candidates: string[] = []

  if (isPackaged && resourcesPath) {
    candidates.push(join(resourcesPath, 'bin', targetDirName, binName))
    candidates.push(join(resourcesPath, 'bin', binName))
  } else {
    // 开发环境与测试环境
    candidates.push(join(__dirname, '../../../resources/bin', targetDirName, binName))
    candidates.push(join(__dirname, '../../resources/bin', targetDirName, binName))
    candidates.push(join(process.cwd(), 'apps/electron/resources/bin', targetDirName, binName))
    candidates.push(join(process.cwd(), 'resources/bin', targetDirName, binName))
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return null
}

export class ChromeDesktopHelperClient implements IChromeDesktopHelperClient {
  private childProcess: ChildProcess | null = null
  private pendingRequests = new Map<string, {
    resolve: (value: any) => void
    reject: (reason?: any) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  private lineBuffer = ''
  private helperPath: string | null = null

  constructor(helperPathOverride?: string, private readonly commandTimeoutMs = 5000) {
    this.helperPath = helperPathOverride ?? resolveHelperBinaryPath()
  }

  isAvailable(): boolean {
    return this.helperPath !== null && existsSync(this.helperPath)
  }

  async start(): Promise<void> {
    if (this.childProcess) return
    if (!this.isAvailable() || !this.helperPath) {
      throw new Error('Chrome desktop helper 二进制不可用')
    }

    const child = spawn(this.helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.childProcess = child
    this.lineBuffer = ''

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (this.childProcess === child) this.handleStdout(chunk)
    })

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      // 诊断日志输出，不含敏感数据
      console.log(`[ChromeDesktopHelper:stderr] ${chunk.trim()}`)
    })

    child.on('exit', (code, signal) => {
      console.log(`[ChromeDesktopHelper] 进程退出 code=${code} signal=${signal}`)
      if (this.childProcess === child) {
        this.cleanupPending(new Error(`Helper 进程已退出 (code: ${code}, signal: ${signal})`))
        this.childProcess = null
        this.lineBuffer = ''
      }
    })

    child.on('error', (err) => {
      console.error('[ChromeDesktopHelper] 进程错误:', err)
      if (this.childProcess === child) {
        this.cleanupPending(err)
        this.childProcess = null
        this.lineBuffer = ''
      }
    })
  }

  stop(): void {
    if (!this.childProcess) return
    try {
      this.childProcess.stdin?.end()
    } catch {
      // ignore
    }
    const child = this.childProcess
    child.kill('SIGTERM')
    this.childProcess = null
    this.lineBuffer = ''
    this.cleanupPending(new Error('Helper 进程已手动终止'))
  }

  private cleanupPending(error: Error): void {
    for (const [id, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timer)
      req.reject(error)
    }
    this.pendingRequests.clear()
  }

  private handleStdout(chunk: string): void {
    this.lineBuffer += chunk
    const lines = this.lineBuffer.split('\n')
    this.lineBuffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      try {
        const parsed = JSON.parse(trimmed) as { id?: string; ok?: boolean; error?: string; [key: string]: any }
        if (!parsed.id) continue

        const req = this.pendingRequests.get(parsed.id)
        if (req) {
          clearTimeout(req.timer)
          this.pendingRequests.delete(parsed.id)
          req.resolve(parsed)
        }
      } catch (e) {
        console.warn('[ChromeDesktopHelper] 解析 stdout JSON 失败:', trimmed, e)
      }
    }
  }

  private sendCommand<T = any>(action: string, params: Record<string, any> = {}, timeoutMs = 5000): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.childProcess || this.childProcess.killed) {
        return reject(new Error('Helper 进程未启动'))
      }

      const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      const child = this.childProcess
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Helper 命令超时 (${action}, ${timeoutMs}ms)`))
        if (this.childProcess === child) this.stop()
      }, timeoutMs)

      this.pendingRequests.set(id, { resolve, reject, timer })

      const payload = JSON.stringify({ id, action, ...params }) + '\n'
      this.childProcess.stdin?.write(payload, 'utf8', (err) => {
        if (err) {
          clearTimeout(timer)
          this.pendingRequests.delete(id)
          reject(err)
        }
      })
    })
  }

  async checkPermissions(): Promise<HelperPermissionsResult> {
    await this.start()
    const res = await this.sendCommand<{ ok: boolean; accessibility: boolean; screenRecording: boolean; helperPath: string }>('check_permissions')
    return {
      accessibility: res.accessibility === true,
      screenRecording: res.screenRecording === true,
      helperPath: res.helperPath || this.helperPath || '',
    }
  }

  async listWindows(): Promise<ChromeDesktopWindowInfo[]> {
    await this.start()
    const res = await this.sendCommand<{ ok: boolean; windows?: ChromeDesktopWindowInfo[] }>('list_windows', {}, this.commandTimeoutMs)
    return res.windows ?? []
  }

  async activateWindow(windowId: number, pid: number): Promise<{ ok: boolean; bounds?: ChromeDesktopBounds; error?: string }> {
    await this.start()
    return this.sendCommand('activate_window', { windowId, pid })
  }

  async getWindowBounds(windowId: number, pid: number): Promise<{ ok: boolean; bounds?: ChromeDesktopBounds; error?: string }> {
    await this.start()
    return this.sendCommand('get_window_bounds', { windowId, pid })
  }

  async checkTarget(windowId: number, pid: number): Promise<{ ok: boolean; bounds?: ChromeDesktopBounds; error?: string }> {
    await this.start()
    return this.sendCommand('check_target', { windowId, pid })
  }

  async click(windowId: number, pid: number, screenX: number, screenY: number, clickCount = 1): Promise<{ ok: boolean; error?: string }> {
    await this.start()
    return this.sendCommand('click', { windowId, pid, screenX, screenY, clickCount })
  }

  async scroll(windowId: number, pid: number, screenX: number, screenY: number, deltaY: number): Promise<{ ok: boolean; error?: string }> {
    await this.start()
    return this.sendCommand('scroll', { windowId, pid, screenX, screenY, deltaY })
  }

  async type(windowId: number, pid: number, text: string): Promise<{ ok: boolean; error?: string }> {
    await this.start()
    return this.sendCommand('type', { windowId, pid, text })
  }

  async press(windowId: number, pid: number, key: ChromeDesktopAllowedKey): Promise<{ ok: boolean; error?: string }> {
    await this.start()
    return this.sendCommand('press', { windowId, pid, key })
  }

  async cancel(): Promise<void> {
    if (!this.childProcess) return
    try {
      await this.sendCommand('cancel', {}, 1000)
    } catch {
      // 无法确认 helper 已处理取消时必须终止进程，防止后台操作继续投递输入。
      this.stop()
    }
  }
}
