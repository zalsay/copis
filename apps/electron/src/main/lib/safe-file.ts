/**
 * 崩溃安全的 JSON 文件读写工具
 *
 * 解决系统强制关机/崩溃时 JSON 索引文件被截断导致数据丢失的问题。
 * - 写入：write-to-temp → rename（POSIX 原子操作）+ .bak 备份
 * - 读取：主文件 → .tmp 残留 → .bak 回退，多层容错
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { syncParentDurable, writeAllSync } from './durable-fs'

/**
 * 原子写入 JSON 文件：write-to-temp → rename
 * 写入前自动保留 .bak 备份
 */
export function writeJsonFileAtomic(filePath: string, data: object, skipBackup = false, mode?: number): void {
  const tmpPath = filePath + '.tmp'
  const bakPath = filePath + '.bak'

  // 备份当前文件（如果存在且可读）
  if (!skipBackup && existsSync(filePath)) {
    try {
      copyFileSync(filePath, bakPath)
    } catch {
      // 备份失败不阻塞写入
    }
  }

	// 写入临时文件；认证文件需要在重命名前就收紧权限。
	if (mode === undefined) {
		writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
	} else {
		writeFileSync(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode })
		chmodSync(tmpPath, mode)
	}

	// 原子重命名（POSIX rename 是原子操作）
	renameSync(tmpPath, filePath)
	if (mode !== undefined) chmodSync(filePath, mode)
}

