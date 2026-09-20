import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { getWorkspaceSkills } from './agent-workspace-manager'
import type { SkillMeta } from '@copis/shared'
import {
  getChatRoomAgentSkillsSnapshotPath,
  getChatRoomsRootPath,
  getConfigDir,
  getWorkspaceSkillsDir,
} from './config-paths'
import { ChatRoomWorkspaceStore } from './chatroom-workspace-store'

const COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const MAX_FILES = 10_000
const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_BYTES = 100 * 1024 * 1024

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
}

export interface ChatRoomSkillSnapshotResult {
  snapshotPath: string
  digest: string
  skillSlugs: string[]
  syncedAt: number
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

function normalizeRelativePath(path: string): string {
  return path.split(sep).join('/')
}

function readRegularFile(path: string, expected: { dev: number; ino: number; size: number; mtimeMs: number }): Buffer {
  if (expected.size > MAX_FILE_BYTES) fail('Skill 快照文件过大')
  const fsConstants = constants as typeof constants & { O_NOFOLLOW?: number }
  const flags = constants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
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
    return bytes
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Skill 快照')) throw error
    fail('Skill 快照文件读取失败')
  } finally {
    if (fd >= 0) closeSync(fd)
  }
  return Buffer.alloc(0)
}

function collectSourceTree(path: string, relativePath: string, records: SyncFileRecord[], counters: { files: number; bytes: number }): void {
  let stats
  try {
    stats = lstatSync(path)
  } catch {
    fail('Skill 快照源文件不可用')
  }
  if (stats.isSymbolicLink()) fail('Skill 快照不允许符号链接')
  if (stats.isDirectory()) {
    records.push({ type: 'D', path: normalizeRelativePath(relativePath) })
    const entries = readdirSync(path, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const child = relativePath ? relativePath + '/' + entry.name : entry.name
      collectSourceTree(join(path, entry.name), child, records, counters)
    }
    return
  }
  if (!stats.isFile()) fail('Skill 快照只允许普通文件和目录')
  if (stats.nlink > 1) fail('Skill 快照不允许硬链接')
  counters.files += 1
  counters.bytes += stats.size
  if (counters.files > MAX_FILES || counters.bytes > MAX_TOTAL_BYTES) fail('Skill 快照超出大小限制')
  records.push({ type: 'F', path: normalizeRelativePath(relativePath), bytes: readRegularFile(path, stats) })
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
    if (process.platform !== 'win32') chmodSync(path, 0o500)
    return
  }
  if (!stats.isFile()) fail('Skill 快照只允许普通文件和目录')
  if (process.platform !== 'win32') chmodSync(path, 0o400)
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
    if (process.platform !== 'win32') chmodSync(path, 0o700)
    for (const entry of readdirSync(path)) removeSafeTree(join(path, entry))
    rmdirSync(path)
    return
  }
  if (!stats.isFile()) fail('Skill 快照清理失败')
  unlinkSync(path)
}

function digestRecords(records: SyncFileRecord[]): string {
  const hash = createHash('sha256')
  for (const record of [...records].sort((left, right) => left.path.localeCompare(right.path) || left.type.localeCompare(right.type))) {
    hash.update(record.type)
    hash.update('\0')
    hash.update(record.path)
    hash.update('\0')
    if (record.bytes) hash.update(record.bytes)
    hash.update('\0')
  }
  return hash.digest('hex')
}

function copyRecords(records: SyncFileRecord[], sourceRoot: string, destinationRoot: string): void {
  for (const record of records) {
    if (record.path === '') continue
    const target = join(destinationRoot, ...record.path.split('/'))
    if (record.type === 'D') {
      mkdirSync(target)
    } else {
      mkdirSync(dirname(target), { recursive: true })
      const source = join(sourceRoot, ...record.path.split('/'))
      assertContained(sourceRoot, source, 'Skill 快照源路径越界')
      // 读取已在收集阶段完成，写入仅使用内存中的受控 bytes。
      writeFileSync(target, record.bytes ?? Buffer.alloc(0), { mode: 0o600, flag: 'wx' })
    }
  }
}

