import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

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
})

function dirnameForTest(path: string): string {
  return path.slice(0, path.lastIndexOf('/'))
}
