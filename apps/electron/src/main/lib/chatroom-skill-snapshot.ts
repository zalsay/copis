import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { getWorkspaceSkillsReadOnly } from './agent-workspace-manager'
import type { SkillMeta } from '@copis/shared'
import {
  getChatRoomConfigPath,
  getChatRoomAgentSkillsSnapshotPath,
  getChatRoomsRootPath,
  getConfigDir,
  getWorkspaceSkillsDir,
} from './config-paths'
import { ChatRoomWorkspaceStore } from './chatroom-workspace-store'
import { readJsonFileSafeDetailed } from './safe-file'
import { syncDirectoryDurable as syncDirectory, syncParentDurable as syncParent } from './durable-fs'

const COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const MAX_FILES = 10_000
const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_BYTES = 100 * 1024 * 1024
const JOURNAL_NAME = '.snapshot-journal.json'
const SNAPSHOT_LOCK_NAME = '.skills-snapshot.lock'
const NEXT_NAME_PATTERN = /^\.next-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const JOURNAL_PHASES = new Set(['prepared', 'current_moved', 'next_moved', 'config_persisted', 'cleanup'])

export type ChatRoomSkillSnapshotJournalPhase = 'prepared' | 'current_moved' | 'next_moved' | 'config_persisted' | 'cleanup'

interface SyncFileRecord {
  type: 'D' | 'F'
  path: string
  bytes?: Buffer
}

export interface SyncChatRoomAgentSkillSnapshotInput {
  roomId: string
  roomAgentId: string
  sourceWorkspaceSlug: string
  /** 仅供 Main 内部测试/编排注入；不属于 IPC DTO。 */
  workspaceStore?: ChatRoomWorkspaceStore
  /** 故障/竞态回归注入点，不属于 IPC DTO。 */
  testHooks?: {
    beforeRead?: (path: string) => void
    beforeWrite?: (path: string) => void
    afterJournalPhase?: (phase: ChatRoomSkillSnapshotJournalPhase) => void
  }
}

export interface ChatRoomSkillSnapshotResult {
  snapshotPath: string
  digest: string
  skillSlugs: string[]
  syncedAt: number
}

interface SnapshotJournal {
  version: 1
  roomId: string
  roomAgentId: string
  targetDigest: string
  previousDigest: string | null
  nextName: string
  previousName: '.previous'
  phase: ChatRoomSkillSnapshotJournalPhase
}

interface SnapshotLockOwner {
  version: 1
  token: string
  pid: number
  createdAt: number
  dev: number
  ino: number
}

interface SnapshotLockHandle extends SnapshotLockOwner {
  lockPath: string
}

export interface RecoverChatRoomAgentSkillSnapshotInput {
  roomId: string
  roomAgentId: string
  workspaceStore?: ChatRoomWorkspaceStore
}

function fail(message: string): never {
  throw new Error(message)
}

function assertComponent(value: string, label: string): void {
  if (!COMPONENT_PATTERN.test(value)) fail(label + ' 不合法')
}

function assertDirectory(path: string, message: string): void {
  let stats
  try {
    stats = lstatSync(path)
  } catch {
    fail(message)
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) fail(message)
  assertWindowsNoReparse(path)
}

/** 校验从 configDir 到目标目录的每个受控组件，避免目录链路被替换。 */
function assertControlledDirectory(path: string, anchor: string, message: string): void {
  const target = resolve(path)
  const root = resolve(anchor)
  const pathToRoot = relative(root, target)
  if (pathToRoot.startsWith('..') || pathToRoot.includes('..' + sep) || resolve(root, pathToRoot) !== target) {
    fail(message)
  }
  let current = root
  assertDirectory(current, message)
  for (const component of pathToRoot.split(sep).filter(Boolean)) {
    current = join(current, component)
    assertDirectory(current, message)
  }
}

function assertContained(root: string, child: string, message: string): void {
  const relativePath = relative(resolve(root), resolve(child))
  if (relativePath === '' || relativePath.startsWith('..') || relativePath.includes('..' + sep)
    || resolve(root, relativePath) !== resolve(child)) {
    fail(message)
  }
}

function assertNotWithin(root: string, child: string, message: string): void {
  const relativePath = relative(resolve(root), resolve(child))
  if (relativePath === '' || (!relativePath.startsWith('..') && !relativePath.includes('..' + sep)
    && resolve(root, relativePath) === resolve(child))) {
    fail(message)
  }
}

function readFdFully(fd: number, maxBytes: number, label: string): Buffer {
  const chunks: Buffer[] = []
  let total = 0
  const chunk = Buffer.allocUnsafe(16 * 1024)
  for (;;) {
    const count = readSync(fd, chunk, 0, chunk.length, null)
    if (count === 0) break
    total += count
    if (total > maxBytes) fail(`${label}内容过大`)
    chunks.push(Buffer.from(chunk.subarray(0, count)))
  }
  return Buffer.concat(chunks, total)
}

interface DirectoryIdentity {
  path: string
  dev: number
  ino: number
}

