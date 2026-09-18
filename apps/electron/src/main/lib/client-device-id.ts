/**
 * Copis 客户端稳定设备标识与聊天室本地路径。
 *
 * 设备标识是本机 WebSync 和聊天室共用的唯一来源；聊天室路径只接受
 * 受限组件，避免把用户输入直接交给 path.join 造成目录穿越。
 */

import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
} from 'node:fs'
import { getClientDevicePath, getWebSyncStatePath } from './config-paths'
import { writeJsonFileAtomic } from './safe-file'

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

interface DeviceFileLockOwner {
  version: 1
  token: string
  pid: number
  createdAt: number
}

interface DeviceFileLockHandle extends DeviceFileLockOwner {
  lockPath: string
}

const DEVICE_ID_MAX_LENGTH = 128
const DEVICE_FILE_LOCK_TIMEOUT_MS = 5_000
const DEVICE_FILE_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4))
const DEVICE_ID_UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isValidDeviceId(value: unknown): value is string {
  return typeof value === 'string'
    && Buffer.byteLength(value, 'utf8') <= DEVICE_ID_MAX_LENGTH
    && DEVICE_ID_UUID_V4_PATTERN.test(value)
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
    && Number.isSafeInteger(record.createdAt)
    && record.createdAt >= 0
}

function readPureJsonFile<T>(path: string, label: string): T | null {
  let stats
  try {
    stats = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (!stats.isFile()) {
    throw new Error(`${label}路径不是普通文件`)
  }

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`${label}读取失败`, { cause: error })
  }
  if (raw.trim().length === 0) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function readValidClientDevice(path: string): ClientDeviceFile | null {
  const raw = readPureJsonFile<unknown>(path, '客户端设备文件')
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

function readLockOwner(lockPath: string): DeviceFileLockOwner | null {
  const ownerPath = `${lockPath}/owner.json`
  const raw = readPureJsonFile<unknown>(ownerPath, '客户端设备文件锁元数据')
  if (!isValidDeviceFileLockOwner(raw)) return null
  return raw
}

function isValidDeviceFileLockOwner(value: unknown): value is DeviceFileLockOwner {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  return keys.length === 4
    && keys.every((key) => key === 'version' || key === 'token' || key === 'pid' || key === 'createdAt')
    && record.version === 1
    && typeof record.token === 'string'
    && DEVICE_ID_UUID_V4_PATTERN.test(record.token)
    && typeof record.pid === 'number'
    && Number.isSafeInteger(record.pid)
    && record.pid > 0
    && typeof record.createdAt === 'number'
    && Number.isSafeInteger(record.createdAt)
    && record.createdAt >= 0
}

function probeProcess(pid: number): 'alive' | 'dead' | 'unknown' {
  if (pid === process.pid) return 'alive'
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return 'dead'
    if (code === 'EPERM') return 'alive'
    return 'unknown'
  }
}

