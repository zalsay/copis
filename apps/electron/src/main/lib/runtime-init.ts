/**
 * Pi runtime 状态协调器。
 *
 * Windows 下不再扫描系统 PATH、注册表、Git Bash 或 WSL。外部 runtime
 * 由 Rust HTTP API 解析和启动，Electron 只异步读取状态，避免主进程被检测命令卡住。
 */

import type {
  GitBashStatus,
  RuntimeInitOptions,
  RuntimeStatus,
  ShellEnvironmentStatus,
  WslStatus,
} from '@copis/shared'
import { COPIS_HTTP_API_HOST, resolveCopisHttpApiPort } from '@copis/shared/config'
import { app } from 'electron'

const RUNTIME_API_PORT = resolveCopisHttpApiPort({
  configuredPort: process.env.COPIS_HTTP_API_PORT,
  isPackaged: app.isPackaged === true,
})
const RUNTIME_STATUS_URL = `http://${COPIS_HTTP_API_HOST}:${RUNTIME_API_PORT}/api/runtime/status`
const RUNTIME_CHECK_URL = `http://${COPIS_HTTP_API_HOST}:${RUNTIME_API_PORT}/api/runtime/check`
// Rust 会并行启动外部 Node/Git/Bash，Windows 冷启动可能需要数秒；请求仍有硬超时，
// 但不能在 Rust 完成一次探测前就取消请求并制造重复探测。
const REQUEST_TIMEOUT_MS = 12_000
const STARTUP_RETRY_COUNT = 3
const STARTUP_RETRY_DELAY_MS = 250

let runtimeStatusCache: RuntimeStatus | null = null
let isInitialized = false
let refreshPromise: Promise<RuntimeStatus> | null = null

interface RuntimeApiRecord {
  readonly [key: string]: unknown
}

function isRecord(value: unknown): value is RuntimeApiRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRuntimeStatus(value: unknown): value is RuntimeStatus {
  if (!isRecord(value)) return false
  return isRecord(value.node) && isRecord(value.git) && isRecord(value.bun)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function requestRuntimeStatus(forceRefresh = false): Promise<RuntimeStatus> {
  let lastError: unknown

  for (let attempt = 0; attempt < STARTUP_RETRY_COUNT; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(forceRefresh ? RUNTIME_CHECK_URL : RUNTIME_STATUS_URL, {
        method: forceRefresh ? 'POST' : 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })
      const payload: unknown = await response.json()
      if (!response.ok) {
        throw new Error(
          isRecord(payload) && typeof payload.error === 'string'
            ? payload.error
            : `Rust runtime API 返回 HTTP ${response.status}`,
        )
      }
      if (!isRuntimeStatus(payload)) {
        throw new Error('Rust runtime API 返回了无效状态')
      }
      return payload
    } catch (error: unknown) {
      lastError = error
      if (attempt + 1 < STARTUP_RETRY_COUNT) await delay(STARTUP_RETRY_DELAY_MS)
    } finally {
      clearTimeout(timeout)
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError ?? 'Rust runtime API 不可用')
  console.warn(`[Pi runtime] Rust runtime API 不可用，使用失败状态: ${message}`)
  return createUnavailableRuntimeStatus(message)
}

function createUnavailableRuntimeStatus(error: string): RuntimeStatus {
  const gitBash: GitBashStatus = {
    available: false,
    path: null,
    version: null,
    error,
  }
  const wsl: WslStatus = {
    available: false,
    version: null,
    defaultDistro: null,
    distros: [],
    error: 'Pi runtime 不使用 WSL',
  }
  const shell: ShellEnvironmentStatus = {
    gitBash,
    wsl,
    recommended: null,
  }

  return {
    node: { available: false, version: null, path: null, error },
    bun: { available: false, version: null, path: null, source: null, error: 'Pi runtime 不依赖 Bun' },
    git: { available: false, version: null, path: null, error },
    shell,
    envLoaded: false,
    initializedAt: Date.now(),
  }
}

async function refreshRuntimeStatus(forceRefresh = false): Promise<RuntimeStatus> {
  if (refreshPromise) return refreshPromise

  refreshPromise = requestRuntimeStatus(forceRefresh)
    .then((status) => {
      runtimeStatusCache = status
      isInitialized = true
      return status
    })
    .finally(() => {
      refreshPromise = null
    })

  return refreshPromise
}

/** 异步读取 Rust 管理的外部 Pi runtime 状态。options 仅保留 IPC 兼容性。 */
export async function initializeRuntime(options: RuntimeInitOptions = {}): Promise<RuntimeStatus> {
  void options
  console.log('[Pi runtime] 通过 Rust API 读取外部 Node/Git runtime 状态')
  return refreshRuntimeStatus()
}

export function getRuntimeStatus(): RuntimeStatus | null {
  return runtimeStatusCache
}

export function isRuntimeInitialized(): boolean {
  return isInitialized
}

export async function reinitializeRuntime(options: RuntimeInitOptions = {}): Promise<RuntimeStatus> {
  void options
  runtimeStatusCache = null
  isInitialized = false
  return refreshRuntimeStatus(true)
}

export { getGitRepoStatus } from './git-detector'