function captureDirectoryChain(anchor: string, target: string, message: string): DirectoryIdentity[] {
  const root = resolve(anchor)
  const child = resolve(target)
  const suffix = relative(root, child)
  if (suffix.startsWith('..') || suffix.includes('..' + sep) || resolve(root, suffix) !== child) fail(message)
  const chain: DirectoryIdentity[] = []
  let current = root
  const paths = [root]
  for (const component of suffix.split(sep).filter(Boolean)) {
    current = join(current, component)
    paths.push(current)
  }
  for (const currentPath of paths) {
    let stats
    try {
      stats = lstatSync(currentPath)
    } catch {
      fail(message)
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) fail(message)
    chain.push({ path: currentPath, dev: stats.dev, ino: stats.ino })
  }
  return chain
}

function assertDirectoryChainStable(chain: readonly DirectoryIdentity[], message: string): void {
  for (const expected of chain) {
    let stats
    try {
      stats = lstatSync(expected.path)
    } catch {
      fail(message)
    }
    if (stats.isSymbolicLink() || !stats.isDirectory() || stats.dev !== expected.dev || stats.ino !== expected.ino) {
      fail(message)
    }
  }
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join('/')
}

function compareStableText(left: string, right: string): number {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index)
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

function validSnapshotLockOwner(value: unknown): value is SnapshotLockOwner {
  if (!isPlainRecord(value)) return false
  const keys = ['version', 'token', 'pid', 'createdAt', 'dev', 'ino']
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length
    && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
    && value.version === 1
    && typeof value.token === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.token)
    && typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0
    && typeof value.createdAt === 'number' && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0
    && typeof value.dev === 'number' && Number.isSafeInteger(value.dev) && value.dev >= 0
    && typeof value.ino === 'number' && Number.isSafeInteger(value.ino) && value.ino >= 0
}

function sameSnapshotLock(left: SnapshotLockOwner, right: SnapshotLockOwner): boolean {
  return left.token === right.token && left.pid === right.pid && left.createdAt === right.createdAt
    && left.dev === right.dev && left.ino === right.ino
}