function reclaimDeadDeviceFileLock(lockPath: string, owner: DeviceFileLockOwner): boolean {
  const reclaimPath = `${lockPath}.reclaim-${owner.token}-${process.pid}-${randomUUID()}`
  try {
    renameSync(lockPath, reclaimPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }

  try {
    const reclaimedOwner = readLockOwner(reclaimPath)
    if (!reclaimedOwner || reclaimedOwner.token !== owner.token) {
      throw new Error('客户端设备文件锁元数据在回收期间发生变化')
    }
    rmSync(reclaimPath, { recursive: true, force: true })
    return true
  } catch (error) {
    // 无法证明仍是同一个 owner 时保留回收目录，避免误删其他进程的锁。
    throw error
  }
}

/** 尝试取得同目录发布锁；已有有效赢家时返回 null。 */
function acquireDeviceFileLock(
  lockPath: string,
  targetPath: string,
  options: { failOnActiveOwner?: boolean } = {},
): DeviceFileLockHandle | null {
  const deadline = Date.now() + DEVICE_FILE_LOCK_TIMEOUT_MS

  for (;;) {
    if (readValidClientDevice(targetPath)) return null

    try {
      mkdirSync(lockPath)
      const owner: DeviceFileLockHandle = {
        lockPath,
        version: 1,
        token: randomUUID(),
        pid: process.pid,
        createdAt: Date.now(),
      }
      writeJsonFileAtomic(`${lockPath}/owner.json`, {
        version: owner.version,
        token: owner.token,
        pid: owner.pid,
        createdAt: owner.createdAt,
      }, true, 0o600)
      return owner
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw error

      if (readValidClientDevice(targetPath)) return null

      let lockStats
      try {
        lockStats = lstatSync(lockPath)
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw statError
      }
      if (!lockStats.isDirectory()) throw new Error('客户端设备文件锁路径不是目录')

      const owner = readLockOwner(lockPath)
      if (!owner) {
        if (Date.now() >= deadline) throw new Error('客户端设备文件锁所有权无法确认')
        waitForDeviceFilePublisher()
        continue
      }

      const processState = probeProcess(owner.pid)
      if (processState === 'alive') {
        if (options.failOnActiveOwner) throw new Error('客户端设备文件锁仍由活动进程持有')
        if (Date.now() >= deadline) throw new Error('客户端设备文件锁仍由活动进程持有')
        waitForDeviceFilePublisher()
        continue
      }
      if (processState === 'unknown') {
        throw new Error('客户端设备文件锁所属进程状态无法确认')
      }
      reclaimDeadDeviceFileLock(lockPath, owner)

      if (Date.now() >= deadline) {
        throw new Error('获取客户端设备文件锁超时')
      }
      waitForDeviceFilePublisher()
    }
  }
}

function hasLockOwnership(lockPath: string, token: string): boolean {
  const owner = readLockOwner(lockPath)
  return owner?.token === token
}

function removeInvalidDeviceTarget(path: string, owner: DeviceFileLockHandle): void {
  if (!hasLockOwnership(owner.lockPath, owner.token)) return
  let stats
  try {
    stats = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!stats.isFile()) {
    throw new Error('客户端设备文件路径不是普通文件')
  }
  unlinkSync(path)
}

/** 用 staging + 硬链接执行不可覆盖的原子发布。 */
function publishClientDeviceFile(path: string, file: ClientDeviceFile, owner: DeviceFileLockHandle): boolean {
  if (!hasLockOwnership(owner.lockPath, owner.token)) return false
  const stagingPath = `${path}.${process.pid}.${randomUUID()}.staging`
  try {
    writeJsonFileAtomic(stagingPath, file, false, 0o600)
    if (!hasLockOwnership(owner.lockPath, owner.token)) return false
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

function removeDeviceFileLockIfOwner(lockPath: string, token: string): boolean {
  if (!hasLockOwnership(lockPath, token)) return false
  rmSync(lockPath, { recursive: true, force: true })
  return true
}

/** 仅供本文件测试验证锁 token 边界，不供业务调用。 */
export const __clientDeviceIdTestHooks = {
  acquire: (lockPath: string, targetPath: string) => acquireDeviceFileLock(lockPath, targetPath, { failOnActiveOwner: true }),
  removeIfOwner: removeDeviceFileLockIfOwner,
  publishIfOwner: (path: string, lockPath: string, token: string, file: ClientDeviceFile): boolean => (
    publishClientDeviceFile(path, file, {
      lockPath,
      token,
      version: 1,
      pid: process.pid,
      createdAt: Date.now(),
    })
  ),
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
    const owner = acquireDeviceFileLock(lockPath, clientDevicePath)
    if (!owner) {
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

      removeInvalidDeviceTarget(clientDevicePath, owner)
      const legacy = readPureJsonFile<{ deviceId?: unknown }>(getWebSyncStatePath(), 'WebSync 状态文件')
      const deviceId = isValidDeviceId(legacy?.deviceId) ? legacy.deviceId : randomUUID()
      const file: ClientDeviceFile = {
        version: 1,
        deviceId,
        createdAt: Date.now(),
      }

      if (publishClientDeviceFile(clientDevicePath, file, owner)) {
        repairClientDevicePermissions(clientDevicePath)
        return deviceId
      }
    } finally {
      removeDeviceFileLockIfOwner(lockPath, owner.token)
    }
  }
}
