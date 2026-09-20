import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  renameSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

const testHome = join(process.env.TMPDIR ?? '/tmp', `copis-chatroom-skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)

mock.module('electron', () => ({ app: { isPackaged: false } }))
mock.module('node:os', () => ({ homedir: () => testHome }))

const {
  getChatRoomAgentSkillsSnapshotPath,
  getInactiveSkillsDir,
  getWorkspaceSkillsDir,
} = await import('./config-paths')
const { ChatRoomWorkspaceStore } = await import('./chatroom-workspace-store')
const { syncChatRoomAgentSkillSnapshot } = await import('./chatroom-skill-snapshot')
const {
  computeChatRoomSkillSnapshotDigest,
  recoverChatRoomAgentSkillSnapshot,
} = await import('./chatroom-skill-snapshot')

const identity = { hostUserId: 'host-1', deviceId: 'device-1' }
const roomId = 'room-1'
let roomAgentId = ''
const sourceWorkspaceSlug = 'workspace-1'

function sourceRoot(): string {
  return getWorkspaceSkillsDir(sourceWorkspaceSlug)
}

function snapshotPath(): string {
  return getChatRoomAgentSkillsSnapshotPath(roomId, roomAgentId)
}

function writeSkill(slug: string, file = 'SKILL.md', content = `---\nname: ${slug}\n---\n`): string {
  const skillPath = join(sourceRoot(), slug)
  mkdirSync(skillPath, { recursive: true })
  mkdirSync(join(skillPath, file, '..'), { recursive: true })
  writeFileSync(join(skillPath, file), content, 'utf-8')
  return skillPath
}

function hashDirectory(root: string): string {
  const entries: string[] = []
  const walk = (current: string, relative: string): void => {
    entries.push(`D\\0${relative}`)
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name
      const child = join(current, entry.name)
      if (entry.isDirectory()) walk(child, childRelative)
      else entries.push(`F\\0${childRelative}\\0${readFileSync(child, 'utf-8')}`)
    }
  }
  walk(root, '')
  return createHash('sha256').update(entries.join('\\n')).digest('hex')
}

function provision(): void {
  const store = new ChatRoomWorkspaceStore({ identity, now: () => 1_700_000_000_000 })
  const saved = store.provisionAgent(identity, {
    roomId,
    sourceWorkspaceId: sourceWorkspaceSlug,
    displayName: 'Agent A',
    channelId: 'channel-1',
  })
  roomAgentId = saved.agents[0]!.roomAgentId
}

function makeWritable(path: string): void {
  try {
    const stats = lstatSync(path)
    if (stats.isSymbolicLink()) return
    const isDirectory = (stats.mode & 0o170000) === 0o040000
    chmodSync(path, isDirectory ? 0o700 : 0o600)
    if (isDirectory) for (const entry of readdirSync(path)) makeWritable(join(path, entry))
  } catch {
    // 测试清理阶段忽略已删除路径。
  }
}

function cleanup(): void {
  if (!existsSync(testHome)) return
  makeWritable(testHome)
  chmodSync(testHome, 0o700)
  rmSync(testHome, { recursive: true, force: true })
}

function writeJournal(snapshot: string, journal: Record<string, unknown>): void {
  writeFileSync(join(dirname(snapshot), '.snapshot-journal.json'), JSON.stringify(journal), 'utf-8')
}

beforeEach(() => {
  cleanup()
  mkdirSync(testHome, { recursive: true })
  provision()
})

afterEach(cleanup)

describe('聊天室 Agent Skill 只读快照', () => {
  test('Given 来源工作区有启用和禁用 Skill When 同步 Then 只复制启用 Skill', () => {
    writeSkill('enabled-skill')
    const disabled = join(getInactiveSkillsDir(sourceWorkspaceSlug), 'disabled-skill')
    mkdirSync(disabled, { recursive: true })
    writeFileSync(join(disabled, 'SKILL.md'), 'disabled', 'utf-8')

    const result = syncChatRoomAgentSkillSnapshot({ roomId, roomAgentId, sourceWorkspaceSlug })

    expect(readdirSync(result.snapshotPath).sort()).toEqual(['enabled-skill'])
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(result.skillSlugs).toEqual(['enabled-skill'])
    expect(lstatSync(join(result.snapshotPath, 'enabled-skill')).mode & 0o777).toBe(0o500)
    expect(lstatSync(join(result.snapshotPath, 'enabled-skill', 'SKILL.md')).mode & 0o777).toBe(0o400)
  })

  test('Given Skill 内含符号链接 When 同步 Then 拒绝且保留旧快照', () => {
    const oldSnapshot = snapshotPath()
    mkdirSync(oldSnapshot, { recursive: true })
    writeFileSync(join(oldSnapshot, 'old.txt'), 'old-snapshot', 'utf-8')
    writeSkill('enabled-skill')
    if (process.platform === 'win32') return
    symlinkSync(testHome, join(sourceRoot(), 'enabled-skill', 'escape'), 'dir')

    expect(() => syncChatRoomAgentSkillSnapshot({ roomId, roomAgentId, sourceWorkspaceSlug })).toThrow('Skill 快照不允许符号链接')
    expect(readFileSync(join(oldSnapshot, 'old.txt'), 'utf-8')).toBe('old-snapshot')
  })

  test('Given Skill 的 SKILL.md 是符号链接 When 同步 Then 不静默遗漏而 fail closed', () => {
    if (process.platform === 'win32') return
    const skillPath = writeSkill('linked-skill')
    const external = join(testHome, 'external-skill.md')
    writeFileSync(external, 'external', 'utf-8')
    rmSync(join(skillPath, 'SKILL.md'))
    symlinkSync(external, join(skillPath, 'SKILL.md'))

    expect(() => syncChatRoomAgentSkillSnapshot({ roomId, roomAgentId, sourceWorkspaceSlug })).toThrow()
  })

  test('Given 来源 Skill 后续变化 When Agent 运行但未同步 Then 快照内容不变', () => {
    const sourceFile = join(writeSkill('enabled-skill'), 'SKILL.md')
    const first = syncChatRoomAgentSkillSnapshot({ roomId, roomAgentId, sourceWorkspaceSlug })
    writeFileSync(sourceFile, 'changed', 'utf-8')

    expect(readFileSync(join(first.snapshotPath, 'enabled-skill', 'SKILL.md'), 'utf-8')).not.toBe('changed')
    expect(readFileSync(join(first.snapshotPath, 'enabled-skill', 'SKILL.md'), 'utf-8')).toContain('name: enabled-skill')
  })

  test('Given 已有只读快照 When 再次同步 Then 原子替换并清理 previous', () => {
    writeSkill('enabled-skill', 'SKILL.md', 'first')
    const first = syncChatRoomAgentSkillSnapshot({ roomId, roomAgentId, sourceWorkspaceSlug })
    writeFileSync(join(sourceRoot(), 'enabled-skill', 'SKILL.md'), 'second', 'utf-8')

    const second = syncChatRoomAgentSkillSnapshot({ roomId, roomAgentId, sourceWorkspaceSlug })

    expect(second.digest).not.toBe(first.digest)
    expect(readFileSync(join(second.snapshotPath, 'enabled-skill', 'SKILL.md'), 'utf-8')).toContain('second')
    expect(existsSync(join(dirnameForTest(second.snapshotPath), '.previous'))).toBe(false)
  })

  test('Given 快照已 swap 但配置持久化失败 When 同步 Then 恢复旧快照和旧配置摘要', () => {
    writeSkill('enabled-skill', 'SKILL.md', 'first')
    const first = syncChatRoomAgentSkillSnapshot({ roomId, roomAgentId, sourceWorkspaceSlug })
    writeFileSync(join(sourceRoot(), 'enabled-skill', 'SKILL.md'), 'second', 'utf-8')
    const failingStore = {
      updateAgentSkillSnapshot: () => { throw new Error('persist failed') },
    } as unknown as InstanceType<typeof ChatRoomWorkspaceStore>

    expect(() => syncChatRoomAgentSkillSnapshot({
      roomId,
      roomAgentId,
      sourceWorkspaceSlug,
      workspaceStore: failingStore,
    })).toThrow('Skill 快照同步失败')
    expect(readFileSync(join(first.snapshotPath, 'enabled-skill', 'SKILL.md'), 'utf-8')).toContain('first')
    expect(existsSync(join(dirnameForTest(first.snapshotPath), '.previous'))).toBe(false)
  })

  test('Given Skill 树结构相同但创建顺序不同 When 同步 Then digest 稳定且覆盖空目录与类型', () => {
    const firstSkill = writeSkill('z-skill', 'empty-dir/placeholder', 'empty')
    mkdirSync(join(firstSkill, 'empty'), { recursive: true })
    writeSkill('a-skill', 'file', 'file')
    const first = syncChatRoomAgentSkillSnapshot({ roomId, roomAgentId, sourceWorkspaceSlug })

    rmSync(join(sourceRoot(), 'a-skill'), { recursive: true, force: true })
    rmSync(join(sourceRoot(), 'z-skill'), { recursive: true, force: true })
    writeSkill('a-skill', 'file', 'file')
    const secondSkill = writeSkill('z-skill', 'empty-dir/placeholder', 'empty')
    mkdirSync(join(secondSkill, 'empty'), { recursive: true })
    const second = syncChatRoomAgentSkillSnapshot({ roomId, roomAgentId, sourceWorkspaceSlug })

    expect(second.digest).toBe(first.digest)
  })

  test('Given source root 或 snapshot parent 为符号链接 When 同步 Then fail closed', () => {
    if (process.platform === 'win32') return
    writeSkill('enabled-skill')
    const sourceSkills = sourceRoot()
    const realSkills = join(testHome, 'real-skills')
    rmSync(sourceSkills, { recursive: true, force: true })
    mkdirSync(realSkills, { recursive: true })
    symlinkSync(realSkills, sourceSkills, 'dir')
    expect(() => syncChatRoomAgentSkillSnapshot({ roomId, roomAgentId, sourceWorkspaceSlug })).toThrow()

    rmSync(sourceSkills, { force: true })
    mkdirSync(sourceSkills, { recursive: true })
    writeSkill('enabled-skill')
    const snapshot = snapshotPath()
    const target = join(testHome, 'external-snapshot')
    rmSync(snapshot, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })
    symlinkSync(target, snapshot, 'dir')
    expect(() => syncChatRoomAgentSkillSnapshot({ roomId, roomAgentId, sourceWorkspaceSlug })).toThrow()
  })

  test('Given 同步完成 When 读取 room 配置 Then 只在 swap 成功后写入 digest 且禁用共享不删除快照', () => {
    writeSkill('enabled-skill')
    const result = syncChatRoomAgentSkillSnapshot({ roomId, roomAgentId, sourceWorkspaceSlug })
    const store = new ChatRoomWorkspaceStore({ identity, now: () => 1_700_000_000_001 })
    expect(store.getAgent(roomId, roomAgentId)?.skillSnapshotDigest).toBe(result.digest)

    store.updateAgent({ roomId, roomAgentId, skillSharingEnabled: false })
    expect(existsSync(result.snapshotPath)).toBe(true)
    expect(store.getAgent(roomId, roomAgentId)?.skillSnapshotDigest).toBe(result.digest)
  })

  test('Given current 已移到 previous 但 config 仍是旧 digest When 启动恢复 Then 回滚旧快照并清理 journal', () => {
    writeSkill('enabled-skill', 'SKILL.md', 'old')
    const first = syncChatRoomAgentSkillSnapshot({ roomId, roomAgentId, sourceWorkspaceSlug })
    const previousPath = join(dirname(first.snapshotPath), '.previous')
    const nextPath = join(dirname(first.snapshotPath), '.next-11111111-1111-4111-8111-111111111111')
    renameSync(first.snapshotPath, previousPath)
    cpSync(previousPath, nextPath, { recursive: true })
    makeWritable(nextPath)
    writeFileSync(join(nextPath, 'enabled-skill', 'SKILL.md'), 'new', 'utf-8')
    const targetDigest = computeChatRoomSkillSnapshotDigest(nextPath)
    writeJournal(first.snapshotPath, {
      version: 1,
      roomId,
      roomAgentId,
      targetDigest,
      previousDigest: first.digest,
      nextName: '.next-11111111-1111-4111-8111-111111111111',
      previousName: '.previous',
      phase: 'current_moved',
    })

    recoverChatRoomAgentSkillSnapshot({ roomId, roomAgentId })

    expect(readFileSync(join(first.snapshotPath, 'enabled-skill', 'SKILL.md'), 'utf-8')).toContain('old')
    expect(existsSync(previousPath)).toBe(false)
    expect(existsSync(nextPath)).toBe(false)
  })

  test('Given journal 处于 prepared 且 current 尚未移动 When 启动恢复 Then 保留旧 current 并删除未完成 next', () => {
    writeSkill('enabled-skill', 'SKILL.md', 'old')
    const first = syncChatRoomAgentSkillSnapshot({ roomId, roomAgentId, sourceWorkspaceSlug })
    const nextPath = join(dirname(first.snapshotPath), '.next-33333333-3333-4333-8333-333333333333')
    cpSync(first.snapshotPath, nextPath, { recursive: true })
    makeWritable(nextPath)
    writeFileSync(join(nextPath, 'enabled-skill', 'SKILL.md'), 'new', 'utf-8')
    const targetDigest = computeChatRoomSkillSnapshotDigest(nextPath)
    writeJournal(first.snapshotPath, {
      version: 1,
      roomId,
      roomAgentId,
      targetDigest,
      previousDigest: first.digest,
      nextName: '.next-33333333-3333-4333-8333-333333333333',
      previousName: '.previous',
      phase: 'prepared',
    })

    recoverChatRoomAgentSkillSnapshot({ roomId, roomAgentId })

    expect(readFileSync(join(first.snapshotPath, 'enabled-skill', 'SKILL.md'), 'utf-8')).toContain('old')
    expect(existsSync(nextPath)).toBe(false)
  })

  test('Given next 已成为 current 但 config 仍是旧 digest When 启动恢复 Then 删除新 current 并恢复 previous', () => {
    writeSkill('enabled-skill', 'SKILL.md', 'old')
    const first = syncChatRoomAgentSkillSnapshot({ roomId, roomAgentId, sourceWorkspaceSlug })
    const previousPath = join(dirname(first.snapshotPath), '.previous')
    const nextPath = join(dirname(first.snapshotPath), '.next-44444444-4444-4444-8444-444444444444')
    renameSync(first.snapshotPath, previousPath)
    cpSync(previousPath, nextPath, { recursive: true })
    makeWritable(nextPath)
    writeFileSync(join(nextPath, 'enabled-skill', 'SKILL.md'), 'new', 'utf-8')
    const targetDigest = computeChatRoomSkillSnapshotDigest(nextPath)
    renameSync(nextPath, first.snapshotPath)
    writeJournal(first.snapshotPath, {
      version: 1,
      roomId,
      roomAgentId,
      targetDigest,
      previousDigest: first.digest,
      nextName: '.next-44444444-4444-4444-8444-444444444444',
      previousName: '.previous',
      phase: 'next_moved',
    })

    recoverChatRoomAgentSkillSnapshot({ roomId, roomAgentId })

    expect(readFileSync(join(first.snapshotPath, 'enabled-skill', 'SKILL.md'), 'utf-8')).toContain('old')
    expect(existsSync(previousPath)).toBe(false)
  })

  test('Given 首次同步 next 已成为 current 且没有 previous When 启动恢复 Then 回滚到无快照状态', () => {
    const emptyCurrent = snapshotPath()
    const nextPath = join(dirname(emptyCurrent), '.next-55555555-5555-4555-8555-555555555555')
    rmSync(emptyCurrent, { recursive: true, force: true })
    mkdirSync(join(nextPath, 'enabled-skill'), { recursive: true })
    writeFileSync(join(nextPath, 'enabled-skill', 'SKILL.md'), 'new', 'utf-8')
    const targetDigest = computeChatRoomSkillSnapshotDigest(nextPath)
    renameSync(nextPath, emptyCurrent)
    writeJournal(emptyCurrent, {
      version: 1,
      roomId,
      roomAgentId,
      targetDigest,
      previousDigest: null,
      nextName: '.next-55555555-5555-4555-8555-555555555555',
      previousName: '.previous',
      phase: 'next_moved',
    })

    recoverChatRoomAgentSkillSnapshot({ roomId, roomAgentId })

    expect(existsSync(emptyCurrent)).toBe(false)
  })

  test('Given config 已是目标 digest 且 current 完整 When 启动恢复 Then 保留 current 并清理 previous', () => {
    writeSkill('enabled-skill', 'SKILL.md', 'stable')
    const first = syncChatRoomAgentSkillSnapshot({ roomId, roomAgentId, sourceWorkspaceSlug })
    const previousPath = join(dirname(first.snapshotPath), '.previous')
    cpSync(first.snapshotPath, previousPath, { recursive: true })
    writeFileSync(join(dirname(first.snapshotPath), '.snapshot-journal.json'), JSON.stringify({
      version: 1,
      roomId,
      roomAgentId,
      targetDigest: first.digest,
      previousDigest: first.digest,
      nextName: '.next-22222222-2222-4222-8222-222222222222',
      previousName: '.previous',
      phase: 'config_persisted',
    }))

    recoverChatRoomAgentSkillSnapshot({ roomId, roomAgentId })

    expect(computeChatRoomSkillSnapshotDigest(first.snapshotPath)).toBe(first.digest)
    expect(existsSync(previousPath)).toBe(false)
  })

  test('Given active Skill 含非 ASCII slug When 同步顺序变化 Then digest 使用稳定 code-unit 顺序', () => {
    writeSkill('z-skill', '中.md', '中')
    writeSkill('a-skill', 'é.md', 'é')
    const first = syncChatRoomAgentSkillSnapshot({ roomId, roomAgentId, sourceWorkspaceSlug })
    rmSync(join(sourceRoot(), 'z-skill'), { recursive: true, force: true })
    rmSync(join(sourceRoot(), 'a-skill'), { recursive: true, force: true })
    writeSkill('a-skill', 'é.md', 'é')
    writeSkill('z-skill', '中.md', '中')
    const second = syncChatRoomAgentSkillSnapshot({ roomId, roomAgentId, sourceWorkspaceSlug })

    expect(second.digest).toBe(first.digest)
  })

  test('Given Skill frontmatter 不完整 When 只读同步 Then 不执行自愈且日志不泄露绝对路径', () => {
    const sourceFile = join(writeSkill('no-repair', 'SKILL.md', '# No repair'), 'SKILL.md')
    const logs: string[] = []
    const originalLog = console.log
    const originalWarn = console.warn
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    console.warn = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      syncChatRoomAgentSkillSnapshot({ roomId, roomAgentId, sourceWorkspaceSlug })
    } finally {
      console.log = originalLog
      console.warn = originalWarn
    }
    expect(readFileSync(sourceFile, 'utf-8')).toBe('# No repair')
    expect(logs.join('\n')).not.toContain(testHome)
  })

  test('Given source parent 在读取前被替换 When 同步 Then fail closed 且不读取外部树', () => {
    const skillPath = writeSkill('enabled-skill')
    const external = join(testHome, 'external-source')
    mkdirSync(external, { recursive: true })
    writeFileSync(join(external, 'SKILL.md'), 'external', 'utf-8')
    let swapped = false
    expect(() => syncChatRoomAgentSkillSnapshot({
      roomId,
      roomAgentId,
      sourceWorkspaceSlug,
      testHooks: {
        beforeRead: (path) => {
          if (swapped || !path.endsWith('SKILL.md')) return
          swapped = true
          renameSync(skillPath, join(testHome, 'moved-source'))
          symlinkSync(external, skillPath, 'dir')
        },
      },
    })).toThrow('Skill 快照源目录发生变化')
  })

  test('Given snapshot next root 在写入前被替换 When 同步 Then fail closed', () => {
    writeSkill('enabled-skill')
    let swapped = false
    expect(() => syncChatRoomAgentSkillSnapshot({
      roomId,
      roomAgentId,
      sourceWorkspaceSlug,
      testHooks: {
        beforeWrite: (path) => {
          if (swapped) return
          swapped = true
          const nextRoot = dirname(path)
          const moved = nextRoot + '-moved'
          renameSync(nextRoot, moved)
          symlinkSync(testHome, nextRoot, 'dir')
        },
      },
    })).toThrow('Skill 快照目标目录发生变化')
  })
})

function dirnameForTest(path: string): string {
  return path.slice(0, path.lastIndexOf('/'))
}