/** 聊天室提交摘要使用的持久化写入：临时文件和父目录均显式 fsync。 */
export function writeJsonFileAtomicDurable(
  filePath: string,
  data: object,
  mode = 0o600,
  skipBackup = false,
): void {
  const parentChain = captureParentChain(filePath)
  const bytes = Buffer.from(JSON.stringify(data, null, 2), 'utf8')
  const noFollow = (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0
  const tempPath = `${filePath}.tmp-${randomUUID()}`
  const backupTempPath = `${filePath}.bak-${randomUUID()}`
  let tempIdentity: FileIdentity | undefined
  let backupIdentity: FileIdentity | undefined

  try {
    const current = readRegularIdentity(filePath, true)
    assertParentChainStable(parentChain)
    tempIdentity = writeDurableTemp(tempPath, bytes, mode, parentChain, noFollow, '聊天室配置临时文件')
    assertParentChainStable(parentChain)

    let needsRecoveryBackup = false
    if (!skipBackup && current) {
      backupIdentity = copyRegularToTemp(filePath, backupTempPath, mode, parentChain, noFollow)
      const fixedBackupPath = filePath + '.bak'
      if (pathExistsWithoutFollowing(fixedBackupPath)) {
        needsRecoveryBackup = true
        // 固定 .bak 可能由其他版本、用户或外部链接占用；将已完成的备份保留为
        // 唯一随机路径，绝不以 rename 覆盖既有目标。
        cleanupOwnedTemp(backupTempPath, backupIdentity)
        backupIdentity = undefined
      } else {
        const installed = installBackupWithoutReplacing(
          backupTempPath,
          fixedBackupPath,
          parentChain,
          backupIdentity,
        )
        if (!installed) {
          // 目标在检查后出现时同样不能覆盖；改用两个受控代次槽位保存最近 previous。
          needsRecoveryBackup = true
          cleanupOwnedTemp(backupTempPath, backupIdentity)
          backupIdentity = undefined
        } else {
          backupIdentity = undefined
        }
      }
      if (needsRecoveryBackup) {
        // 固定 .bak 可能是外部文件/链接，也可能是本次事务之前的 canonical。
        // 无论来源如何都不覆盖它；受控槽位负责保存后续最新 previous。
        installRecoveryBackup(filePath, parentChain, mode, noFollow)
      }
    }

    assertParentChainStable(parentChain)
    replacePathWithoutDelete(tempPath, filePath, parentChain, tempIdentity, current)
    tempIdentity = undefined
    const committed = readRegularIdentity(filePath, false)
    if (!committed) throw new Error('聊天室配置主文件不可用')
    chmodSync(filePath, mode)
    assertParentChainStable(parentChain)
    syncParentDurable(filePath)
  } catch (error) {
    cleanupOwnedTemp(tempPath, tempIdentity)
    cleanupOwnedTemp(backupTempPath, backupIdentity)
    throw new Error('聊天室配置持久化失败', { cause: error })
  }
}

const RECOVERY_SLOT_SUFFIXES = ['a', 'b'] as const
const RECOVERY_VERSION = 1
const MAX_SAFE_TEXT_BYTES = 4 * 1024 * 1024

interface RecoveryOwner {
  token: string
}

interface RecoveryEnvelope {
  version: number
  ownerToken: string
  generation: number
  payload: string
  digest: string
}

interface SafeTextFile {
  raw: string
  identity: FileIdentity
}

function recoveryOwnerPath(filePath: string): string {
  return `${filePath}.bak-recovery-owner`
}

function recoverySlotPaths(filePath: string, ownerToken: string): string[] {
  return RECOVERY_SLOT_SUFFIXES.map((suffix) => `${filePath}.bak-recovery-${ownerToken}-${suffix}`)
}

function readRegularTextNoFollow(filePath: string, maxBytes = MAX_SAFE_TEXT_BYTES): SafeTextFile | undefined {
  const noFollow = (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0
  let fd = -1
  try {
    fd = openSync(filePath, constants.O_RDONLY | noFollow)
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.nlink > 1 || opened.size < 0 || opened.size > maxBytes) return undefined
    const bytes = Buffer.allocUnsafe(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (count <= 0) return undefined
      offset += count
    }
    const closed = fstatSync(fd)
    if (!closed.isFile() || closed.nlink > 1 || closed.dev !== opened.dev || closed.ino !== opened.ino
      || closed.size !== opened.size || closed.mtimeMs !== opened.mtimeMs) return undefined
    closeSync(fd)
    fd = -1
    const onDisk = lstatSync(filePath)
    if (onDisk.isSymbolicLink() || !onDisk.isFile() || onDisk.nlink > 1
      || onDisk.dev !== closed.dev || onDisk.ino !== closed.ino || onDisk.size !== closed.size
      || onDisk.mtimeMs !== closed.mtimeMs) return undefined
    return {
      raw: bytes.toString('utf8'),
      identity: { dev: closed.dev, ino: closed.ino, size: closed.size, mtimeMs: closed.mtimeMs },
    }
  } catch {
    return undefined
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

function parseRecoveryOwner(filePath: string): (RecoveryOwner & { identity: FileIdentity }) | undefined {
  const candidate = readRegularTextNoFollow(filePath)
  if (!candidate) return undefined
  try {
    const parsed = JSON.parse(candidate.raw) as Partial<RecoveryOwner>
    return typeof parsed.token === 'string' && /^[0-9a-f-]{36}$/i.test(parsed.token)
      ? { token: parsed.token, identity: candidate.identity }
      : undefined
  } catch {
    return undefined
  }
}

function createRecoveryOwner(filePath: string, parentChain: readonly ParentIdentity[], mode: number, noFollow: number): RecoveryOwner | undefined {
  const ownerPath = recoveryOwnerPath(filePath)
  const existing = parseRecoveryOwner(ownerPath)
  if (existing) return existing
  if (pathExistsWithoutFollowing(ownerPath)) return undefined

  const owner: RecoveryOwner = { token: randomUUID() }
  let fd = -1
  try {
    assertParentChainStable(parentChain)
    fd = openSync(ownerPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, mode)
    const bytes = Buffer.from(JSON.stringify(owner), 'utf8')
    writeAllSync(fd, bytes, '聊天室配置备份所有权文件')
    fsyncSync(fd)
    const stats = fstatSync(fd)
    if (!stats.isFile() || stats.nlink > 1 || stats.size !== bytes.length) throw new Error('聊天室配置备份所有权文件不可用')
    closeSync(fd)
    fd = -1
    assertParentChainStable(parentChain)
    syncParentDurable(ownerPath)
    return owner
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return parseRecoveryOwner(ownerPath)
    throw error
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

function parseRecoveryEnvelope(filePath: string): { envelope: RecoveryEnvelope; identity: FileIdentity } | undefined {
  const candidate = readRegularTextNoFollow(filePath)
  if (!candidate) return undefined
  try {
    const envelope = JSON.parse(candidate.raw) as Partial<RecoveryEnvelope> & RecoveryEnvelope
    if (envelope.version !== RECOVERY_VERSION || typeof envelope.ownerToken !== 'string'
      || !/^[0-9a-f-]{36}$/i.test(envelope.ownerToken) || !Number.isSafeInteger(envelope.generation)
      || envelope.generation < 1 || typeof envelope.payload !== 'string'
      || !/^[a-f0-9]{64}$/.test(envelope.digest)) return undefined
    const digest = createHash('sha256').update(envelope.payload, 'utf8').digest('hex')
    if (digest !== envelope.digest || JSON.parse(envelope.payload) === null) return undefined
    return { envelope, identity: candidate.identity }
  } catch {
    return undefined
  }
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs
}

/** 只在 owner 文件两次 no-follow/fd 校验一致时读取当前 token 的两个受控槽位。 */
function readTrustedRecoveryEnvelopes(filePath: string): { envelope: RecoveryEnvelope; identity: FileIdentity }[] {
  const ownerPath = recoveryOwnerPath(filePath)
  const owner = parseRecoveryOwner(ownerPath)
  if (!owner) return []
  const slots = recoverySlotPaths(filePath, owner.token)
    .map((path) => parseRecoveryEnvelope(path))
    .filter((candidate): candidate is { envelope: RecoveryEnvelope; identity: FileIdentity } => candidate !== undefined)
    .filter((candidate) => candidate.envelope.ownerToken === owner.token)
  const confirmedOwner = parseRecoveryOwner(ownerPath)
  if (!confirmedOwner || confirmedOwner.token !== owner.token || !sameFileIdentity(owner.identity, confirmedOwner.identity)) {
    return []
  }
  return slots
}

function installRecoveryBackup(
  filePath: string,
  parentChain: readonly ParentIdentity[],
  mode: number,
  noFollow: number,
): void {
  const owner = createRecoveryOwner(filePath, parentChain, mode, noFollow)
  if (!owner) throw new Error('聊天室配置备份所有权不可验证')
  const source = readRegularTextNoFollow(filePath)
  if (!source) throw new Error('聊天室配置源文件不可用')
  const slots = recoverySlotPaths(filePath, owner.token).map((path) => ({ path, candidate: parseRecoveryEnvelope(path) }))
  const owned = slots.filter((slot) => slot.candidate?.envelope.ownerToken === owner.token)
  const generation = Math.max(0, ...owned.map((slot) => slot.candidate!.envelope.generation)) + 1
  const missing = slots.find((slot) => !pathExistsWithoutFollowing(slot.path))
  const target = missing ?? (owned.length === RECOVERY_SLOT_SUFFIXES.length
    ? owned.sort((left, right) => left.candidate!.envelope.generation - right.candidate!.envelope.generation)[0]
    : undefined)
  if (!target) throw new Error('聊天室配置备份槽位不可用')

  const envelope: RecoveryEnvelope = {
    version: RECOVERY_VERSION,
    ownerToken: owner.token,
    generation,
    payload: source.raw,
    digest: createHash('sha256').update(source.raw, 'utf8').digest('hex'),
  }
  const tempPath = `${target.path}.next-${randomUUID()}`
  const tempIdentity = writeDurableTemp(tempPath, Buffer.from(JSON.stringify(envelope), 'utf8'), mode, parentChain, noFollow, '聊天室配置受控备份临时文件')
  try {
    assertParentChainStable(parentChain)
    if (target.candidate) {
      const current = parseRecoveryEnvelope(target.path)
      if (!current || current.envelope.ownerToken !== owner.token || current.identity.dev !== target.candidate.identity.dev
        || current.identity.ino !== target.candidate.identity.ino) throw new Error('聊天室配置备份槽位发生变化')
      unlinkSync(target.path)
      syncParentDurable(target.path)
    }
    try {
      linkSync(tempPath, target.path)
    } catch (error) {
      // O_EXCL 等价的 hard link 失败时不覆盖后来出现的外部文件。
      throw new Error('聊天室配置备份槽位不可用', { cause: error })
    }
    const installed = lstatSync(target.path)
    if (installed.isSymbolicLink() || !installed.isFile() || installed.nlink < 2
      || installed.dev !== tempIdentity.dev || installed.ino !== tempIdentity.ino) {
      throw new Error('聊天室配置备份槽位发生变化')
    }
    unlinkSync(tempPath)
    const committed = parseRecoveryEnvelope(target.path)
    if (!committed || committed.identity.dev !== tempIdentity.dev || committed.identity.ino !== tempIdentity.ino
      || committed.envelope.generation !== generation || committed.envelope.ownerToken !== owner.token) {
      throw new Error('聊天室配置备份槽位发生变化')
    }
    syncParentDurable(target.path)
  } catch (error) {
    cleanupOwnedTemp(tempPath, tempIdentity)
    throw error
  }
}

function pathExistsWithoutFollowing(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

interface FileIdentity {
  dev: number
  ino: number
  size: number
  mtimeMs: number
}

interface ParentIdentity extends FileIdentity {
  path: string
  requestedPath?: string
}

function captureParentChain(filePath: string): ParentIdentity[] {
  const chain: ParentIdentity[] = []
  const requestedParent = dirname(filePath)
  let current = realpathSync.native(requestedParent)
  for (;;) {
    const stats = lstatSync(current)
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('聊天室配置父目录不可用')
    chain.unshift({ path: current,
      dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs })
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  chain[chain.length - 1]!.requestedPath = requestedParent
  return chain
}

function assertParentChainStable(chain: readonly ParentIdentity[]): void {
  if (chain.length === 0) throw new Error('聊天室配置父目录不可用')
  const immediate = chain[chain.length - 1]!
  const requestedParent = immediate.requestedPath
  if (requestedParent) {
    let actualRequestedParent: string
    try { actualRequestedParent = realpathSync.native(requestedParent) } catch {
      throw new Error('聊天室配置父目录发生变化')
    }
    if (actualRequestedParent !== immediate.path) throw new Error('聊天室配置父目录发生变化')
  }
  const expectedParent = immediate.path
  let actualParent: string
  try { actualParent = realpathSync.native(expectedParent) } catch {
    throw new Error('聊天室配置父目录发生变化')
  }
  if (actualParent !== expectedParent) throw new Error('聊天室配置父目录发生变化')
  for (const expected of chain) {
    const stats = lstatSync(expected.path)
    if (stats.isSymbolicLink() || !stats.isDirectory() || stats.dev !== expected.dev || stats.ino !== expected.ino) {
      throw new Error('聊天室配置父目录发生变化')
    }
  }
}

function readRegularIdentity(path: string, allowMissing: boolean): FileIdentity | undefined {
  let stats
  try {
    stats = lstatSync(path)
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink > 1) throw new Error('聊天室配置文件不可用')
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs }
}

function assertSameFileIdentity(path: string, expected: FileIdentity): void {
  const actual = readRegularIdentity(path, false)
  if (!actual || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size !== expected.size
    || actual.mtimeMs !== expected.mtimeMs) throw new Error('聊天室配置临时文件发生变化')
}

function writeDurableTemp(
  path: string,
  bytes: Buffer,
  mode: number,
  parentChain: readonly ParentIdentity[],
  noFollow: number,
  label: string,
): FileIdentity {
  assertParentChainStable(parentChain)
  let fd = -1
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, mode)
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.nlink > 1) throw new Error(`${label}不可用`)
    writeAllSync(fd, bytes, label)
    fsyncSync(fd)
    chmodSync(path, mode)
    const closed = fstatSync(fd)
    if (!closed.isFile() || closed.dev !== opened.dev || closed.ino !== opened.ino || closed.size !== bytes.length) {
      throw new Error(`${label}发生变化`)
    }
    closeSync(fd)
    fd = -1
    assertSameFileIdentity(path, { dev: closed.dev, ino: closed.ino, size: closed.size, mtimeMs: closed.mtimeMs })
    assertParentChainStable(parentChain)
    return { dev: closed.dev, ino: closed.ino, size: closed.size, mtimeMs: closed.mtimeMs }
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

function copyRegularToTemp(
  sourcePath: string,
  destinationPath: string,
  mode: number,
  parentChain: readonly ParentIdentity[],
  noFollow: number,
): FileIdentity {
  const sourceIdentity = readRegularIdentity(sourcePath, false)
  if (!sourceIdentity) throw new Error('聊天室配置源文件不可用')
  let sourceFd = -1
  let destinationFd = -1
  try {
    assertParentChainStable(parentChain)
    sourceFd = openSync(sourcePath, constants.O_RDONLY | noFollow)
    const sourceOpened = fstatSync(sourceFd)
    if (sourceOpened.dev !== sourceIdentity.dev || sourceOpened.ino !== sourceIdentity.ino
      || sourceOpened.size !== sourceIdentity.size || sourceOpened.nlink > 1) throw new Error('聊天室配置源文件发生变化')
    destinationFd = openSync(destinationPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, mode)
    const destinationOpened = fstatSync(destinationFd)
    if (!destinationOpened.isFile() || destinationOpened.nlink > 1) throw new Error('聊天室配置备份文件不可用')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let offset = 0
    while (offset < sourceOpened.size) {
      const count = readSync(sourceFd, buffer, 0, Math.min(buffer.length, sourceOpened.size - offset), offset)
      if (count <= 0) throw new Error('聊天室配置源文件读取失败')
      writeAllSync(destinationFd, buffer.subarray(0, count), '聊天室配置备份文件')
      offset += count
    }
    fsyncSync(destinationFd)
    const destinationClosed = fstatSync(destinationFd)
    if (destinationClosed.dev !== destinationOpened.dev || destinationClosed.ino !== destinationOpened.ino
      || destinationClosed.size !== sourceOpened.size) throw new Error('聊天室配置备份文件发生变化')
    const sourceClosed = fstatSync(sourceFd)
    if (sourceClosed.dev !== sourceOpened.dev || sourceClosed.ino !== sourceOpened.ino
      || sourceClosed.size !== sourceOpened.size || sourceClosed.mtimeMs !== sourceOpened.mtimeMs) {
      throw new Error('聊天室配置源文件发生变化')
    }
    closeSync(destinationFd)
    destinationFd = -1
    closeSync(sourceFd)
    sourceFd = -1
    chmodSync(destinationPath, mode)
    assertSameFileIdentity(destinationPath, {
      dev: destinationClosed.dev,
      ino: destinationClosed.ino,
      size: destinationClosed.size,
      mtimeMs: lstatSync(destinationPath).mtimeMs,
    })
    assertParentChainStable(parentChain)
    const result = readRegularIdentity(destinationPath, false)
    if (!result) throw new Error('聊天室配置备份文件不可用')
    return result
  } finally {
    if (destinationFd >= 0) closeSync(destinationFd)
    if (sourceFd >= 0) closeSync(sourceFd)
  }
}

function replacePathWithoutDelete(
  path: string,
  targetPath: string,
  parentChain: readonly ParentIdentity[],
  identity: FileIdentity,
  expectedTarget?: FileIdentity,
): void {
  assertSameFileIdentity(path, identity)
  assertParentChainStable(parentChain)
  if (expectedTarget) assertSameFileIdentity(targetPath, expectedTarget)
  try {
    renameSync(path, targetPath)
  } catch (error) {
    // Windows 的 rename 可能拒绝覆盖现有目标；先把已校验目标移到随机同目录名，
    // 再完成 rename，整个过程不跟随或删除目标。POSIX 仍走单次原子替换。
    if (process.platform !== 'win32') throw error
    const displacedPath = `${targetPath}.displaced-${randomUUID()}`
    const target = readRegularIdentity(targetPath, true)
    if (target) renameSync(targetPath, displacedPath)
    try {
      renameSync(path, targetPath)
    } catch (renameError) {
      if (target) renameSync(displacedPath, targetPath)
      throw renameError
    }
    if (target) {
      const displaced = readRegularIdentity(displacedPath, false)
      if (displaced) unlinkSync(displacedPath)
    }
  }
  assertSameFileIdentity(targetPath, identity)
  assertParentChainStable(parentChain)
}

/** 仅在 canonical 备份不存在时通过 hard link 安装，永不替换既有目标。 */
function installBackupWithoutReplacing(
  sourcePath: string,
  targetPath: string,
  parentChain: readonly ParentIdentity[],
  identity: FileIdentity,
): boolean {
  assertSameFileIdentity(sourcePath, identity)
  assertParentChainStable(parentChain)
  try {
    linkSync(sourcePath, targetPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try {
    const installed = lstatSync(targetPath)
    if (installed.isSymbolicLink() || !installed.isFile() || installed.dev !== identity.dev
      || installed.ino !== identity.ino || installed.size !== identity.size
      || installed.mtimeMs !== identity.mtimeMs) {
      throw new Error('聊天室配置备份文件发生变化')
    }
    assertParentChainStable(parentChain)
    unlinkSync(sourcePath)
    syncParentDurable(targetPath)
    return true
  } catch (error) {
    // 目标已通过 hard link 安装；保留 source 或由受控清理回收，不触碰 target。
    throw error
  }
}

function cleanupOwnedTemp(path: string, identity: FileIdentity | undefined): void {
  if (!identity) return
  try {
    const current = readRegularIdentity(path, true)
    if (current && current.dev === identity.dev && current.ino === identity.ino) unlinkSync(path)
  } catch {
    // 外部替换或权限异常时保留残留，避免误删他人文件。
  }
}

/** 原子重写文本文件（用于 JSONL 会话等非单个 JSON 文档）。 */
export function writeTextFileAtomic(filePath: string, content: string): void {
  const tmpPath = filePath + '.tmp'
  writeFileSync(tmpPath, content, 'utf-8')
  renameSync(tmpPath, filePath)
}

/**
 * 安全读取 JSON 索引文件
 * 优先读主文件，损坏则尝试 .tmp / .bak，都失败返回 null
 */
export type SafeJsonReadStatus = 'missing' | 'valid' | 'recovered' | 'corrupt'

export interface SafeJsonReadResult<T> {
  value: T | null
  status: SafeJsonReadStatus
}

/** 返回 JSON 文件读取来源，允许调用方区分“没有文件”和“文件全部损坏”。 */
export function readJsonFileSafeDetailed<T>(filePath: string, logLabel?: string): SafeJsonReadResult<T> {
  const tmpPath = filePath + '.tmp'
  const bakPath = filePath + '.bak'
  const displayPath = logLabel ?? filePath
  const ownerPath = recoveryOwnerPath(filePath)
  const owner = parseRecoveryOwner(ownerPath)
  const controlledPaths = owner ? recoverySlotPaths(filePath, owner.token) : []
  const hasCandidate = [filePath, tmpPath, bakPath, ownerPath, ...controlledPaths]
    .some((candidate) => pathExistsWithoutFollowing(candidate))

  // 1. 尝试读取主文件
  const main = readRegularTextNoFollow(filePath)
  if (main) {
    try {
      if (main.raw.trim().length > 0) {
        return { value: JSON.parse(main.raw) as T, status: 'valid' }
      }
    } catch {
      console.warn(`[数据恢复] 主索引文件损坏: ${displayPath}`)
    }
  }

  // 2. 检查是否有未完成的 .tmp 文件（上次 rename 前崩溃）
  const pending = readRegularTextNoFollow(tmpPath)
  if (pending) {
    try {
      if (pending.raw.trim().length > 0) {
        const parsed = JSON.parse(pending.raw) as T
        // .tmp 有效 → 提升为主文件
        writeJsonFileAtomicDurable(filePath, parsed as object, 0o600, true)
        console.log(`[数据恢复] 从 .tmp 文件恢复: ${displayPath}`)
        return { value: parsed, status: 'recovered' }
      }
    } catch {
      // .tmp 也损坏，继续 fallback
    }
    // 清理无效的 .tmp
    try {
      const current = readRegularIdentity(tmpPath, true)
      if (current && current.dev === pending.identity.dev && current.ino === pending.identity.ino) unlinkSync(tmpPath)
    } catch { /* ignore */ }
  }

  // 3. 先选择经过 envelope、摘要和代次校验的受控 previous。
  const controlledCandidates = readTrustedRecoveryEnvelopes(filePath)
    .sort((left, right) => right.envelope.generation - left.envelope.generation)
  if (controlledCandidates.length > 0) {
    try {
      const parsed = JSON.parse(controlledCandidates[0]!.envelope.payload) as T
      writeJsonFileAtomicDurable(filePath, parsed as object, 0o600, true)
      console.log(`[数据恢复] 从受控 .bak previous 恢复: ${displayPath}`)
      return { value: parsed, status: 'recovered' }
    } catch {
      console.error(`[数据恢复] 受控 .bak previous 也损坏: ${displayPath}`)
    }
  }

  // 4. Fallback 到 canonical .bak；固定路径一律 no-follow 读取。
  const canonical = readRegularTextNoFollow(bakPath)
  if (canonical) {
    try {
      if (canonical.raw.trim().length > 0) {
        const parsed = JSON.parse(canonical.raw) as T
        // 用 .bak 恢复主文件（跳过备份，避免用损坏的主文件覆盖好的 .bak）
        writeJsonFileAtomicDurable(filePath, parsed as object, 0o600, true)
        console.log(`[数据恢复] 从 .bak 文件恢复: ${displayPath}`)
        return { value: parsed, status: 'recovered' }
      }
    } catch {
      console.error(`[数据恢复] .bak 文件也损坏: ${logLabel ?? bakPath}`)
    }
  }

  return { value: null, status: hasCandidate ? 'corrupt' : 'missing' }
}

export function readJsonFileSafe<T>(filePath: string, logLabel?: string): T | null {
  return readJsonFileSafeDetailed<T>(filePath, logLabel).value
}
