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
  test('Given 新安装 When 创建默认工作区 Then 初始化同级 project 与 copis 受控目录', () => {
    const defaultSkillsDir = configPaths.getDefaultSkillsDir()
    const officialSkillDir = join(defaultSkillsDir, 'alipay-payment-skill')
    const retiredSkillDir = join(defaultSkillsDir, 'alipay-ai-buyer-agent')
    mkdirSync(officialSkillDir, { recursive: true })
    mkdirSync(retiredSkillDir, { recursive: true })
    writeFileSync(join(officialSkillDir, 'SKILL.md'), '---\nname: alipay-payment-skill\n---\n', 'utf-8')
    writeFileSync(join(retiredSkillDir, 'SKILL.md'), '---\nname: alipay-ai-buyer-agent\n---\n', 'utf-8')

    const workspace = manager.ensureDefaultWorkspace()
    const expectedProjectRootPath = realpathSync(join(tempHome, 'Documents', 'Copis'))

    expect(workspace.name).toBe('默认工作区')
    expect(workspace.projectRootPath).toBe(expectedProjectRootPath)
    expect(workspace.projectPath).toBe(join(expectedProjectRootPath, 'project'))
    expect(existsSync(workspace.projectRootPath!)).toBe(true)
    expect(manager.getAgentWorkspaceWritableRoot(workspace)).toBe(join(expectedProjectRootPath, 'copis'))
    expect(manager.getAgentWorkspaceCopisPath(workspace)).toBe(join(expectedProjectRootPath, 'copis'))
    expect(existsSync(workspace.projectPath!)).toBe(true)
    expect(existsSync(join(configPaths.getWorkspaceSkillsDir('default'), 'alipay-payment-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(configPaths.getWorkspaceSkillsDir('default'), 'alipay-ai-buyer-agent'))).toBe(false)
  })

  test('Given 旧版本默认项目缺少本地根目录 When 启动迁移 Then 补齐同级受控目录配置并将名称迁移为默认工作区', () => {
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
      workspaces: Array<{ id: string; name?: string; projectRootPath?: string; projectPath?: string; allowWorkspaceWrite?: boolean }>
    }

    expect(workspace.id).toBe('legacy-default-id')
    expect(workspace.name).toBe('默认工作区')
    expect(workspace.projectRootPath).toBe(expectedProjectRootPath)
    expect(workspace.projectPath).toBe(join(expectedProjectRootPath, 'project'))
    expect(persisted.workspaces[0]?.name).toBe('默认工作区')
    expect(persisted.workspaces[0]?.projectRootPath).toBe(expectedProjectRootPath)
    expect(persisted.workspaces[0]?.projectPath).toBe(join(expectedProjectRootPath, 'project'))
    expect(persisted.workspaces[0]?.allowWorkspaceWrite).toBeUndefined()
  })

  test('Given 已有默认工作区仍加载旧支付宝买家 Skill When 升级默认 Skills Then 注入官方支付 Skill 并移除旧 Skill', () => {
    const workspace = manager.ensureDefaultWorkspace()
    const defaultSkillsDir = configPaths.getDefaultSkillsDir()
    const officialSkillDir = join(defaultSkillsDir, 'alipay-payment-skill')
    const activeSkillsDir = configPaths.getWorkspaceSkillsDir(workspace.slug)

    mkdirSync(officialSkillDir, { recursive: true })
    writeFileSync(join(officialSkillDir, 'SKILL.md'), '---\nname: alipay-payment-skill\nversion: 0.0.1\n---\n', 'utf-8')
    writeWorkspaceSkill(workspace.slug, 'alipay-ai-buyer-agent', 'alipay-ai-buyer-agent')

    manager.upgradeDefaultSkillsInWorkspaces()

    expect(existsSync(join(activeSkillsDir, 'alipay-payment-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(activeSkillsDir, 'alipay-ai-buyer-agent'))).toBe(false)
  })

  test('Given 默认工作区保留旧版支付宝支付 Skill When 升级默认 Skills Then 覆盖为当前规则', () => {
    const workspace = manager.ensureDefaultWorkspace()
    const defaultSkillsDir = configPaths.getDefaultSkillsDir()
    const officialSkillDir = join(defaultSkillsDir, 'alipay-payment-skill')
    const activeSkillDir = join(configPaths.getWorkspaceSkillsDir(workspace.slug), 'alipay-payment-skill')

    mkdirSync(officialSkillDir, { recursive: true })
    writeFileSync(
      join(officialSkillDir, 'SKILL.md'),
      '---\nname: alipay-payment-skill\nversion: 0.0.6\n---\n由 Rust 自动轮询。\n',
      'utf-8',
    )
    mkdirSync(activeSkillDir, { recursive: true })
    writeFileSync(
      join(activeSkillDir, 'SKILL.md'),
      '---\nname: alipay-payment-skill\nversion: 0.0.1\n---\n旧规则。\n',
      'utf-8',
    )

    manager.upgradeDefaultSkillsInWorkspaces()

    expect(readFileSync(join(activeSkillDir, 'SKILL.md'), 'utf-8')).toContain('由 Rust 自动轮询。')
  })

  test('Given 新安装 When 调用 ensureInvestmentWorkspace Then 创建「我的投资」固定工作区且绑定 Investment 根目录', () => {
    const workspace = manager.ensureInvestmentWorkspace()
    const expectedProjectRootPath = realpathSync(join(tempHome, 'Documents', 'Copis', 'Investment'))

    expect(workspace.name).toBe('我的投资')
    expect(workspace.slug).toBe('investment')
    expect(workspace.projectRootPath).toBe(expectedProjectRootPath)
    expect(workspace.projectPath).toBe(join(expectedProjectRootPath, 'project'))
    expect(existsSync(workspace.projectRootPath!)).toBe(true)
    expect(existsSync(workspace.projectPath!)).toBe(true)
    expect(manager.getAgentWorkspaceWritableRoot(workspace)).toBe(join(expectedProjectRootPath, 'copis'))
  })

  test('Given 「我的投资」工作区 When 尝试删除 Then 抛出系统固定工作区不能删除错误', () => {
    const workspace = manager.ensureInvestmentWorkspace()
    expect(() => manager.deleteAgentWorkspace(workspace.id)).toThrow('系统固定工作区不能删除')
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

  test('Given 本地工作区 When 初始化受控目录 Then project 与 copis 同级可写', () => {
    const projectRootPath = join(tempHome, 'source-project')
    mkdirSync(projectRootPath, { recursive: true })
    const workspace = manager.createAgentWorkspace({ name: '受控项目', projectRootPath })

    const expectedCopisRoot = join(workspace.projectRootPath!, 'copis')
    const expectedProjectRoot = join(workspace.projectRootPath!, 'project')
    expect(manager.getAgentWorkspaceWritableRoot(workspace)).toBe(expectedCopisRoot)
    expect(manager.ensureAgentWorkspaceWritableRoot(workspace)).toBe(expectedCopisRoot)
    expect(existsSync(expectedCopisRoot)).toBe(true)
    expect(existsSync(expectedProjectRoot)).toBe(true)
  })

  test('Given 本地工作区会话 When 初始化浏览器目录 Then 仅创建该会话的 browser 受控目录', () => {
    const projectRootPath = join(tempHome, 'browser-session-project')
    mkdirSync(projectRootPath, { recursive: true })
    const workspace = manager.createAgentWorkspace({ name: '浏览器项目', projectRootPath })
    const browserManager = manager as typeof manager & {
      ensureAgentWorkspaceBrowserSessionPath?: (workspace: { slug: string; projectRootPath?: string }, sessionId: string) => string
    }

    expect(browserManager.ensureAgentWorkspaceBrowserSessionPath).toBeDefined()
    if (!browserManager.ensureAgentWorkspaceBrowserSessionPath) return

    const sessionPath = browserManager.ensureAgentWorkspaceBrowserSessionPath(workspace, 'session-1')

    expect(sessionPath).toBe(join(workspace.projectRootPath!, 'browser', 'agent-workspaces', 'session-1'))
    expect(existsSync(sessionPath)).toBe(true)
    expect(existsSync(join(workspace.projectRootPath!, 'browser', 'agent-workspaces', 'session-2'))).toBe(false)
  })

  test('Given 本地项目根已删除 When 初始化浏览器目录 Then 拒绝且不重建用户目录', () => {
    const projectRootPath = join(tempHome, 'missing-browser-project')
    mkdirSync(projectRootPath, { recursive: true })
    const workspace = manager.createAgentWorkspace({ name: '缺失浏览器项目', projectRootPath })
    rmSync(projectRootPath, { recursive: true, force: true })

    expect(() => manager.ensureAgentWorkspaceBrowserSessionPath(workspace, 'session-1')).toThrow('本地项目根目录不可用')
    expect(existsSync(projectRootPath)).toBe(false)
  })

  test('Given browser 目录是指向项目外的符号链接 When 初始化浏览器目录 Then 拒绝写入外部目录', () => {
    const projectRootPath = join(tempHome, 'browser-symlink-project')
    const outsideRoot = join(tempHome, 'browser-symlink-outside')
    mkdirSync(projectRootPath, { recursive: true })
    mkdirSync(outsideRoot, { recursive: true })
    const workspace = manager.createAgentWorkspace({ name: '浏览器链接项目', projectRootPath })
    symlinkSync(outsideRoot, join(projectRootPath, 'browser'), 'dir')

    expect(() => manager.ensureAgentWorkspaceBrowserSessionPath(workspace, 'session-1')).toThrow('browser 目录不能是符号链接')
    expect(existsSync(join(outsideRoot, 'agent-workspaces', 'session-1'))).toBe(false)
  })

  test('Given 本地项目 When 初始化项目级 Context Then 写入 copis/.context', () => {
    const projectRootPath = join(tempHome, 'readonly-context-project')
    mkdirSync(projectRootPath, { recursive: true })
    const workspace = manager.createAgentWorkspace({ name: 'Context 项目', projectRootPath })

    const contextDir = manager.ensureAgentWorkspaceContextDir(workspace)

    expect(contextDir).toBe(join(workspace.projectRootPath!, 'copis', '.context'))
    expect(contextDir).toBeDefined()
    if (!contextDir) throw new Error('项目级 Context 路径未初始化')
    expect(existsSync(contextDir)).toBe(true)
    expect(existsSync(join(projectRootPath, '.context'))).toBe(false)
  })

  test('Given 本地项目根目录已存在旧 .context 目录 When 确保项目级 Context Then 自动删除根目录下的 .context 且保留 copis/.context', () => {
    const projectRootPath = join(tempHome, 'legacy-root-context-project')
    const legacyRootContext = join(projectRootPath, '.context')
    mkdirSync(legacyRootContext, { recursive: true })
    writeFileSync(join(legacyRootContext, 'old.md'), 'old content', 'utf-8')

    const workspace = manager.createAgentWorkspace({ name: '旧根Context项目', projectRootPath })
    const contextDir = manager.ensureAgentWorkspaceContextDir(workspace)

    expect(contextDir).toBe(join(workspace.projectRootPath!, 'copis', '.context'))
    expect(existsSync(contextDir!)).toBe(true)
    expect(existsSync(legacyRootContext)).toBe(false)
  })

  test('Given 本地项目 When 创建工作区 Then 默认使用同级 project 开发目录', () => {
    const projectRootPath = join(tempHome, 'default-readonly-project')
    mkdirSync(projectRootPath, { recursive: true })
    const workspace = manager.createAgentWorkspace({ name: '默认只读项目', projectRootPath })

    expect(workspace.projectPath).toBe(join(workspace.projectRootPath!, 'project'))
    expect(manager.getAgentWorkspaceWritableRoot(workspace)).toBe(join(workspace.projectRootPath!, 'copis'))
  })

  test('Given Copis 托管工作区 When 创建工作区 Then 在 workspace-files/project 中初始化开发目录', () => {
    const workspace = manager.createAgentWorkspace('托管项目')
    const expectedProjectPath = join(configPaths.getAgentWorkspacePath(workspace.slug), 'workspace-files', 'project')

    expect(workspace.projectPath).toBe(expectedProjectPath)
    expect(manager.ensureAgentWorkspaceWritableRoot(workspace)).toBe(join(configPaths.getAgentWorkspacePath(workspace.slug), 'workspace-files', 'copis'))
    expect(existsSync(expectedProjectPath)).toBe(true)
  })

  test('Given 旧版本地工作区 When 迁移索引 Then 开发目录改为同级 project', () => {
    const projectRootPath = join(tempHome, 'legacy-readonly-project')
    mkdirSync(projectRootPath, { recursive: true })
    const workspace = {
      id: 'legacy-readonly-id',
      name: '旧版只读项目',
      slug: 'legacy-readonly-project',
      projectRootPath,
      allowWorkspaceWrite: false,
      createdAt: 1,
      updatedAt: 1,
    }
    writeFileSync(
      configPaths.getAgentWorkspacesIndexPath(),
      JSON.stringify({ version: 2, workspaces: [workspace] }),
      'utf-8',
    )

    expect(manager.getProjectFilesPath(workspace.slug)).toBe(join(projectRootPath, 'project'))
  })

  test('Given 旧版 copis/project 存在 When 启动更新检查迁移 Then 项目文件物理移动到同级 project', () => {
    const projectRootPath = join(tempHome, 'legacy-physical-project')
    const legacyProjectPath = join(projectRootPath, 'copis', 'project')
    const targetProjectPath = join(projectRootPath, 'project')
    mkdirSync(legacyProjectPath, { recursive: true })
    writeFileSync(join(legacyProjectPath, 'package.json'), '{"scripts":{"dev":"vite"}}', 'utf-8')
    writeFileSync(
      configPaths.getAgentWorkspacesIndexPath(),
      JSON.stringify({
        version: 3,
        workspaces: [{
          id: 'legacy-physical-id',
          name: '旧版物理目录',
          slug: 'legacy-physical-project',
          projectRootPath,
          projectPath: legacyProjectPath,
          createdAt: 1,
          updatedAt: 1,
        }],
      }),
      'utf-8',
    )

    manager.migrateLegacyAgentWorkspaceProjectDirectories()

    expect(existsSync(join(targetProjectPath, 'package.json'))).toBe(true)
    expect(existsSync(legacyProjectPath)).toBe(false)

    // 重复执行不应重新创建或改变已迁移目录。
    manager.migrateLegacyAgentWorkspaceProjectDirectories()
    expect(readFileSync(join(targetProjectPath, 'package.json'), 'utf-8')).toContain('vite')
  })

  test('Given 新 project 已有内容 When 启动物理迁移 Then 保留新旧目录避免覆盖', () => {
    const projectRootPath = join(tempHome, 'legacy-conflict-project')
    const legacyProjectPath = join(projectRootPath, 'copis', 'project')
    const targetProjectPath = join(projectRootPath, 'project')
    mkdirSync(legacyProjectPath, { recursive: true })
    mkdirSync(targetProjectPath, { recursive: true })
    writeFileSync(join(legacyProjectPath, 'legacy.txt'), 'legacy', 'utf-8')
    writeFileSync(join(targetProjectPath, 'current.txt'), 'current', 'utf-8')
    writeFileSync(join(legacyProjectPath, 'conflict.txt'), 'legacy-conflict', 'utf-8')
    writeFileSync(join(targetProjectPath, 'conflict.txt'), 'current-conflict', 'utf-8')
    writeFileSync(
      configPaths.getAgentWorkspacesIndexPath(),
      JSON.stringify({
        version: 3,
        workspaces: [{
          id: 'legacy-conflict-id',
          name: '冲突物理目录',
          slug: 'legacy-conflict-project',
          projectRootPath,
          projectPath: legacyProjectPath,
          createdAt: 1,
          updatedAt: 1,
        }],
      }),
      'utf-8',
    )

    manager.migrateLegacyAgentWorkspaceProjectDirectories()

    expect(existsSync(join(targetProjectPath, 'current.txt'))).toBe(true)
    expect(readFileSync(join(targetProjectPath, 'legacy.txt'), 'utf-8')).toBe('legacy')
    expect(readFileSync(join(targetProjectPath, 'conflict.txt'), 'utf-8')).toBe('current-conflict')
    expect(readFileSync(join(legacyProjectPath, 'conflict.txt'), 'utf-8')).toBe('legacy-conflict')
    expect(existsSync(join(legacyProjectPath, 'legacy.txt'))).toBe(false)
  })

  test('Given 托管工作区存在旧 project When 执行迁移 Then 同样移动到 workspace-files/project', () => {
    const slug = 'managed-legacy-project'
    const sourceRoot = join(tempHome, '.copis', 'agent-workspaces', slug, 'workspace-files')
    const legacyProjectPath = join(sourceRoot, 'copis', 'project')
    const targetProjectPath = join(sourceRoot, 'project')
    mkdirSync(legacyProjectPath, { recursive: true })
    writeFileSync(join(legacyProjectPath, 'index.html'), '<main>legacy</main>', 'utf-8')
    writeFileSync(
      configPaths.getAgentWorkspacesIndexPath(),
      JSON.stringify({
        version: 3,
        workspaces: [{ id: 'managed-legacy-id', name: '托管旧项目', slug, createdAt: 1, updatedAt: 1 }],
      }),
      'utf-8',
    )

    manager.migrateLegacyAgentWorkspaceProjectDirectories()

    expect(readFileSync(join(targetProjectPath, 'index.html'), 'utf-8')).toBe('<main>legacy</main>')
    expect(existsSync(legacyProjectPath)).toBe(false)
    expect(existsSync(join(sourceRoot, 'copis'))).toBe(true)
  })

  test('Given 托管 slug 越过工作区根 When 执行迁移 Then 保留越界目录不做移动', () => {
    const outsideRoot = join(tempHome, '.copis', 'outside-workspace')
    const legacyProjectPath = join(outsideRoot, 'workspace-files', 'copis', 'project')
    mkdirSync(legacyProjectPath, { recursive: true })
    writeFileSync(join(legacyProjectPath, 'outside.txt'), 'outside', 'utf-8')
    writeFileSync(
      configPaths.getAgentWorkspacesIndexPath(),
      JSON.stringify({
        version: 3,
        workspaces: [{ id: 'escape-id', name: '越界项目', slug: '../outside-workspace', createdAt: 1, updatedAt: 1 }],
      }),
      'utf-8',
    )

    manager.migrateLegacyAgentWorkspaceProjectDirectories()

    expect(existsSync(join(legacyProjectPath, 'outside.txt'))).toBe(true)
    expect(existsSync(join(outsideRoot, 'workspace-files', 'project'))).toBe(false)
  })

  test('Given 旧 project 是指向来源根外的符号链接 When 执行迁移 Then 保留链接且不移动外部内容', () => {
    const projectRootPath = join(tempHome, 'symlink-project')
    const outsideRoot = join(tempHome, 'symlink-project-outside')
    const legacyParent = join(projectRootPath, 'copis')
    const legacyProjectPath = join(legacyParent, 'project')
    mkdirSync(legacyParent, { recursive: true })
    mkdirSync(outsideRoot, { recursive: true })
    writeFileSync(join(outsideRoot, 'outside.txt'), 'outside', 'utf-8')
    symlinkSync(outsideRoot, legacyProjectPath, 'dir')
    writeFileSync(
      configPaths.getAgentWorkspacesIndexPath(),
      JSON.stringify({
        version: 3,
        workspaces: [{ id: 'symlink-id', name: '符号链接项目', slug: 'symlink-project', projectRootPath: projectRootPath, createdAt: 1, updatedAt: 1 }],
      }),
      'utf-8',
    )

    manager.migrateLegacyAgentWorkspaceProjectDirectories()

    expect(existsSync(legacyProjectPath)).toBe(true)
    expect(existsSync(join(outsideRoot, 'outside.txt'))).toBe(true)
    expect(existsSync(join(projectRootPath, 'project'))).toBe(false)
  })

  test('Given 工作区根目录与会话目录存在旧 .context When 执行工作区迁移 Then 自动删除根目录下的 .context 并保留会话目录下的 .context', () => {
    const slug = 'context-cleanup-workspace'
    const projectRootPath = join(tempHome, 'context-cleanup-project')
    const rootContext = join(projectRootPath, '.context')
    const sessionDir = join(tempHome, '.copis', 'agent-workspaces', slug, 'session-123')
    const sessionContext = join(sessionDir, '.context')

    mkdirSync(rootContext, { recursive: true })
    mkdirSync(sessionContext, { recursive: true })
    writeFileSync(join(rootContext, 'legacy.md'), 'root', 'utf-8')
    writeFileSync(join(sessionContext, 'todo.md'), 'session', 'utf-8')

    writeFileSync(
      configPaths.getAgentWorkspacesIndexPath(),
      JSON.stringify({
        version: 3,
        workspaces: [{
          id: 'cleanup-id',
          name: '清理上下文测试项目',
          slug,
          projectRootPath,
          createdAt: 1,
          updatedAt: 1,
        }],
      }),
      'utf-8',
    )

    manager.migrateLegacyAgentWorkspaceProjectDirectories()

    expect(existsSync(rootContext)).toBe(false)
    expect(existsSync(sessionContext)).toBe(true)
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
