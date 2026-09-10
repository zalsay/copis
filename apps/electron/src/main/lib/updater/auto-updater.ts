/**
 * 主程序自动更新核心模块
 *
 * 检查更新通过本地 Rust HTTP API 读取统一 client manifest；
 * 下载安装包后由用户选择立即或空闲时打开安装程序。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { BrowserWindow, app, shell } from 'electron'
import type { UpdateStatus } from './updater-types'
import { UPDATER_IPC_CHANNELS } from './updater-types'
import { createIdleInstallScheduler } from './idle-install-scheduler'
import { checkAppUpdateViaRustApi } from '../app-update-service'
import { autoInstallDownloadedUpdate } from '../auto-install-update'
import { migrateLegacyAgentWorkspaceProjectDirectories } from '../agent-workspace-manager'

/** 已下载更新的持久化记录结构 */
export interface PersistedDownloadedUpdate {
  version: string
  filePath: string
  fileSha256?: string
  fileSize?: number
  downloadUrl?: string
  downloadedAt: number
}

/** 获取安全的用户数据路径（单测中兜底到 tmpdir） */
function getUserDataPath(): string {
  try {
    return app?.getPath?.('userData') || join(tmpdir(), 'copis-test-userdata')
  } catch {
    return join(tmpdir(), 'copis-test-userdata')
  }
}

/** 主程序更新包固定存储目录：userData/updates/ */
export function getUpdatesDir(): string {
  return join(getUserDataPath(), 'updates')
}

/** 持久化已下载更新的元数据文件路径：userData/downloaded-update.json */
export function getPersistedUpdateFilePath(): string {
  return join(getUserDataPath(), 'downloaded-update.json')
}

/** 解析 semver 版本号 */
function parseSemver(value: string): number[] {
  const [normalized] = value.trim().replace(/^v/i, '').split('-', 1)
  if (!normalized) return [0, 0, 0]
  const parts = normalized.split('.')
  return parts.map((part) => {
    const num = Number(part)
    return Number.isSafeInteger(num) ? num : 0
  })
}

/**
 * 比较两个语义化版本号
 *
 * @returns left > right 返回正数，相等返回 0，left < right 返回负数
 */