function snapshotLockRecord(lockPath: string): { owner: SnapshotLockOwner | null; dev: number; ino: number } | null {
  let pathStats
  try {
    pathStats = lstatSync(lockPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error('Skill 快照同步锁不可用', { cause: error })
  }
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) fail('Skill 快照同步锁不可用')
  const fd = openSync(lockPath, constants.O_RDONLY | ((constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0))
  try {
    const fdStats = fstatSync(fd)
    if (!fdStats.isFile() || fdStats.dev !== pathStats.dev || fdStats.ino !== pathStats.ino) {
      fail('Skill 快照同步锁发生变化')
    }
    let owner: SnapshotLockOwner | null = null
    const raw = readFdFully(fd, 4096, 'Skill 快照同步锁')
    if (raw.length > 0) {
      let value: unknown
      try { value = JSON.parse(raw.toString('utf8')) } catch { value = undefined }
      if (value !== undefined && !validSnapshotLockOwner(value)) fail('Skill 快照同步锁元数据无效')
      if (value !== undefined) owner = value as SnapshotLockOwner
    }
    if (owner && (owner.dev !== fdStats.dev || owner.ino !== fdStats.ino)) fail('Skill 快照同步锁 owner 无效')
    return { owner, dev: fdStats.dev, ino: fdStats.ino }
  } finally {
    closeSync(fd)
  }
}

function processState(pid: number): 'alive' | 'dead' | 'unknown' {
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

function tryCreateSnapshotLock(lockPath: string): SnapshotLockHandle | null {
  const stagingPath = `${lockPath}.${process.pid}.${randomUUID()}.staging`
  let fd = -1
  try {
    fd = openSync(stagingPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
      | ((constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0), 0o600)
    const stats = fstatSync(fd)
    const owner: SnapshotLockHandle = {
      lockPath,
      version: 1,
      token: randomUUID(),
      pid: process.pid,
      createdAt: Date.now(),
      dev: stats.dev,
      ino: stats.ino,
    }
    const bytes = Buffer.from(JSON.stringify({
      version: owner.version,
      token: owner.token,
      pid: owner.pid,
      createdAt: owner.createdAt,
      dev: owner.dev,
      ino: owner.ino,
    }))
    let offset = 0
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
    fsyncSync(fd)
    closeSync(fd)
    fd = -1
    try {
      linkSync(stagingPath, lockPath)
      syncParent(lockPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null
      throw error
    }
    return owner
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null
    throw new Error('Skill 快照同步锁创建失败', { cause: error })
  } finally {
    if (fd >= 0) closeSync(fd)
    try { unlinkSync(stagingPath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

function reclaimSnapshotLock(lockPath: string, record: { owner: SnapshotLockOwner | null; dev: number; ino: number }): boolean {
  const reclaimPath = `${lockPath}.reclaim-${randomUUID()}`
  try {
    renameSync(lockPath, reclaimPath)
    syncParent(lockPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new Error('Skill 快照同步锁回收失败', { cause: error })
  }
  try {
    const reclaimed = snapshotLockRecord(reclaimPath)
    if (!reclaimed || reclaimed.dev !== record.dev || reclaimed.ino !== record.ino
      || (record.owner && (!reclaimed.owner || !sameSnapshotLock(record.owner, reclaimed.owner)))
      || (!record.owner && reclaimed.owner)) {
      throw new Error('Skill 快照同步锁 owner 在回收期间发生变化')
    }
    unlinkSync(reclaimPath)
    syncParent(reclaimPath)
    return true
  } catch (error) {
    throw new Error('Skill 快照同步锁回收失败', { cause: error })
  }
}

function acquireSnapshotLock(lockPath: string): SnapshotLockHandle {
  const owner = tryCreateSnapshotLock(lockPath)
  if (owner) return owner
  const record = snapshotLockRecord(lockPath)
  if (!record) return acquireSnapshotLock(lockPath)
  if (record.owner) {
    const state = processState(record.owner.pid)
    if (state === 'alive') fail('Skill 快照同步锁仍由活动进程持有')
    if (state === 'unknown') fail('Skill 快照同步锁所属进程状态无法确认')
  }
  reclaimSnapshotLock(lockPath, record)
  const retry = tryCreateSnapshotLock(lockPath)
  if (retry) return retry
  fail('Skill 快照同步锁无法取得所有权')
}

function releaseSnapshotLock(owner: SnapshotLockHandle): void {
  const record = snapshotLockRecord(owner.lockPath)
  if (!record || !record.owner || !sameSnapshotLock(record.owner, owner)
    || record.dev !== owner.dev || record.ino !== owner.ino) return
  unlinkSync(owner.lockPath)
  syncParent(owner.lockPath)
}

function readRegularFile(
  path: string,
  expected: { dev: number; ino: number; size: number; mtimeMs: number },
  sourceRoot: string,
  beforeRead?: (path: string) => void,
): Buffer {
  if (expected.size > MAX_FILE_BYTES) fail('Skill 快照文件过大')
  const fsConstants = constants as typeof constants & { O_NOFOLLOW?: number }
  const flags = constants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  const parentChain = captureDirectoryChain(sourceRoot, dirname(path), 'Skill 快照源目录发生变化')
  beforeRead?.(path)
  assertDirectoryChainStable(parentChain, 'Skill 快照源目录发生变化')
  let fd = -1
  try {
    fd = openSync(path, flags)
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino
      || opened.size !== expected.size || opened.nlink > 1) {
      fail('Skill 快照文件状态发生变化')
    }
    const bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (count <= 0) fail('Skill 快照文件读取失败')
      offset += count
    }
    const closed = fstatSync(fd)
    if (closed.dev !== opened.dev || closed.ino !== opened.ino || closed.size !== opened.size
      || closed.mtimeMs !== opened.mtimeMs) {
      fail('Skill 快照文件状态发生变化')
    }
    const finalPathStats = lstatSync(path)
    if (!finalPathStats.isFile() || finalPathStats.isSymbolicLink()
      || finalPathStats.dev !== opened.dev || finalPathStats.ino !== opened.ino
      || finalPathStats.nlink > 1 || finalPathStats.size !== opened.size
      || finalPathStats.mtimeMs !== opened.mtimeMs) {
      fail('Skill 快照文件状态发生变化')
    }
    assertDirectoryChainStable(parentChain, 'Skill 快照源目录发生变化')
    return bytes
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Skill 快照')) throw error
    fail('Skill 快照文件读取失败')
  } finally {
    if (fd >= 0) closeSync(fd)
  }
  return Buffer.alloc(0)
}

function collectSourceTree(
  path: string,
  relativePath: string,
  records: SyncFileRecord[],
  counters: { files: number; bytes: number },
  sourceRoot: string,
  beforeRead?: (path: string) => void,
): void {
  let stats
  try {
    stats = lstatSync(path)
  } catch {
    fail('Skill 快照源文件不可用')
  }
  if (stats.isSymbolicLink()) fail('Skill 快照不允许符号链接')
  if (stats.isDirectory()) {
    const directoryChain = captureDirectoryChain(sourceRoot, path, 'Skill 快照源目录发生变化')
    records.push({ type: 'D', path: normalizeRelativePath(relativePath) })
    assertDirectoryChainStable(directoryChain, 'Skill 快照源目录发生变化')
    const entries = readdirSync(path, { withFileTypes: true }).sort((left, right) => compareStableText(left.name, right.name))
    assertDirectoryChainStable(directoryChain, 'Skill 快照源目录发生变化')
    for (const entry of entries) {
      const child = relativePath ? relativePath + '/' + entry.name : entry.name
      collectSourceTree(join(path, entry.name), child, records, counters, sourceRoot, beforeRead)
    }
    return
  }
  if (!stats.isFile()) fail('Skill 快照只允许普通文件和目录')
  counters.files += 1
  counters.bytes += stats.size
  if (counters.files > MAX_FILES || counters.bytes > MAX_TOTAL_BYTES) fail('Skill 快照超出大小限制')
  records.push({
    type: 'F',
    path: normalizeRelativePath(relativePath),
    bytes: readRegularFile(path, stats, sourceRoot, beforeRead),
  })
}

function applyReadOnly(path: string): void {
  let stats
  try {
    stats = lstatSync(path)
  } catch {
    fail('Skill 快照临时目录不可用')
  }
  if (stats.isSymbolicLink()) fail('Skill 快照不允许符号链接')
  if (stats.isDirectory()) {
    for (const entry of readdirSync(path)) applyReadOnly(join(path, entry))
    setSnapshotPermissions(path, true, false)
    syncDirectory(path)
    return
  }
  if (!stats.isFile()) fail('Skill 快照只允许普通文件和目录')
  setSnapshotPermissions(path, false, false)
}

function assertWindowsNoReparse(path: string): void {
  if (process.platform !== 'win32') return
  let resolved
  try {
    resolved = realpathSync.native(path)
  } catch (error) {
    fail('Skill 快照 Windows 路径不可验证')
  }
  const normalize = (value: string) => value.replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '').toLowerCase()
  if (normalize(resolved) !== normalize(resolve(path))) fail('Skill 快照拒绝 Windows reparse 路径')
}

function setWindowsAcl(path: string, directory: boolean, writable: boolean): void {
  assertWindowsNoReparse(path)
  const user = process.env.USERNAME
  if (!user || /[\\/]/.test(user)) fail('Skill 快照 Windows 用户不可验证')
  const rights = writable ? (directory ? '(OI)(CI)M' : 'M') : (directory ? '(OI)(CI)RX' : 'R')
  try {
    execFileSync('icacls', [
      path,
      '/inheritance:r',
      '/remove:g', '*S-1-1-0',
      '/remove:g', '*S-1-5-32-545',
      '/grant:r', `${user}:${rights}`,
    ], { stdio: 'ignore', windowsHide: true })
  } catch (error) {
    fail('Skill 快照 Windows ACL 设置失败')
  }
  assertWindowsNoReparse(path)
}

function setSnapshotPermissions(path: string, directory: boolean, writable: boolean): void {
  if (process.platform === 'win32') {
    setWindowsAcl(path, directory, writable)
    return
  }
  chmodSync(path, directory ? (writable ? 0o700 : 0o500) : (writable ? 0o600 : 0o400))
}

function removeSafeTree(path: string): void {
  let stats
  try {
    stats = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    fail('Skill 快照清理失败')
  }
  if (stats.isSymbolicLink()) fail('Skill 快照不允许符号链接')
  if (stats.isDirectory()) {
    // 旧快照是只读树；显式同步的清理阶段临时恢复 owner write。
    setSnapshotPermissions(path, true, true)
    for (const entry of readdirSync(path)) removeSafeTree(join(path, entry))
    rmdirSync(path)
    syncParent(path)
    return
  }
  if (!stats.isFile()) fail('Skill 快照清理失败')
  setSnapshotPermissions(path, false, true)
  unlinkSync(path)
  syncParent(path)
}

function digestRecords(records: SyncFileRecord[]): string {
  const hash = createHash('sha256')
  for (const record of [...records].sort((left, right) => compareStableText(left.path, right.path) || compareStableText(left.type, right.type))) {
    hash.update(record.type)
    hash.update('\0')
    hash.update(record.path)
    hash.update('\0')
    if (record.bytes) hash.update(record.bytes)
    hash.update('\0')
  }
  return hash.digest('hex')
}

const EMPTY_SNAPSHOT_DIGEST = digestRecords([{ type: 'D', path: '' }])

/** 校验并计算已提交快照摘要，供运行前恢复和配置持久化校验使用。 */
export function computeChatRoomSkillSnapshotDigest(snapshotPath: string): string {
  assertSnapshotTarget(snapshotPath)
  const records: SyncFileRecord[] = []
  collectSourceTree(snapshotPath, '', records, { files: 0, bytes: 0 }, snapshotPath)
  return digestRecords(records)
}

function copyRecords(
  records: SyncFileRecord[],
  sourceRoot: string,
  destinationRoot: string,
  beforeWrite?: (path: string) => void,
): void {
  const destinationIdentity = captureDirectoryChain(destinationRoot, destinationRoot, 'Skill 快照目标目录发生变化')
  for (const record of records) {
    if (record.path === '') continue
    const target = join(destinationRoot, ...record.path.split('/'))
    if (record.type === 'D') {
      const parent = dirname(target)
      const parentIdentity = captureDirectoryChain(destinationRoot, parent, 'Skill 快照目标目录发生变化')
      assertDirectoryChainStable(destinationIdentity, 'Skill 快照目标目录发生变化')
      assertDirectoryChainStable(parentIdentity, 'Skill 快照目标目录发生变化')
      mkdirSync(target)
      assertDirectoryChainStable(parentIdentity, 'Skill 快照目标目录发生变化')
      assertDirectoryTarget(target, 'Skill 快照目标目录发生变化')
      syncParent(target)
    } else {
      const parentIdentity = captureDirectoryChain(destinationRoot, dirname(target), 'Skill 快照目标目录发生变化')
      assertDirectoryChainStable(destinationIdentity, 'Skill 快照目标目录发生变化')
      assertDirectoryChainStable(parentIdentity, 'Skill 快照目标目录发生变化')
      const source = join(sourceRoot, ...record.path.split('/'))
      assertContained(sourceRoot, source, 'Skill 快照源路径越界')
      // 读取已在收集阶段完成，写入仅使用内存中的受控 bytes。
      beforeWrite?.(target)
      assertDirectoryChainStable(parentIdentity, 'Skill 快照目标目录发生变化')
      const bytes = record.bytes ?? Buffer.alloc(0)
      const noFollow = (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0
      let fd = -1
      let writtenIdentity: { dev: number; ino: number } | undefined
      let writtenMtimeMs: number | undefined
      try {
        fd = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600)
        const opened = fstatSync(fd)
        if (!opened.isFile() || opened.nlink > 1) fail('Skill 快照目标目录发生变化')
        writtenIdentity = { dev: opened.dev, ino: opened.ino }
        let offset = 0
        while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
        fsyncSync(fd)
        const closed = fstatSync(fd)
        if (!closed.isFile() || closed.dev !== opened.dev || closed.ino !== opened.ino
          || closed.size !== bytes.length || closed.mtimeMs !== opened.mtimeMs) {
          fail('Skill 快照目标目录发生变化')
        }
        writtenMtimeMs = closed.mtimeMs
      } finally {
        if (fd >= 0) closeSync(fd)
      }
      chmodSync(target, 0o600)
      const targetStats = lstatSync(target)
      if (!targetStats.isFile() || !writtenIdentity
        || targetStats.dev !== writtenIdentity.dev || targetStats.ino !== writtenIdentity.ino
        || targetStats.nlink > 1 || targetStats.size !== bytes.length || targetStats.mtimeMs !== writtenMtimeMs) {
        fail('Skill 快照目标目录发生变化')
      }
      assertRegularTarget(target, 'Skill 快照目标目录发生变化')
      assertDirectoryChainStable(parentIdentity, 'Skill 快照目标目录发生变化')
      syncParent(target)
    }
  }
}

function assertDirectoryTarget(path: string, message: string): void {
  let stats
  try {
    stats = lstatSync(path)
  } catch {
    fail(message)
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) fail(message)
}

function assertRegularTarget(path: string, message: string): void {
  let stats
  try {
    stats = lstatSync(path)
  } catch {
    fail(message)
  }
  if (stats.isSymbolicLink() || !stats.isFile()) fail(message)
}

function assertSnapshotTarget(snapshotPath: string): void {
  try {
    const stats = lstatSync(snapshotPath)
    if (stats.isSymbolicLink() || !stats.isDirectory()) fail('Skill 快照目标不可用')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail('Skill 快照目标不可用')
  }
}

function journalPathFor(snapshotPath: string): string {
  return join(dirname(snapshotPath), JOURNAL_NAME)
}

function assertJournalFile(path: string, allowMissing = true): boolean {
  try {
    const stats = lstatSync(path)
    if (stats.isSymbolicLink() || !stats.isFile()) fail('Skill 快照 journal 不可用')
    return true
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return false
    fail('Skill 快照 journal 不可用')
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function validateJournal(value: unknown, roomId: string, roomAgentId: string): asserts value is SnapshotJournal {
  if (!isPlainRecord(value)) fail('Skill 快照 journal 无效')
  const keys = ['version', 'roomId', 'roomAgentId', 'targetDigest', 'previousDigest', 'nextName', 'previousName', 'phase']
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    fail('Skill 快照 journal 无效')
  }
  if (value.version !== 1 || value.roomId !== roomId || value.roomAgentId !== roomAgentId
    || typeof value.targetDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.targetDigest)
    || (value.previousDigest !== null && (typeof value.previousDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.previousDigest)))
    || typeof value.nextName !== 'string' || !NEXT_NAME_PATTERN.test(value.nextName)
    || value.previousName !== '.previous' || typeof value.phase !== 'string' || !JOURNAL_PHASES.has(value.phase)) {
    fail('Skill 快照 journal 无效')
  }
}

function readJournal(path: string, roomId: string, roomAgentId: string): SnapshotJournal | undefined {
  if (!assertJournalFile(path)) return undefined
  const fsConstants = constants as typeof constants & { O_NOFOLLOW?: number }
  const flags = constants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  let fd = -1
  try {
    fd = openSync(path, flags)
    const stats = fstatSync(fd)
    if (!stats.isFile() || stats.size > 8192) fail('Skill 快照 journal 无效')
    const bytes = readFdFully(fd, 8192, 'Skill 快照 journal')
    const value = JSON.parse(bytes.toString('utf8')) as unknown
    validateJournal(value, roomId, roomAgentId)
    return value
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Skill 快照')) throw error
    fail('Skill 快照 journal 无效')
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

function writeJournal(path: string, journal: SnapshotJournal): void {
  const tempPath = path + '.tmp'
  if (assertJournalFile(path)) fail('Skill 快照 journal 已存在')
  assertJournalFile(tempPath)
  const fsConstants = constants as typeof constants & { O_NOFOLLOW?: number }
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0)
  const bytes = Buffer.from(JSON.stringify(journal), 'utf8')
  let fd = -1
  try {
    fd = openSync(tempPath, flags, 0o600)
    let offset = 0
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
    fsyncSync(fd)
    closeSync(fd)
    fd = -1
    renameSync(tempPath, path)
    chmodSync(path, 0o600)
    syncParent(path)
  } catch {
    if (fd >= 0) closeSync(fd)
    throw new Error('Skill 快照 journal 写入失败')
  }
}

function removeJournal(path: string): void {
  if (!assertJournalFile(path)) return
  unlinkSync(path)
  syncParent(path)
}

function configuredSnapshotDigest(roomId: string, roomAgentId: string): string | undefined {
  const configPath = getChatRoomConfigPath(roomId)
  assertControlledDirectory(dirname(configPath), getChatRoomsRootPath(), '聊天室配置目录不可用')
  if (!assertJournalFile(configPath)) return undefined
  const result = readJsonFileSafeDetailed<unknown>(configPath, '聊天室配置')
  if (result.status === 'corrupt' || !isPlainRecord(result.value)) fail('聊天室配置不可用')
  const agents = result.value.agents
  if (!Array.isArray(agents)) fail('聊天室配置不可用')
  const agent = agents.find((value) => isPlainRecord(value) && value.roomAgentId === roomAgentId)
  if (!isPlainRecord(agent)) fail('聊天室 Agent 配置不可用')
  const digest = agent.skillSnapshotDigest
  if (digest !== undefined && (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))) {
    fail('聊天室 Agent 配置不可用')
  }
  return digest as string | undefined
}

/**
 * 在 Agent 使用快照前恢复未完成的交换。
 * 配置 digest 是提交事实：匹配目标 digest 时保留 current，否则恢复 previous
 * 或删除首次同步留下的未提交 current。
 */
function recoverChatRoomAgentSkillSnapshotUnlocked(
  input: RecoverChatRoomAgentSkillSnapshotInput,
): void {
  assertComponent(input.roomId, 'roomId')
  assertComponent(input.roomAgentId, 'roomAgentId')
  const snapshotPath = getChatRoomAgentSkillsSnapshotPath(input.roomId, input.roomAgentId)
  const parent = dirname(snapshotPath)
  assertControlledDirectory(parent, getChatRoomsRootPath(), 'Skill 快照目录不可用')
  const journalPath = journalPathFor(snapshotPath)
  const journal = readJournal(journalPath, input.roomId, input.roomAgentId)
  if (!journal) {
    if (assertJournalFile(journalPath + '.tmp')) removeJournal(journalPath + '.tmp')
    for (const entry of readdirSync(parent)) {
      if (NEXT_NAME_PATTERN.test(entry)) removeSafeTree(join(parent, entry))
    }
    return
  }
  const nextPath = join(parent, journal.nextName)
  const previousPath = join(parent, journal.previousName)
  assertSnapshotTarget(nextPath)
  assertSnapshotTarget(previousPath)
  assertSnapshotTarget(snapshotPath)

  const configuredDigest = configuredSnapshotDigest(input.roomId, input.roomAgentId)
  const currentExists = existsAsDirectory(snapshotPath)
  const currentDigest = currentExists ? computeChatRoomSkillSnapshotDigest(snapshotPath) : undefined
  const clearJournalFiles = (): void => {
    removeJournal(journalPath)
    if (assertJournalFile(journalPath + '.tmp')) removeJournal(journalPath + '.tmp')
  }
  if (configuredDigest === journal.targetDigest) {
    if (!currentExists || currentDigest !== journal.targetDigest) fail('Skill 快照 journal 与配置不一致')
    removeSafeTree(nextPath)
    removeSafeTree(previousPath)
    clearJournalFiles()
    return
  }

  const previousExists = existsAsDirectory(previousPath)
  const previousDigest = previousExists ? computeChatRoomSkillSnapshotDigest(previousPath) : undefined
  const expectedPreviousDigest = journal.previousDigest ?? EMPTY_SNAPSHOT_DIGEST
  const validatePrevious = (): void => {
    if (previousDigest !== expectedPreviousDigest) fail('Skill 快照 previous 与配置不一致')
  }
  const removeNextAndJournal = (): void => {
    removeSafeTree(nextPath)
    clearJournalFiles()
  }

  if (journal.phase === 'prepared') {
    // marker 已写但 current 尚未移动；若 marker 写入后恰好发生了 current→previous，
    // 也可以依据受控 previous 摘要完成恢复。
    if (previousExists) {
      validatePrevious()
      if (currentExists) {
        if (currentDigest !== journal.targetDigest) fail('Skill 快照 prepared 状态不一致')
        removeSafeTree(snapshotPath)
      }
      restorePreviousSnapshot(previousPath, snapshotPath)
    } else if (currentDigest === journal.targetDigest && journal.previousDigest === null) {
      // 首次同步的 current 已经由 next rename 产生，但 marker 仍是 prepared。
      removeSafeTree(snapshotPath)
    } else if (currentDigest !== undefined && currentDigest !== expectedPreviousDigest) {
      fail('Skill 快照 current 与配置不一致')
    } else if (currentDigest === undefined && journal.previousDigest !== null) {
      fail('Skill 快照 current 与配置不一致')
    }
    removeNextAndJournal()
    return
  }

  if (journal.phase === 'current_moved') {
    if (!previousExists) fail('Skill 快照 current_moved 状态不一致')
    validatePrevious()
    if (currentExists) {
      if (currentDigest !== journal.targetDigest) fail('Skill 快照 current_moved 状态不一致')
      removeSafeTree(snapshotPath)
    }
    restorePreviousSnapshot(previousPath, snapshotPath)
    removeNextAndJournal()
    return
  }

  if (journal.phase === 'next_moved') {
    if (currentDigest !== journal.targetDigest) fail('Skill 快照 current 与 journal 不一致')
    if (previousExists) {
      validatePrevious()
      removeSafeTree(snapshotPath)
      restorePreviousSnapshot(previousPath, snapshotPath)
    } else if (journal.previousDigest !== null) {
      fail('Skill 快照 previous 与配置不一致')
    } else {
      // 首次同步没有已提交 previous，回滚到不存在的快照。
      removeSafeTree(snapshotPath)
    }
    removeNextAndJournal()
    return
  }

  // config_persisted/cleanup 但配置尚未落盘时，按 next_moved 的旧配置路径回滚；
  // 配置已是 target 的分支在上方已经保留 current。
  if (currentDigest === journal.targetDigest && previousExists) {
    validatePrevious()
    removeSafeTree(snapshotPath)
    restorePreviousSnapshot(previousPath, snapshotPath)
  } else if (currentDigest === journal.targetDigest && journal.previousDigest === null && !previousExists) {
    removeSafeTree(snapshotPath)
  } else {
    fail('Skill 快照 journal 与配置不一致')
  }
  removeNextAndJournal()
}

function acquireLockForInput(roomId: string, roomAgentId: string): SnapshotLockHandle {
  const snapshotPath = getChatRoomAgentSkillsSnapshotPath(roomId, roomAgentId)
  const parent = dirname(snapshotPath)
  assertControlledDirectory(parent, getChatRoomsRootPath(), 'Skill 快照目录不可用')
  return acquireSnapshotLock(join(parent, SNAPSHOT_LOCK_NAME))
}

export function recoverChatRoomAgentSkillSnapshot(
  input: RecoverChatRoomAgentSkillSnapshotInput,
): void {
  assertComponent(input.roomId, 'roomId')
  assertComponent(input.roomAgentId, 'roomAgentId')
  const owner = acquireLockForInput(input.roomId, input.roomAgentId)
  try {
    recoverChatRoomAgentSkillSnapshotUnlocked(input)
  } finally {
    releaseSnapshotLock(owner)
  }
}

function syncChatRoomAgentSkillSnapshotUnlocked(input: SyncChatRoomAgentSkillSnapshotInput): ChatRoomSkillSnapshotResult {
  assertComponent(input.roomId, 'roomId')
  assertComponent(input.roomAgentId, 'roomAgentId')
  assertComponent(input.sourceWorkspaceSlug, 'sourceWorkspaceSlug')
  recoverChatRoomAgentSkillSnapshotUnlocked(input)

  const sourceRoot = getWorkspaceSkillsDir(input.sourceWorkspaceSlug)
  const configDir = getConfigDir()
  assertControlledDirectory(sourceRoot, configDir, 'Skill 源目录不可用')

  const snapshotPath = getChatRoomAgentSkillsSnapshotPath(input.roomId, input.roomAgentId)
  const roomsRoot = getChatRoomsRootPath()
  assertControlledDirectory(dirname(snapshotPath), roomsRoot, 'Skill 快照目录不可用')
  assertSnapshotTarget(snapshotPath)
  assertNotWithin(sourceRoot, snapshotPath, 'Skill 快照源路径与目标冲突')

  const enabledSkills = getWorkspaceSkillsReadOnly(input.sourceWorkspaceSlug)
    .filter((skill: SkillMeta) => skill.enabled !== false)
    .sort((left, right) => compareStableText(left.slug, right.slug))
  const records: SyncFileRecord[] = []
  const counters = { files: 0, bytes: 0 }
  records.push({ type: 'D', path: '' })
  for (const skill of enabledSkills) {
    assertComponent(skill.slug, 'Skill slug')
    const sourceSkill = join(sourceRoot, skill.slug)
    assertContained(sourceRoot, sourceSkill, 'Skill 源路径越界')
    let stats
    try {
      stats = lstatSync(sourceSkill)
    } catch {
      fail('Skill 源目录不可用')
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) fail('Skill 快照只允许普通目录')
    collectSourceTree(sourceSkill, skill.slug, records, counters, sourceRoot, input.testHooks?.beforeRead)
  }

  const parent = dirname(snapshotPath)
  const nextPath = join(parent, '.next-' + randomUUID())
  const previousPath = join(parent, '.previous')
  const journalPath = journalPathFor(snapshotPath)
  const workspaceStore = input.workspaceStore ?? new ChatRoomWorkspaceStore()
  const configuredDigest = configuredSnapshotDigest(input.roomId, input.roomAgentId)
  const previousDigest = configuredDigest ?? null
  assertSnapshotTarget(previousPath)
  // provisionAgent 会预创建一个空的受控目录；它不是已提交的 previous。
  if (configuredDigest === undefined && existsAsDirectory(snapshotPath)
    && computeChatRoomSkillSnapshotDigest(snapshotPath) === EMPTY_SNAPSHOT_DIGEST) {
    removeSafeTree(snapshotPath)
  }
  mkdirSync(nextPath, { recursive: false, mode: 0o700 })
  const digest = digestRecords(records)
  const result: ChatRoomSkillSnapshotResult = {
    snapshotPath,
    digest,
    skillSlugs: enabledSkills.map((skill) => skill.slug),
    syncedAt: Date.now(),
  }
  const journal: SnapshotJournal = {
    version: 1,
    roomId: input.roomId,
    roomAgentId: input.roomAgentId,
    targetDigest: digest,
    previousDigest,
    nextName: nextPath.slice(parent.length + 1),
    previousName: '.previous',
    phase: 'prepared',
  }

  try {
    writeJournal(journalPath, journal)
    input.testHooks?.afterJournalPhase?.(journal.phase)
    copyRecords(records, sourceRoot, nextPath, input.testHooks?.beforeWrite)
    applyReadOnly(nextPath)
    syncDirectory(nextPath)
    removeSafeTree(previousPath)
    let currentExists = false
    try {
      lstatSync(snapshotPath)
      currentExists = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (currentExists) {
      renameSync(snapshotPath, previousPath)
      syncParent(snapshotPath)
      journal.phase = 'current_moved'
      input.testHooks?.afterJournalPhase?.(journal.phase)
    }
    renameSync(nextPath, snapshotPath)
    syncParent(nextPath)
    journal.phase = 'next_moved'
    input.testHooks?.afterJournalPhase?.(journal.phase)
    workspaceStore.updateAgentSkillSnapshot(input.roomId, input.roomAgentId, result)
    journal.phase = 'config_persisted'
    input.testHooks?.afterJournalPhase?.(journal.phase)
    removeSafeTree(previousPath)
    journal.phase = 'cleanup'
    input.testHooks?.afterJournalPhase?.(journal.phase)
    removeJournal(journalPath)
    return result
  } catch (error) {
    try {
      // 不依赖内存中的 configPersisted/rename 标志；重新读取配置、current、previous
      // 和 journal，覆盖 update 已写入后才抛错以及 marker 落后于 FS 的窗口。
      recoverChatRoomAgentSkillSnapshotUnlocked(input)
    } catch {
      // journal 保留到下一次运行前恢复，避免配置与快照被静默分离。
    }
    if (error instanceof Error && (error.message.startsWith('Skill ') || error.message.startsWith('room_') || error.message.startsWith('invalid_'))) {
      throw error
    }
    fail('Skill 快照同步失败')
  }
}

export function syncChatRoomAgentSkillSnapshot(input: SyncChatRoomAgentSkillSnapshotInput): ChatRoomSkillSnapshotResult {
  assertComponent(input.roomId, 'roomId')
  assertComponent(input.roomAgentId, 'roomAgentId')
  assertComponent(input.sourceWorkspaceSlug, 'sourceWorkspaceSlug')
  const owner = acquireLockForInput(input.roomId, input.roomAgentId)
  try {
    return syncChatRoomAgentSkillSnapshotUnlocked(input)
  } finally {
    releaseSnapshotLock(owner)
  }
}

export const __chatRoomSkillSnapshotTestHooks = {
  acquire: (lockPath: string): SnapshotLockHandle => acquireSnapshotLock(lockPath),
  release: (owner: SnapshotLockHandle): void => releaseSnapshotLock(owner),
}

function restorePreviousSnapshot(previousPath: string, snapshotPath: string): void {
  renameSync(previousPath, snapshotPath)
  syncParent(snapshotPath)
  applyReadOnly(snapshotPath)
}

function existsAsDirectory(path: string): boolean {
  try {
    const stats = lstatSync(path)
    return stats.isDirectory() && !stats.isSymbolicLink()
  } catch {
    return false
  }
}
