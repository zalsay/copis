import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

type AgentWorkspaceManager = typeof import('./agent-workspace-manager')
type ConfigPathsModule = typeof import('./config-paths')

let manager: AgentWorkspaceManager
let configPaths: ConfigPathsModule
let tempHome: string
const originalHome = process.env.HOME
const originalCopisDev = process.env.COPIS_DEV

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: (name?: string) => name === 'documents'
      ? join(process.env.HOME ?? tempHome, 'Documents')
      : join(process.env.HOME ?? tempHome, 'Library', 'Application Support'),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'copis-agent-workspace-manager-'))
  process.env.HOME = tempHome
  process.env.COPIS_DEV = '0'
  configPaths = await import('./config-paths')
  manager = await import('./agent-workspace-manager')
})

beforeEach(() => {
  rmSync(join(tempHome, '.copis'), { recursive: true, force: true })
  mkdirSync(join(tempHome, '.copis'), { recursive: true })
})

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalCopisDev === undefined) {
    delete process.env.COPIS_DEV
  } else {
    process.env.COPIS_DEV = originalCopisDev
  }
  rmSync(tempHome, { recursive: true, force: true })
})

function writeWorkspaceSkill(workspaceSlug: string, skillSlug: string, name: string): void {
  const skillDir = join(configPaths.getWorkspaceSkillsDir(workspaceSlug), skillSlug)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${name}\n---\n`, 'utf-8')
}

describe('Agent 工作区 MCP 配置', () => {
  test('Given 工作区 MCP 包含内置保留名 When 归一化配置 Then 剔除冲突项并保留普通服务器', () => {
    const normalized = manager.normalizeWorkspaceMcpConfig({
      servers: {
        automation: {
          type: 'stdio',
          command: 'custom-automation',
          enabled: true,
        },
        copis_image: {
          type: 'stdio',
          command: 'custom-image',
          enabled: true,
        },
        github: {
          type: 'stdio',
          command: 'github-mcp',
          enabled: true,
        },
      },
    })

    expect(Object.keys(normalized.servers).sort()).toEqual(['github'])
    expect(normalized.servers.github?.command).toBe('github-mcp')
  })
})

describe('项目术语迁移', () => {
  test('Given 新安装 When 创建默认项目 Then 绑定文稿目录并允许 Agent 写入', () => {
    const workspace = manager.ensureDefaultWorkspace()
    const expectedProjectRootPath = realpathSync(join(tempHome, 'Documents', 'Copis'))

    expect(workspace.name).toBe('默认项目')
    expect(workspace.projectRootPath).toBe(expectedProjectRootPath)
    expect(existsSync(workspace.projectRootPath!)).toBe(true)
    expect(workspace.allowWorkspaceWrite).toBe(true)
    expect(manager.getAgentWorkspaceWritableRoot(workspace)).toBe(expectedProjectRootPath)
  })

  test('Given 旧版本默认项目缺少本地根目录 When 启动迁移 Then 补齐默认路径和写入权限', () => {
    const legacyWorkspace = {
      id: 'legacy-default-id',
      name: '默认项目',
      slug: 'default',
      createdAt: 1,
      updatedAt: 1,
    }
    writeFileSync(
      configPaths.getAgentWorkspacesIndexPath(),
      JSON.stringify({ version: 2, workspaces: [legacyWorkspace] }),
      'utf-8',
    )

    const workspace = manager.ensureDefaultWorkspace()
    const expectedProjectRootPath = realpathSync(join(tempHome, 'Documents', 'Copis'))
    const persisted = JSON.parse(readFileSync(configPaths.getAgentWorkspacesIndexPath(), 'utf-8')) as {
      workspaces: Array<{ id: string; projectRootPath?: string; allowWorkspaceWrite?: boolean }>
    }

    expect(workspace.id).toBe('legacy-default-id')
    expect(workspace.projectRootPath).toBe(expectedProjectRootPath)
    expect(workspace.allowWorkspaceWrite).toBe(true)
    expect(persisted.workspaces[0]?.projectRootPath).toBe(expectedProjectRootPath)
    expect(persisted.workspaces[0]?.allowWorkspaceWrite).toBe(true)
  })
})

describe('Agent 工作区创建', () => {
  test('Given workspace 设置了覆盖策略 When 清除 memoryPolicy Then 回退为未设置并继承全局策略', () => {
    const workspace = manager.createAgentWorkspace('Memory UI 项目')

    const overridden = manager.updateAgentWorkspace(workspace.id, { memoryPolicy: 'visible' })
    expect(overridden.memoryPolicy).toBe('visible')

    const inherited = manager.updateAgentWorkspace(workspace.id, { memoryPolicy: null })
    expect(inherited.memoryPolicy).toBeUndefined()

    const persisted = JSON.parse(readFileSync(configPaths.getAgentWorkspacesIndexPath(), 'utf-8')) as {
      workspaces: Array<{ id: string; memoryPolicy?: string }>
    }
    expect(persisted.workspaces.find((item) => item.id === workspace.id)?.memoryPolicy).toBeUndefined()
  })

  test('Given索引中存在未知 Memory policy When读取工作区 Then按继承默认策略处理而不传播非法值', () => {
    const workspace = {
      id: 'policy-workspace',
      name: '策略项目',
      slug: 'policy-project',
      memoryPolicy: 'unknown',
      createdAt: 1,
      updatedAt: 1,
    }
    writeFileSync(
      configPaths.getAgentWorkspacesIndexPath(),
      JSON.stringify({ version: 2, workspaces: [workspace] }),
      'utf-8',
    )

    expect(manager.getAgentWorkspace('policy-workspace')?.memoryPolicy).toBeUndefined()
  })

  test('Given 新工作区 When 解析 Skills 目录 Then 使用标准 .agents/skills 路径', () => {
    const workspace = manager.createAgentWorkspace('标准 Skills 项目')

    expect(configPaths.getWorkspaceSkillsDir(workspace.slug)).toBe(
      join(tempHome, '.copis', 'agent-workspaces', workspace.slug, '.agents', 'skills'),
    )
  })

  test('Given 旧版 skills 目录存在 When 解析 Skills 目录 Then 迁移到 .agents/skills 并保留内容', () => {
    const workspaceRoot = configPaths.getAgentWorkspacePath('legacy-skills')
    const legacySkillDir = join(workspaceRoot, 'skills', 'legacy-skill')
    const legacyInactiveSkillDir = join(workspaceRoot, 'skills-inactive', 'disabled-skill')
    mkdirSync(legacySkillDir, { recursive: true })
    mkdirSync(legacyInactiveSkillDir, { recursive: true })
    writeFileSync(join(legacySkillDir, 'SKILL.md'), '---\nname: legacy-skill\n---\n', 'utf-8')
    writeFileSync(join(legacyInactiveSkillDir, 'SKILL.md'), '---\nname: disabled-skill\n---\n', 'utf-8')

    const skillsDir = configPaths.getWorkspaceSkillsDir('legacy-skills')
    const inactiveSkillsDir = configPaths.getInactiveSkillsDir('legacy-skills')

    expect(skillsDir).toBe(join(workspaceRoot, '.agents', 'skills'))
    expect(existsSync(join(skillsDir, 'legacy-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(inactiveSkillsDir, 'disabled-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(workspaceRoot, 'skills'))).toBe(false)
    expect(existsSync(join(workspaceRoot, 'skills-inactive'))).toBe(false)
  })

  test('Given 创建时未授权写入 When 解析 Agent 写入根 Then 只允许项目下的 copis 目录', () => {
    const projectRootPath = join(tempHome, 'source-project')
    mkdirSync(projectRootPath, { recursive: true })
    const workspace = manager.createAgentWorkspace({
      name: '只读项目',
      projectRootPath,
      allowWorkspaceWrite: false,
    })

    expect(workspace.allowWorkspaceWrite).toBe(false)
    const expectedWritableRoot = join(workspace.projectRootPath!, 'copis')
    expect(manager.getAgentWorkspaceWritableRoot(workspace)).toBe(expectedWritableRoot)
    expect(manager.ensureAgentWorkspaceWritableRoot(workspace)).toBe(expectedWritableRoot)
    expect(existsSync(expectedWritableRoot)).toBe(true)
  })

  test('Given 本地项目不允许直接写入 When 初始化项目级 Context Then 写入 copis/.context', () => {
    const projectRootPath = join(tempHome, 'readonly-context-project')
    mkdirSync(projectRootPath, { recursive: true })
    const workspace = manager.createAgentWorkspace({ name: '只读 Context 项目', projectRootPath, allowWorkspaceWrite: false })

    const contextDir = manager.ensureAgentWorkspaceContextDir(workspace)

    expect(contextDir).toBe(join(workspace.projectRootPath!, 'copis', '.context'))
    expect(contextDir).toBeDefined()
    if (!contextDir) throw new Error('项目级 Context 路径未初始化')
    expect(existsSync(contextDir)).toBe(true)
    expect(existsSync(join(projectRootPath, '.context'))).toBe(false)
  })

  test('Given 本地项目未传写入选项 When 创建工作区 Then 默认使用 copis 受控写入目录', () => {
    const projectRootPath = join(tempHome, 'default-readonly-project')
    mkdirSync(projectRootPath, { recursive: true })
    const workspace = manager.createAgentWorkspace({ name: '默认只读项目', projectRootPath })

    expect(workspace.allowWorkspaceWrite).toBe(false)
    expect(manager.getAgentWorkspaceWritableRoot(workspace)).toBe(join(workspace.projectRootPath!, 'copis'))
  })

  test('Given 项目名称是 Windows 保留设备名 When 创建工作区 Then slug 避免直接使用保留名', () => {
    const workspace = manager.createAgentWorkspace('CON')

    expect(workspace.slug).toBe('workspace-con')
    expect(existsSync(configPaths.getAgentWorkspacePath(workspace.slug))).toBe(true)
  })

  test('Given 只有一个普通工作区 When 删除工作区 Then 允许项目列表为空', () => {
    const workspace = manager.createAgentWorkspace('唯一项目')

    manager.deleteAgentWorkspace(workspace.id)

    expect(manager.listAgentWorkspaces()).toEqual([])
  })

  test('Given 默认 Skill 包含 blocklist 目录 When 创建工作区 Then 初始化 Skills 时跳过高风险目录', () => {
    const defaultSkillDir = join(configPaths.getDefaultSkillsDir(), 'sample-skill')
    mkdirSync(join(defaultSkillDir, '.git', 'objects'), { recursive: true })
    mkdirSync(join(defaultSkillDir, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(defaultSkillDir, 'SKILL.md'), '---\nname: Sample\n---\n', 'utf-8')
    writeFileSync(join(defaultSkillDir, '.git', 'objects', 'locked'), 'skip', 'utf-8')
    writeFileSync(join(defaultSkillDir, 'node_modules', 'pkg', 'index.js'), 'skip', 'utf-8')

    const workspace = manager.createAgentWorkspace('Filtered Copy')
    const copiedSkillDir = join(configPaths.getWorkspaceSkillsDir(workspace.slug), 'sample-skill')

    expect(existsSync(join(copiedSkillDir, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(copiedSkillDir, '.git'))).toBe(false)
    expect(existsSync(join(copiedSkillDir, 'node_modules'))).toBe(false)
  })
})

describe('Agent 工作区 Skill 扫描', () => {
  test('Given Skills 目录包含 broken symlink When 获取工作区 Skills Then 跳过坏条目并继续扫描后续 Skill', () => {
    const workspaceSlug = 'workspace-a'
    const skillsDir = configPaths.getWorkspaceSkillsDir(workspaceSlug)

    writeWorkspaceSkill(workspaceSlug, 'alpha', 'Alpha')
    symlinkSync(join(skillsDir, 'missing-target'), join(skillsDir, 'broken-link'), 'dir')
    writeWorkspaceSkill(workspaceSlug, 'zeta', 'Zeta')

    for (let i = 0; i < 20; i++) {
      const entryNames = readdirSync(skillsDir)
      const brokenIndex = entryNames.indexOf('broken-link')
      const hasSkillAfterBroken = entryNames.slice(brokenIndex + 1).some((name) => name !== 'missing-target')
      if (brokenIndex !== -1 && hasSkillAfterBroken) break
      writeWorkspaceSkill(workspaceSlug, `tail-${i}`, `Tail ${i}`)
    }

    const finalEntryNames = readdirSync(skillsDir)
    const finalBrokenIndex = finalEntryNames.indexOf('broken-link')
    expect(finalBrokenIndex).not.toBe(-1)
    expect(finalEntryNames.slice(finalBrokenIndex + 1).some((name) => name !== 'missing-target')).toBe(true)

    const expectedSlugs = finalEntryNames
      .filter((name) => name !== 'broken-link')
      .sort()
    const skills = manager.getWorkspaceSkills(workspaceSlug)

    expect(skills.map((skill) => skill.slug).sort()).toEqual(expectedSlugs)
  })
})
