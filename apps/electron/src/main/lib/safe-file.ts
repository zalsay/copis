/**
 * 崩溃安全的 JSON 文件读写工具
 *
 * 解决系统强制关机/崩溃时 JSON 索引文件被截断导致数据丢失的问题。
 * - 写入：write-to-temp → rename（POSIX 原子操作）+ .bak 备份
 * - 读取：主文件 → .tmp 残留 → .bak 回退，多层容错
 */

import { randomUUID } from 'node:crypto'
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
export function writeJsonFileAtomicDurable(filePath: string, data: object, mode = 0o600): void {
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

    if (current) {
      backupIdentity = copyRegularToTemp(filePath, backupTempPath, mode, parentChain, noFollow)
      const fixedBackupPath = filePath + '.bak'
      if (pathExistsWithoutFollowing(fixedBackupPath)) {
        // 固定 .bak 可能由其他版本、用户或外部链接占用；将已完成的备份保留为
        // 唯一随机路径，绝不以 rename 覆盖既有目标。
        syncParentDurable(backupTempPath)
        backupIdentity = undefined
      } else {
        const installed = installBackupWithoutReplacing(
          backupTempPath,
          fixedBackupPath,
          parentChain,
          backupIdentity,
        )
        if (!installed) {
          // 目标在检查后出现时同样不能覆盖，随机备份继续作为保留副本。
          syncParentDurable(backupTempPath)
          backupIdentity = undefined
        } else {
          backupIdentity = undefined
        }
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
  const hasCandidate = existsSync(filePath) || existsSync(tmpPath) || existsSync(bakPath)

  // 1. 尝试读取主文件
  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, 'utf-8')
      if (raw.trim().length > 0) {
        return { value: JSON.parse(raw) as T, status: 'valid' }
      }
    } catch {
      console.warn(`[数据恢复] 主索引文件损坏: ${displayPath}`)
    }
  }

  // 2. 检查是否有未完成的 .tmp 文件（上次 rename 前崩溃）
  if (existsSync(tmpPath)) {
    try {
      const raw = readFileSync(tmpPath, 'utf-8')
      if (raw.trim().length > 0) {
        const parsed = JSON.parse(raw) as T
        // .tmp 有效 → 提升为主文件
        renameSync(tmpPath, filePath)
        console.log(`[数据恢复] 从 .tmp 文件恢复: ${displayPath}`)
        return { value: parsed, status: 'recovered' }
      }
    } catch {
      // .tmp 也损坏，继续 fallback
    }
    // 清理无效的 .tmp
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
  }

  // 3. Fallback 到 .bak
  if (existsSync(bakPath)) {
    try {
      const raw = readFileSync(bakPath, 'utf-8')
      if (raw.trim().length > 0) {
        const parsed = JSON.parse(raw) as T
        // 用 .bak 恢复主文件（跳过备份，避免用损坏的主文件覆盖好的 .bak）
        writeJsonFileAtomic(filePath, parsed as object, true)
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