function assertSnapshotTarget(snapshotPath: string): void {
  try {
    const stats = lstatSync(snapshotPath)
    if (stats.isSymbolicLink() || !stats.isDirectory()) fail('Skill 快照目标不可用')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail('Skill 快照目标不可用')
  }
}

function validateAllSourceEntries(root: string): void {
  collectSourceTree(root, '', [], { files: 0, bytes: 0 })
}

export function syncChatRoomAgentSkillSnapshot(input: SyncChatRoomAgentSkillSnapshotInput): ChatRoomSkillSnapshotResult {
  assertComponent(input.roomId, 'roomId')
  assertComponent(input.roomAgentId, 'roomAgentId')
  assertComponent(input.sourceWorkspaceSlug, 'sourceWorkspaceSlug')

  const sourceRoot = getWorkspaceSkillsDir(input.sourceWorkspaceSlug)
  const configDir = getConfigDir()
  assertControlledDirectory(sourceRoot, configDir, 'Skill 源目录不可用')
  validateAllSourceEntries(sourceRoot)

  const snapshotPath = getChatRoomAgentSkillsSnapshotPath(input.roomId, input.roomAgentId)
  const roomsRoot = getChatRoomsRootPath()
  assertControlledDirectory(dirname(snapshotPath), roomsRoot, 'Skill 快照目录不可用')
  assertSnapshotTarget(snapshotPath)
  assertNotWithin(sourceRoot, snapshotPath, 'Skill 快照源路径与目标冲突')

  const enabledSkills = getWorkspaceSkills(input.sourceWorkspaceSlug)
    .filter((skill: SkillMeta) => skill.enabled !== false)
    .sort((left, right) => left.slug.localeCompare(right.slug))
  const records: SyncFileRecord[] = []
  const counters = { files: 0, bytes: 0 }
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
    collectSourceTree(sourceSkill, skill.slug, records, counters)
  }

  const parent = dirname(snapshotPath)
  const nextPath = join(parent, '.next-' + randomUUID())
  const previousPath = join(parent, '.previous')
  assertSnapshotTarget(previousPath)
  mkdirSync(nextPath, { recursive: false, mode: 0o700 })
  const digest = digestRecords(records)
  const result: ChatRoomSkillSnapshotResult = {
    snapshotPath,
    digest,
    skillSlugs: enabledSkills.map((skill) => skill.slug),
    syncedAt: Date.now(),
  }

  let previousMoved = false
  try {
    copyRecords(records, sourceRoot, nextPath)
    applyReadOnly(nextPath)
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
      previousMoved = true
    }
    renameSync(nextPath, snapshotPath)
    try {
      (input.workspaceStore ?? new ChatRoomWorkspaceStore()).updateAgentSkillSnapshot(input.roomId, input.roomAgentId, result)
    } catch (error) {
      removeSafeTree(snapshotPath)
      if (previousMoved) restorePreviousSnapshot(previousPath, snapshotPath)
      throw error
    }
    removeSafeTree(previousPath)
    return result
  } catch (error) {
    try {
      removeSafeTree(nextPath)
    } catch {
      // 临时目录若被替换为非安全类型，绝不跟随删除。
    }
    if (previousMoved) {
      try {
        if (!existsAsDirectory(snapshotPath)) restorePreviousSnapshot(previousPath, snapshotPath)
      } catch {
        // 保留受控 previous，等待下一次显式同步或人工恢复。
      }
    }
    if (error instanceof Error && (error.message.startsWith('Skill ') || error.message.startsWith('room_') || error.message.startsWith('invalid_'))) {
      throw error
    }
    fail('Skill 快照同步失败')
  }
}

function restorePreviousSnapshot(previousPath: string, snapshotPath: string): void {
  renameSync(previousPath, snapshotPath)
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