export function compareSemver(left: string, right: string): number {
  const leftParts = parseSemver(left)
  const rightParts = parseSemver(right)
  for (let i = 0; i < Math.max(leftParts.length, rightParts.length); i++) {
    const diff = (leftParts[i] ?? 0) - (rightParts[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** 保存已下载更新的元数据 */
export async function savePersistedDownloadedUpdate(info: PersistedDownloadedUpdate): Promise<void> {
  try {
    const filePath = getPersistedUpdateFilePath()
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(info, null, 2), 'utf8')
  } catch (error) {
    console.error('[更新] 持久化已下载更新信息失败:', error)
  }
}

/** 清理已下载更新的元数据及旧安装包 */
export async function clearPersistedDownloadedUpdate(cleanupFile = false): Promise<void> {
  const metaPath = getPersistedUpdateFilePath()
  try {
    if (cleanupFile && existsSync(metaPath)) {
      const raw = await readFile(metaPath, 'utf8')
      const info = JSON.parse(raw) as PersistedDownloadedUpdate
      if (info?.filePath && existsSync(info.filePath)) {
        await rm(info.filePath, { force: true })
      }
    }
  } catch {
    // 忽略清理异常
  }

  try {
    if (existsSync(metaPath)) {
      await rm(metaPath, { force: true })
    }
  } catch {
    // 忽略
  }
}

/** 加载并验证已下载更新的持久化记录 */
export async function loadPersistedDownloadedUpdate(): Promise<PersistedDownloadedUpdate | null> {
  const metaPath = getPersistedUpdateFilePath()
  if (!existsSync(metaPath)) return null

  try {
    const raw = await readFile(metaPath, 'utf8')
    const info = JSON.parse(raw) as PersistedDownloadedUpdate
    if (!info?.version || !info?.filePath) return null

    // 检查文件是否存在
    if (!existsSync(info.filePath)) {
      console.warn('[更新] 持久化记录的安装包文件不存在，清理记录:', info.filePath)
      await clearPersistedDownloadedUpdate(false)
      return null
    }

    // 检查当前运行 App 版本是否已经高于或等于已下载版本（说明已成功更新过了）
    const currentAppVersion = app.getVersion()
    if (currentAppVersion && currentAppVersion !== '0.0.0') {
      if (compareSemver(currentAppVersion, info.version) >= 0) {
        console.log(`[更新] 当前运行版本 (v${currentAppVersion}) 已是或高于下载版本 (v${info.version})，清理旧安装包`)
        await clearPersistedDownloadedUpdate(true)
        return null
      }
    }

    // 检查文件大小是否一致（若有记录）
    if (info.fileSize) {
      const fileStat = await stat(info.filePath)
      if (fileStat.size !== info.fileSize) {
        console.warn('[更新] 安装包大小不匹配，清理损坏安装包')
        await clearPersistedDownloadedUpdate(true)
        return null
      }
    }

    return info
  } catch (error) {
    console.warn('[更新] 读取持久化更新信息失败:', error)
    return null
  }
}

/** 同步尝试从持久化文件中恢复更新状态 */
function tryRestorePersistedUpdateSync(): UpdateStatus {
  try {
    const metaPath = getPersistedUpdateFilePath()
    if (!existsSync(metaPath)) return { status: 'idle' }
    const info = JSON.parse(readFileSync(metaPath, 'utf8')) as PersistedDownloadedUpdate
    if (!info?.version || !info?.filePath) return { status: 'idle' }

    const currentAppVersion = app.getVersion()
    if (currentAppVersion && currentAppVersion !== '0.0.0' && compareSemver(currentAppVersion, info.version) >= 0) {
      // 安装成功后再次启动 app：自动清理已安装版本的安装包与元数据
      try {
        if (existsSync(info.filePath)) {
          unlinkSync(info.filePath)
          console.log(`[更新] 安装成功后再次启动，已自动清理下载安装包: ${info.filePath}`)
        }
        if (existsSync(metaPath)) {
          unlinkSync(metaPath)
        }
      } catch (err) {
        console.warn('[更新] 同步清理已安装安装包失败:', err)
      }
      return { status: 'idle' }
    }

    if (!existsSync(info.filePath)) return { status: 'idle' }

    if (info.fileSize && statSync(info.filePath).size !== info.fileSize) {
      return { status: 'idle' }
    }

    return {
      status: 'downloaded',
      version: info.version,
      filePath: info.filePath,
      fileSha256: info.fileSha256,
      fileSize: info.fileSize,
      downloadUrl: info.downloadUrl,
    }
  } catch {
    return { status: 'idle' }
  }
}

/**
 * 安装成功后再次启动 App 时，自动清理已下载安装包与元数据
 *
 * 1. 若元数据记录的安装包版本 <= 当前运行 App 版本，说明已成功安装，自动清理该安装包与元数据
 * 2. 扫描 updates 目录，清理版本号 <= 当前版本的遗留安装包文件（.dmg / .exe）
 */
export async function cleanupDownloadedUpdatesOnStartup(
  currentVersion = app.getVersion(),
): Promise<void> {
  if (!currentVersion || currentVersion === '0.0.0') return

  // 1. 检查并清理元数据指定的安装包
  const metaPath = getPersistedUpdateFilePath()
  if (existsSync(metaPath)) {
    try {
      const raw = await readFile(metaPath, 'utf8')
      const info = JSON.parse(raw) as PersistedDownloadedUpdate
      if (info?.version && compareSemver(currentVersion, info.version) >= 0) {
        if (info.filePath && existsSync(info.filePath)) {
          await rm(info.filePath, { force: true })
          console.log(`[更新] 安装成功后再次启动，已自动清理下载安装包: ${info.filePath}`)
        }
        await rm(metaPath, { force: true })
      }
    } catch (error) {
      console.warn('[更新] 清理已安装更新元数据失败:', error)
    }
  }

  // 2. 扫描 updates 目录清理已安装版本或更早版本的旧安装包
  const updatesDir = getUpdatesDir()
  if (existsSync(updatesDir)) {
    try {
      const entries = await readdir(updatesDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const lower = entry.name.toLowerCase()
        if (!lower.endsWith('.dmg') && !lower.endsWith('.exe') && !lower.endsWith('.zip')) continue

        const match = entry.name.match(/(\d+\.\d+\.\d+)/)
        if (match?.[1]) {
          const fileVersion = match[1]
          if (compareSemver(currentVersion, fileVersion) >= 0) {
            const fullPath = join(updatesDir, entry.name)
            await rm(fullPath, { force: true })
            console.log(`[更新] 已自动清理已安装的历史安装包: ${fullPath}`)
          }
        }
      }
    } catch (error) {
      console.warn('[更新] 扫描清理 updates 目录失败:', error)
    }
  }
}

/** 当前更新状态（启动时同步恢复已下载状态） */
let currentStatus: UpdateStatus = tryRestorePersistedUpdateSync()

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
  if (currentStatus.status !== 'idle') {
    win?.webContents?.send(UPDATER_IPC_CHANNELS.ON_STATUS_CHANGED, currentStatus)
  }
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

  // 正在下载中，不重复检查
  if (currentStatus.status === 'downloading') {
    console.log('[更新] 跳过检查：正在下载中')
    return
  }

  try {
    setStatus({ status: 'checking' })
    const result = await checkAppUpdateViaRustApi()
    // 兼容旧 Rust 服务：version 是本平台版本，latestVersion 可能来自其他平台。
    const latestVersion = result.version || result.latestVersion
    if (!result.available || !result.version || !result.url) {
      // 远端没有可用更新，说明当前运行版本已是最新，若本地残留已下载的旧包则清理
      await clearPersistedDownloadedUpdate(true)
      setStatus({
        status: 'not-available',
        ...(latestVersion ? { latestVersion, version: latestVersion } : {}),
      })
      return
    }

    // 检查本地是否已有已下载的安装包
    const persisted = await loadPersistedDownloadedUpdate()
    if (persisted && persisted.version) {
      const cmp = compareSemver(persisted.version, result.version)
      if (cmp >= 0) {
        // 已下载版本 >= 远端最新版，说明最新版本已经下载好，保持 downloaded 状态，切换为立即安装
        console.log(`[更新] 本地已下载版本 (v${persisted.version}) >= 远端最新版 (v${result.version})，保持立即安装状态`)
        setStatus({
          status: 'downloaded',
          version: persisted.version,
          latestVersion: result.version,
          filePath: persisted.filePath,
          fileSha256: persisted.fileSha256,
          fileSize: persisted.fileSize,
          downloadUrl: persisted.downloadUrl ?? result.url,
        })
        return
      } else {
        // 已下载版本低于远端最新版！清理旧安装包，切换为下载更新
        console.log(`[更新] 本地已下载版本 (v${persisted.version}) 低于远端最新版 (v${result.version})，需要重新下载最新版`)
        await clearPersistedDownloadedUpdate(true)
      }
    }

    // 切换为可下载状态
    setStatus({
      status: 'available',
      version: result.version,
      ...(latestVersion ? { latestVersion } : {}),
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
  const { version, latestVersion, downloadUrl, fileSha256, fileSize } = currentStatus
  const total = fileSize ?? 0
  const startedAt = Date.now()
  setStatus({
    status: 'downloading',
    version,
    ...(latestVersion ? { latestVersion } : {}),
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
    const downloadDir = getUpdatesDir()
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

    // 下载并校验成功，持久化已下载记录供重启后使用
    await savePersistedDownloadedUpdate({
      version: version || 'unknown',
      filePath,
      fileSha256,
      fileSize: transferred,
      downloadUrl,
      downloadedAt: Date.now(),
    })

    setStatus({
      status: 'downloaded',
      version,
      ...(latestVersion ? { latestVersion } : {}),
      filePath,
    })
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
  void cleanupDownloadedUpdatesOnStartup()

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
