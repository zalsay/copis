/**
 * Copis 客户端稳定设备标识与聊天室本地路径。
 *
 * 设备标识是本机 WebSync 和聊天室共用的唯一来源；聊天室路径只接受
 * 受限组件，避免把用户输入直接交给 path.join 造成目录穿越。
 */

import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { getClientDevicePath, getWebSyncStatePath } from './config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'

export {
  getClientDevicePath,
  getChatRoomsRootPath,
  getChatRoomPath,
  getChatRoomConfigPath,
  getChatRoomAgentPath,
  getChatRoomAgentSessionDir,
  getChatRoomAgentSessionMetaPath,
  getChatRoomAgentSessionMessagesPath,
  getChatRoomAgentProjectPath,
  getChatRoomAgentInboxPath,
  getChatRoomAgentSkillsSnapshotPath,
} from './config-paths'

interface ClientDeviceFile {
  version: 1
  deviceId: string
  createdAt: number
}

const DEVICE_ID_MAX_LENGTH = 128
const DEVICE_FILE_LOCK_TIMEOUT_MS = 5_000
const DEVICE_FILE_LOCK_STALE_MS = 30_000
const DEVICE_FILE_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4))

function isValidDeviceId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= DEVICE_ID_MAX_LENGTH
    && value.trim() === value
    && !/[\s\u0000-\u001f\u007f]/.test(value)
    && !/[\\/]/.test(value)
}

function isValidClientDeviceFile(value: unknown): value is ClientDeviceFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 3 || !keys.every((key) => key === 'version' || key === 'deviceId' || key === 'createdAt')) {
    return false
  }

  return record.version === 1
    && isValidDeviceId(record.deviceId)
    && typeof record.createdAt === 'number'
    && Number.isFinite(record.createdAt)
    && Number.isInteger(record.createdAt)
    && record.createdAt >= 0
}

function readValidClientDevice(path: string): ClientDeviceFile | null {
  const raw = readJsonFileSafe<unknown>(path)
  return isValidClientDeviceFile(raw) ? raw : null
}

function repairClientDevicePermissions(path: string): void {
  try {
    chmodSync(path, 0o600)
  } catch (error) {
    if (process.platform === 'win32') return
    throw new Error('客户端设备文件权限修复失败', { cause: error })
  }
}

function waitForDeviceFilePublisher(): void {
  try {
    Atomics.wait(DEVICE_FILE_WAIT_BUFFER, 0, 0, 2)
  } catch {
    // 某些运行时不允许主线程阻塞等待时，立即重试即可。
  }
}

/** 尝试取得同目录发布锁；已有有效赢家时返回 false。 */
function acquireDeviceFileLock(lockPath: string, targetPath: string): boolean {
  const deadline = Date.now() + DEVICE_FILE_LOCK_TIMEOUT_MS

  for (;;) {
    try {
      mkdirSync(lockPath)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw error

      if (readValidClientDevice(targetPath)) return false

      try {
        const lockStats = statSync(lockPath)
        if (Date.now() - lockStats.mtimeMs > DEVICE_FILE_LOCK_STALE_MS) {
          rmSync(lockPath, { recursive: true, force: true })
          continue
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw statError
      }

      if (Date.now() >= deadline) {
        throw new Error('获取客户端设备文件锁超时')
      }
      waitForDeviceFilePublisher()
    }
  }
}

function removeInvalidDeviceTarget(path: string): void {
  if (!existsSync(path)) return
  const stats = lstatSync(path)
  if (stats.isDirectory()) {
    throw new Error('客户端设备文件路径不是普通文件')
  }
  unlinkSync(path)
}

/** 用 staging + 硬链接执行不可覆盖的原子发布。 */
function publishClientDeviceFile(path: string, file: ClientDeviceFile): boolean {
  const stagingPath = `${path}.${process.pid}.${randomUUID()}.staging`
  try {
    writeJsonFileAtomic(stagingPath, file, false, 0o600)
    try {
      linkSync(stagingPath, path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
  } finally {
    rmSync(stagingPath, { force: true })
    rmSync(`${stagingPath}.tmp`, { force: true })
    rmSync(`${stagingPath}.bak`, { force: true })
  }
}

/**
 * 读取或创建本机稳定设备 ID。
 *
 * 迁移优先级：client-device.json > web-sync-state.json.deviceId > UUID v4。
 * 设备 ID 不写入日志，文件权限固定为仅当前用户可读写。
 */
export function getOrCreateClientDeviceId(): string {
  const clientDevicePath = getClientDevicePath()
  const current = readValidClientDevice(clientDevicePath)
  if (current) {
    repairClientDevicePermissions(clientDevicePath)
    return current.deviceId
  }

  const lockPath = `${clientDevicePath}.lock`
  for (;;) {
    const ownsLock = acquireDeviceFileLock(lockPath, clientDevicePath)
    if (!ownsLock) {
      const winner = readValidClientDevice(clientDevicePath)
      if (!winner) continue
      repairClientDevicePermissions(clientDevicePath)
      return winner.deviceId
    }

    try {
      const winner = readValidClientDevice(clientDevicePath)
      if (winner) {
        repairClientDevicePermissions(clientDevicePath)
        return winner.deviceId
      }

      removeInvalidDeviceTarget(clientDevicePath)
      const legacy = readJsonFileSafe<{ deviceId?: unknown }>(getWebSyncStatePath())
      const deviceId = isValidDeviceId(legacy?.deviceId) ? legacy.deviceId : randomUUID()
      const file: ClientDeviceFile = {
        version: 1,
        deviceId,
        createdAt: Date.now(),
      }

      if (publishClientDeviceFile(clientDevicePath, file)) {
        repairClientDevicePermissions(clientDevicePath)
        return deviceId
      }
    } finally {
      rmSync(lockPath, { recursive: true, force: true })
    }
  }
}
