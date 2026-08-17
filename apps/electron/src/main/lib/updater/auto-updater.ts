/**
 * 主程序自动更新核心模块
 *
 * 检查更新通过本地 Rust HTTP API 读取统一 client manifest；
 * 下载安装包后由用户选择立即或空闲时打开安装程序。
 */

import { createHash } from 'node:crypto'
import { mkdir, open, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { BrowserWindow, app, shell } from 'electron'
import type { UpdateStatus } from './updater-types'
import { UPDATER_IPC_CHANNELS } from './updater-types'
import { createIdleInstallScheduler } from './idle-install-scheduler'
import { checkAppUpdateViaRustApi } from '../app-update-service'
import { autoInstallDownloadedUpdate } from '../auto-install-update'
import { migrateLegacyAgentWorkspaceProjectDirectories } from '../agent-workspace-manager'

/** 当前更新状态 */
let currentStatus: UpdateStatus = { status: 'idle' }

/** 主窗口引用 */
let win: BrowserWindow | null = null

/** 定时检查定时器 */
let checkInterval: ReturnType<typeof setInterval> | null = null

/** 由 Agent 服务注入，状态始终查询 Rust Pi Worker。 */
let hasActiveAgents = (): boolean | Promise<boolean> => false

/**
 * 用户选择「空闲时更新」后，等待所有 Agent 结束再打开安装包。
 *
 * 状态检查留在主进程，避免渲染进程漏掉后台运行或其他窗口中的 Agent。
 */
const idleInstallScheduler = createIdleInstallScheduler({
  canInstall: async () => {
    if (currentStatus.status !== 'downloaded') return false
    try {
      return !(await hasActiveAgents())
    } catch (error) {
      // 无法确认 Worker 状态时保守地不安装更新。
      console.warn('[更新] Pi Worker 状态读取失败，继续等待空闲:', error)
      return false
    }
  },
  install: () => {
    console.log('[更新] 当前没有运行中的 Agent，开始自动安装已下载更新')
    void installDownloadedUpdate()
  },
})

/** 更新状态并推送给渲染进程 */
function setStatus(status: UpdateStatus): void {
  currentStatus = status
  if (status.status !== 'downloaded') {
    idleInstallScheduler.cancel()
  }
  win?.webContents?.send(UPDATER_IPC_CHANNELS.ON_STATUS_CHANGED, status)
}

/**
 * 绑定更新器所需的主窗口与 Agent 状态。
 */
export function configureUpdater(
  mainWindow: BrowserWindow,
  options?: { hasActiveAgents?: () => boolean | Promise<boolean> },
): void {
  hasActiveAgents = options?.hasActiveAgents ?? hasActiveAgents
  win = mainWindow
}

/** 获取当前更新状态 */
export function getUpdateStatus(): UpdateStatus {
  return currentStatus
}

/** 通过 Rust API 手动检查主程序更新 */
export async function checkForUpdates(): Promise<void> {
  // 每次进入更新检查入口都尝试迁移旧工作区目录；迁移失败不得阻断更新状态机。
  try {
    migrateLegacyAgentWorkspaceProjectDirectories()
  } catch (error) {
    console.error('[更新] 工作区旧项目目录迁移失败（更新检查继续）:', error)
  }

  // 已在下载中或已下载完成，不重复检查
  if (currentStatus.status === 'downloading' || currentStatus.status === 'downloaded') {
    console.log('[更新] 跳过检查：已在下载中或已下载完成')
    return
  }

  try {
    setStatus({ status: 'checking' })
    const result = await checkAppUpdateViaRustApi()
    if (!result.available || !result.version || !result.url) {
      setStatus({ status: 'not-available' })
      return
    }
    setStatus({
      status: 'available',
      version: result.version,
      releaseNotes: result.releaseNotes,
      downloadUrl: result.url,
      fileSha256: result.sha256,
      fileSize: result.size,
    })
  } catch (err) {
    console.error('[更新] Rust API 检查更新失败:', err)
    setStatus({
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** 下载主程序更新安装包 */
export async function downloadAppUpdate(): Promise<void> {
  if (currentStatus.status !== 'available' || !currentStatus.downloadUrl) {
    throw new Error('没有可下载的更新，请先检查更新')
  }
  const { version, downloadUrl, fileSha256, fileSize } = currentStatus
  const total = fileSize ?? 0
  const startedAt = Date.now()
  setStatus({
    status: 'downloading',
    version,
    progress: { percent: 0, transferred: 0, total, bytesPerSecond: 0 },
  })

  try {
    const response = await fetch(downloadUrl, { signal: AbortSignal.timeout(20 * 60 * 1000) })
    if (!response.ok) {
      throw new Error(`更新下载失败（HTTP ${response.status}）`)
    }
    if (!response.body) {
      throw new Error('更新下载响应没有内容')
    }

    const fileName = basename(new URL(downloadUrl).pathname) || `Copis-${version}.dmg`
    const downloadDir = join(app.getPath('userData'), 'downloads')
    await mkdir(downloadDir, { recursive: true })
    const filePath = join(downloadDir, fileName)
    const hash = createHash('sha256')
    const reader = response.body.getReader()
    const fileHandle = await open(filePath, 'w')
    let transferred = 0
    let lastProgressAt = 0

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        hash.update(value)
        await fileHandle.write(value)
        transferred += value.byteLength
        const now = Date.now()
        if (now - lastProgressAt >= 250 || transferred === total) {
          lastProgressAt = now
          const seconds = Math.max(1, (now - startedAt) / 1000)
          setStatus({
            status: 'downloading',
            version,
            progress: {
              percent: total > 0 ? Math.min(100, (transferred / total) * 100) : 0,
              transferred,
              total,
              bytesPerSecond: transferred / seconds,
            },
          })
        }
      }
      await fileHandle.close()
    } catch (error) {
      await fileHandle.close().catch(() => undefined)
      await rm(filePath, { force: true })
      throw error
    }

    if (fileSha256 && hash.digest('hex') !== fileSha256.toLowerCase()) {
      await rm(filePath, { force: true })
      throw new Error('更新安装包校验失败，请重新下载')
    }
    if (fileSize !== undefined && transferred !== fileSize) {
      await rm(filePath, { force: true })
      throw new Error('更新安装包大小不一致，请重新下载')
    }

    setStatus({ status: 'downloaded', version, filePath })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    setStatus({ status: 'error', error: message })
    throw error
  }
}

/**
 * 请求在没有运行中 Agent 时打开已下载的安装包。
 *
 * @returns 是否已接受请求；仅 downloaded 状态可排队。
 */
export function installWhenIdle(): boolean {
  if (currentStatus.status !== 'downloaded') {
    console.warn('[更新] 跳过空闲安装：当前没有已下载的更新')
    return false
  }

  console.log('[更新] 已请求空闲安装，等待所有 Agent 结束')
  idleInstallScheduler.request()
  return true
}

/** 取消尚未执行的空闲安装请求。 */
export function cancelIdleInstall(): void {
  idleInstallScheduler.cancel()
  console.log('[更新] 已取消空闲安装请求')
}

/**
 * 自动安装已下载的更新。
 *
 * 所有安装入口最终都经过这里：即使调用方绕过空闲调度器，也会在 Agent
 * 运行时等待；在真正安装前再次检查一次，避免检查与退出之间启动新 Agent。
 */
async function installDownloadedUpdate(): Promise<void> {
  if (currentStatus.status !== 'downloaded' || !currentStatus.filePath) {
    console.warn('[更新] 没有可安装的已下载更新')
    return
  }

  let activeAgents: boolean
  try {
    activeAgents = await hasActiveAgents()
  } catch (error) {
    console.warn('[更新] Pi Worker 状态读取失败，继续等待空闲:', error)
    installWhenIdle()
    return
  }
  if (activeAgents) {
    console.log('[更新] 检测到运行中的 Agent，改为等待空闲后安装')
    installWhenIdle()
    return
  }

  const filePath = currentStatus.filePath
  let result
  try {
    result = await autoInstallDownloadedUpdate(filePath, process.platform)
  } catch (error) {
    console.error('[更新] 自动安装失败，改为打开安装包:', error)
    const openError = await shell.openPath(filePath)
    if (openError) {
      console.error('[更新] 打开安装包失败:', openError)
    }
    return
  }
  if (!result.installed) {
    const error = await shell.openPath(filePath)
    if (error) {
      console.error('[更新] 打开安装包失败:', error)
    }
    return
  }

  console.log('[更新] 已安装新版本，准备重启 Copis')
  if (app.isPackaged) {
    app.relaunch()
    app.exit(0)
  }
}

/** 清理更新器资源（定时器等） */
export function cleanupUpdater(): void {
  if (checkInterval) {
    clearInterval(checkInterval)
    checkInterval = null
  }
  idleInstallScheduler.dispose()
}

/**
 * 初始化自动更新
 *
 * @param mainWindow - 主窗口实例，用于推送更新状态
 */
export function initAutoUpdater(mainWindow: BrowserWindow): void {
  configureUpdater(mainWindow)

  // 启动后延迟 10 秒首次检查
  setTimeout(() => {
    console.log('[更新] 首次自动检查更新')
    void checkForUpdates()
  }, 10_000)

  // 每 4 小时自动检查一次
  checkInterval = setInterval(() => {
    console.log('[更新] 定时自动检查更新')
    void checkForUpdates()
  }, 4 * 60 * 60 * 1000)

  // 窗口关闭时清理定时器
  mainWindow.on('closed', () => {
    if (checkInterval) {
      clearInterval(checkInterval)
      checkInterval = null
    }
    idleInstallScheduler.dispose()
    win = null
  })

  console.log('[更新] 自动更新模块已初始化（Rust API 检查）')
}
