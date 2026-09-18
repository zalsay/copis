/**
 * Copis 客户端稳定设备标识与聊天室本地路径。
 *
 * 设备标识是本机 WebSync 和聊天室共用的唯一来源；聊天室路径只接受
 * 受限组件，避免把用户输入直接交给 path.join 造成目录穿越。
 */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants as FS_CONSTANTS,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
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
  dev: number
  ino: number
}

interface DeviceFileLockHandle extends DeviceFileLockOwner {
  lockPath: string
}

interface FileIdentity {
  dev: number
  ino: number
}

interface PureJsonReadResult<T> {
  value: T | null
  identity: FileIdentity
}

const DEVICE_ID_MAX_LENGTH = 128
const DEVICE_FILE_LOCK_TIMEOUT_MS = 5_000
const DEVICE_FILE_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4))
const DEVICE_ID_UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const NO_FOLLOW_FLAG = process.platform === 'win32' ? 0 : FS_CONSTANTS.O_NOFOLLOW
const NON_BLOCKING_FLAG = process.platform === 'win32' ? 0 : FS_CONSTANTS.O_NONBLOCK
const MAX_PURE_JSON_BYTES = 2 * 1024 * 1024

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

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function readFdText(fd: number, label: string): string {
  const chunks: Buffer[] = []
  let total = 0
  const chunk = Buffer.allocUnsafe(16 * 1024)
  for (;;) {
    const length = readSync(fd, chunk, 0, chunk.length, null)
    if (length === 0) break
    total += length
    if (total > MAX_PURE_JSON_BYTES) throw new Error(`${label}内容过大`)
    chunks.push(Buffer.from(chunk.subarray(0, length)))
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

/** 通过同一个 no-follow fd 完成校验、读取和 JSON 解析，避免路径替换竞态。 */
export function readPureJsonFile<T>(path: string, label: string): T | null {
  const result = readPureJsonFileWithIdentity<T>(path, label)
  return result?.value ?? null
}

function readPureJsonFileWithIdentity<T>(path: string, label: string): PureJsonReadResult<T> | null {
  let fd: number
  try {
    fd = openSync(path, FS_CONSTANTS.O_RDONLY | NO_FOLLOW_FLAG | NON_BLOCKING_FLAG)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    if (code === 'ELOOP' || code === 'ENXIO' || code === 'ENOTDIR') {
      throw new Error(`${label}路径不是普通文件`, { cause: error })
    }
    throw new Error(`${label}打开失败`, { cause: error })
  }

  try {
    const stats = fstatSync(fd)
    if (!stats.isFile()) throw new Error(`${label}路径不是普通文件`)
    const identity = { dev: stats.dev, ino: stats.ino }
    const raw = readFdText(fd, label)
    if (raw.trim().length === 0) return { value: null, identity }
    try {
      return { value: JSON.parse(raw) as T, identity }
    } catch {
      return { value: null, identity }
    }
  } finally {
    closeSync(fd)
  }
}

function readValidClientDevice(path: string): ClientDeviceFile | null {
  const raw = readPureJsonFile<unknown>(path, '客户端设备文件')
  return isValidClientDeviceFile(raw) ? raw : null
}

function repairClientDevicePermissions(path: string): void {
  let fd: number | undefined
  try {
    fd = openSync(path, FS_CONSTANTS.O_RDONLY | NO_FOLLOW_FLAG | NON_BLOCKING_FLAG)
    if (!fstatSync(fd).isFile()) throw new Error('客户端设备文件路径不是普通文件')
    fchmodSync(fd, 0o600)
  } catch (error) {
    if (process.platform === 'win32') return
    throw new Error('客户端设备文件权限修复失败', { cause: error })
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function waitForDeviceFilePublisher(): void {
  try {
    Atomics.wait(DEVICE_FILE_WAIT_BUFFER, 0, 0, 2)
  } catch {
    // 某些运行时不允许主线程阻塞等待时，立即重试即可。
  }
}

interface DeviceFileLockRecord {
  owner: DeviceFileLockOwner | null
  identity: FileIdentity
}

function readLockRecord(lockPath: string): DeviceFileLockRecord | null {
  let canonicalStats
  try {
    canonicalStats = lstatSync(lockPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (!canonicalStats.isFile()) throw new Error('客户端设备文件锁路径不是普通文件')

  const result = readPureJsonFileWithIdentity<unknown>(lockPath, '客户端设备文件锁')
  if (!result) return null
  const canonicalIdentity = { dev: canonicalStats.dev, ino: canonicalStats.ino }
  if (!sameFileIdentity(canonicalIdentity, result.identity)) {
    return null
  }
  const owner = isValidDeviceFileLockOwner(result.value) ? result.value : null
  if (owner && (owner.dev !== result.identity.dev || owner.ino !== result.identity.ino)) {
    return { owner: null, identity: result.identity }
  }
  return { owner, identity: result.identity }
}

function isValidDeviceFileLockOwner(value: unknown): value is DeviceFileLockOwner {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  return keys.length === 6
    && keys.every((key) => key === 'version' || key === 'token' || key === 'pid' || key === 'createdAt' || key === 'dev' || key === 'ino')
    && record.version === 1
    && typeof record.token === 'string'
    && DEVICE_ID_UUID_V4_PATTERN.test(record.token)
    && typeof record.pid === 'number'
    && Number.isSafeInteger(record.pid)
    && record.pid > 0
    && typeof record.createdAt === 'number'
    && Number.isSafeInteger(record.createdAt)
    && record.createdAt >= 0
    && typeof record.dev === 'number'
    && Number.isSafeInteger(record.dev)
    && record.dev >= 0
    && typeof record.ino === 'number'
    && Number.isSafeInteger(record.ino)
    && record.ino >= 0
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

function reclaimDeviceFileLock(lockPath: string, record: DeviceFileLockRecord): boolean {
  const reclaimPath = `${lockPath}.reclaim-${process.pid}-${randomUUID()}`
  try {
    renameSync(lockPath, reclaimPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    if (process.platform === 'win32' && ['EACCES', 'EBUSY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      return false
    }
    throw error
  }

  try {
    const reclaimedRecord = readLockRecord(reclaimPath)
    if (!reclaimedRecord || !sameFileIdentity(reclaimedRecord.identity, record.identity)) {
      throw new Error('客户端设备文件锁元数据在回收期间发生变化')
    }
    if (record.owner && (!reclaimedRecord.owner || reclaimedRecord.owner.token !== record.owner.token)) {
      throw new Error('客户端设备文件锁 owner 在回收期间发生变化')
    }
    if (!record.owner && reclaimedRecord.owner) {
      throw new Error('客户端设备文件锁已在回收期间取得 owner')
    }
    rmSync(reclaimPath, { recursive: true, force: true })
    return true
  } catch (error) {
    // 无法证明仍是同一个 owner 时保留回收目录，避免误删其他进程的锁。
    throw error
  }
}

function tryCreateDeviceFileLock(lockPath: string): DeviceFileLockHandle | null {
  let fd: number
  try {
    fd = openSync(
      lockPath,
      FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL | FS_CONSTANTS.O_WRONLY | NO_FOLLOW_FLAG,
      0o600,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null
    throw error
  }

  try {
    const stats = fstatSync(fd)
    const owner: DeviceFileLockHandle = {
      lockPath,
      version: 1,
      token: randomUUID(),
      pid: process.pid,
      createdAt: Date.now(),
      dev: stats.dev,
      ino: stats.ino,
    }
    const encoded = Buffer.from(JSON.stringify({
      version: owner.version,
      token: owner.token,
      pid: owner.pid,
      createdAt: owner.createdAt,
      dev: owner.dev,
      ino: owner.ino,
    }))
    let offset = 0
    while (offset < encoded.length) {
      offset += writeSync(fd, encoded, offset, encoded.length - offset)
    }
    fsyncSync(fd)
    return owner
  } finally {
    closeSync(fd)
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

    const owner = tryCreateDeviceFileLock(lockPath)
    if (owner) return owner

    if (readValidClientDevice(targetPath)) return null

    const record = readLockRecord(lockPath)
    if (!record) {
      if (Date.now() >= deadline) throw new Error('客户端设备文件锁所有权无法确认')
      waitForDeviceFilePublisher()
      continue
    }

    if (record.owner) {
      const processState = probeProcess(record.owner.pid)
      if (processState === 'alive') {
        if (options.failOnActiveOwner) throw new Error('客户端设备文件锁仍由活动进程持有')
        if (Date.now() >= deadline) throw new Error('客户端设备文件锁仍由活动进程持有')
        waitForDeviceFilePublisher()
        continue
      }
      if (processState === 'unknown') {
        throw new Error('客户端设备文件锁所属进程状态无法确认')
      }
    }

    reclaimDeviceFileLock(lockPath, record)

    if (Date.now() >= deadline) {
      throw new Error('获取客户端设备文件锁超时')
    }
    waitForDeviceFilePublisher()
  }
}

function hasLockOwnership(handle: DeviceFileLockHandle): boolean {
  const record = readLockRecord(handle.lockPath)
  return record?.owner?.token === handle.token
    && sameFileIdentity(record.identity, handle)
    && record.owner.dev === handle.dev
    && record.owner.ino === handle.ino
}

function removeInvalidDeviceTarget(path: string, owner: DeviceFileLockHandle): void {
  if (!hasLockOwnership(owner)) return
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
  if (!hasLockOwnership(owner)) return false
  const stagingPath = `${path}.${process.pid}.${randomUUID()}.staging`
  try {
    writeJsonFileAtomic(stagingPath, file, false, 0o600)
    if (!hasLockOwnership(owner)) return false
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

function removeDeviceFileLockIfOwner(owner: DeviceFileLockHandle): boolean {
  if (!hasLockOwnership(owner)) return false
  rmSync(owner.lockPath, { force: true })
  return true
}

/** 仅供本文件测试验证锁 token 边界，不供业务调用。 */
export const __clientDeviceIdTestHooks = {
  acquire: (lockPath: string, targetPath: string) => acquireDeviceFileLock(lockPath, targetPath, { failOnActiveOwner: true }),
  removeIfOwner: removeDeviceFileLockIfOwner,
  publishIfOwner: (path: string, owner: DeviceFileLockHandle, file: ClientDeviceFile): boolean => publishClientDeviceFile(path, file, owner),
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
      removeDeviceFileLockIfOwner(owner)
    }
  }
}
