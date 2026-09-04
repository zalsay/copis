/**
 * Agent 工作区管理器
 *
 * 负责 Agent 工作区的 CRUD 操作。
 * - 工作区索引：~/.copis/agent-workspaces.json（轻量元数据）
 * - 工作区目录：~/.copis/agent-workspaces/{slug}/（Agent 的 cwd）
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, cpSync, mkdirSync, statSync, lstatSync, openSync, readSync, closeSync, realpathSync, accessSync, constants, renameSync, rmdirSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { rmSyncWithRetry, renameWithRetry } from './fs-retry'
import { writeJsonFileAtomic, readJsonFileSafe } from './safe-file'
import { randomUUID } from 'node:crypto'
import { join, resolve, relative, isAbsolute, dirname, basename, sep } from 'node:path'
import {
  getAgentWorkspacesIndexPath,
  getAgentWorkspacesDir,
  getAgentWorkspacePath,
  getDefaultProjectRootPath,
  getWorkspaceMcpPath,
  getWorkspaceSkillsDir,
  getWorkspaceFilesDir,
  resolveWorkspaceFilesDir,
  getInactiveSkillsDir,
  getDefaultSkillsDir,
  parseSkillVersion,
  DEFAULT_SKILL_SLUG_ALIASES,
  migrateLegacySkillSlugDirectory,
  RETIRED_DEFAULT_SKILL_SLUGS,
  isRetiredDefaultSkill,
} from './config-paths'
import { findAllGitRoots, normalizeGitRoot } from './git-diff-service'
import { listBuiltinMcpServers } from './builtin-mcp/catalog'
import { RESERVED_BUILTIN_KEYS } from './builtin-mcp/baseline'
import { inferMcpTransportType, normalizeMcpTransportType, normalizeOptionalMemoryPolicy } from '@copis/shared'
import type { AgentWorkspace, CreateAgentWorkspaceInput, LocalProjectRootStatus, MemoryPolicy, UpdateAgentWorkspaceInput, WorkspaceMcpConfig, SkillMeta, SkillImportSource, SkillMarketSource, OtherWorkspaceSkillsGroup, WorkspaceCapabilities, SkillFileNode, SkillFileContent } from '@copis/shared'
import { filterAttachedPaths, requireAttachedPath } from './attached-paths'

interface AgentWorkspacesIndex {
  version: number
  workspaces: AgentWorkspace[]
}

const INDEX_VERSION = 3
const WINDOWS_RESERVED_SLUGS = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
])

/** 读取工作区索引文件，自动执行版本迁移 */
function readIndex(): AgentWorkspacesIndex {
  const indexPath = getAgentWorkspacesIndexPath()
  const data = readJsonFileSafe<AgentWorkspacesIndex>(indexPath)

  if (data) {
    // 版本迁移
    if ((data.version ?? 1) < INDEX_VERSION) {
      migrateIndex(data)
    }
    return {
      ...data,
      workspaces: data.workspaces.map((workspace) => {
        const { memoryPolicy: rawMemoryPolicy, allowWorkspaceWrite: _legacyAllowWorkspaceWrite, ...rest } = workspace
        const memoryPolicy = normalizeOptionalMemoryPolicy(rawMemoryPolicy)
        return {
          ...rest,
          ...(memoryPolicy ? { memoryPolicy } : {}),
        }
      }),
    }
  }

  return { version: INDEX_VERSION, workspaces: [] }
}

function migrateIndex(index: AgentWorkspacesIndex): void {
  const oldVersion = index.version ?? 1

  // v1 → v2: 为所有工作区默认启用 skill-creator
  if (oldVersion < 2) {
    activateSkillCreatorInAllWorkspaces(index)
  }

  // v2 → v3: 项目来源目录始终只读，受控写入目录改为同级 copis/ 与 project/。
  if (oldVersion < 3) {
    const workspacesRoot = resolve(getAgentWorkspacesDir())
    for (const workspace of index.workspaces) {
      const sourceRoot = workspace.projectRootPath
        ? resolve(workspace.projectRootPath)
        : resolve(resolveWorkspaceFilesDir(workspace.slug))
      if (!workspace.projectRootPath && !isPathWithin(workspacesRoot, sourceRoot)) {
        console.warn(`[Agent 工作区] 索引迁移跳过越界托管工作区: ${workspace.slug}`)
        delete workspace.allowWorkspaceWrite
        continue
      }
      workspace.projectPath = join(sourceRoot, COPIS_PROJECT_DIR)
      delete workspace.allowWorkspaceWrite
    }
  }

  index.version = INDEX_VERSION
  writeIndex(index)
  console.log(`[Agent 工作区] 索引已迁移: v${oldVersion} → v${INDEX_VERSION}`)
}

/** v1→v2 迁移：将 .agents/skills-inactive/skill-creator 移到 .agents/skills/ */
function activateSkillCreatorInAllWorkspaces(index: AgentWorkspacesIndex): void {
  for (const workspace of index.workspaces) {
    const activeDir = getWorkspaceSkillsDir(workspace.slug)
    const inactiveDir = getInactiveSkillsDir(workspace.slug)

    const inactivePath = join(inactiveDir, 'skill-creator')
    const activePath = join(activeDir, 'skill-creator')

    if (existsSync(activePath) || !existsSync(inactivePath)) continue

    try {
      if (!existsSync(activeDir)) {
        mkdirSync(activeDir, { recursive: true })
      }
      renameWithRetry(inactivePath, activePath)
      console.log(`[Agent 工作区] 已为 ${workspace.slug} 启用 skill-creator`)
    } catch (err) {
      console.warn(`[Agent 工作区] 启用 skill-creator 失败 (${workspace.slug}):`, err)
    }
  }
}

function writeIndex(index: AgentWorkspacesIndex): void {
  const indexPath = getAgentWorkspacesIndexPath()

  try {
    writeJsonFileAtomic(indexPath, index)
  } catch (error) {
    console.error('[Agent 工作区] 写入索引文件失败:', error)
    throw new Error('写入项目配置索引失败')
  }
}

/** 名称转 URL-safe slug，非 ASCII 名称 fallback 为 workspace-{timestamp} */
function slugify(name: string, existingSlugs: Set<string>): string {
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

  if (!base) {
    base = `workspace-${Date.now()}`
  }
  if (WINDOWS_RESERVED_SLUGS.has(base)) {
    base = `workspace-${base}`
  }

  let slug = base
  let counter = 1
  while (existingSlugs.has(slug)) {
    slug = `${base}-${counter}`
    counter++
  }

  return slug
}

/** 返回索引中的存储顺序（与 UI 拖拽顺序一致）；返回副本，避免调用方 sort 等操作误改索引数组 */

export function listAgentWorkspaces(): AgentWorkspace[] {
  const index = readIndex()
  return index.workspaces.map(withProjectRootStatus)
}

/** 按 updatedAt 降序（桥接/飞书列表等与旧版内联 sort 一致；渲染进程仍用 listAgentWorkspaces） */
export function listAgentWorkspacesByUpdatedAt(): AgentWorkspace[] {
  const index = readIndex()
  return index.workspaces.map(withProjectRootStatus).sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 同步检查用户选择的本地项目根。该状态用于运行前硬阻断和工作区列表提示，
 * 不依赖目录 watcher，避免把临时监听失败误报为项目根丢失。
 */
export function getLocalProjectRootStatus(projectRootPath: string | undefined): LocalProjectRootStatus | undefined {
  if (!projectRootPath) return undefined
  if (!existsSync(projectRootPath)) return 'missing'

  try {
    if (!statSync(projectRootPath).isDirectory()) return 'not_directory'
    accessSync(projectRootPath, constants.R_OK | constants.X_OK)
    return 'available'
  } catch {
    return 'unavailable'
  }
}

/** 为 IPC/展示调用附加即时状态，绝不修改磁盘索引中的工作区记录。 */
function withProjectRootStatus(workspace: AgentWorkspace): AgentWorkspace {
  const projectRootStatus = getLocalProjectRootStatus(workspace.projectRootPath)
  return projectRootStatus ? { ...workspace, projectRootStatus } : { ...workspace }
}

/** 按指定 ID 顺序重排工作区，未列出的追加到末尾 */
export function reorderAgentWorkspaces(orderedIds: string[]): AgentWorkspace[] {
  const index = readIndex()
  const byId = new Map(index.workspaces.map((w) => [w.id, w]))
  const reordered: AgentWorkspace[] = []
  for (const id of orderedIds) {
    const ws = byId.get(id)
    if (ws) {
      reordered.push(ws)
      byId.delete(id)
    }
  }
  for (const ws of byId.values()) reordered.push(ws)
  index.workspaces = reordered
  writeIndex(index)
  return reordered
}

export function getAgentWorkspace(id: string): AgentWorkspace | undefined {
  const index = readIndex()
  return index.workspaces.find((w) => w.id === id)
}

/** 按 slug 查找项目，供项目文件根解析使用。 */
export function getAgentWorkspaceBySlug(slug: string): AgentWorkspace | undefined {
  const index = readIndex()
  return index.workspaces.find((w) => w.slug === slug)
}

/**
 * 工作区来源根：本地项目是用户选择的目录，托管项目是 workspace-files/。
 * 来源根用于读取已有文件；用户新建的小项目统一放在其下的 project/。
 */
export function getAgentWorkspaceSourceRoot(
  workspace: Pick<AgentWorkspace, 'slug' | 'projectRootPath'>,
): string {
  return workspace.projectRootPath ?? getWorkspaceFilesDir(workspace.slug)
}

/** 返回工作区来源根与项目根，供读取授权使用。 */
export function getAgentWorkspaceReadableRoots(
  workspace: Pick<AgentWorkspace, 'slug' | 'projectRootPath' | 'projectPath'>,
): string[] {
  const sourceRoot = getAgentWorkspaceSourceRoot(workspace)
  const projectPath = getAgentWorkspaceProjectPath(workspace)
  return sourceRoot === projectPath ? [projectPath] : [projectPath, sourceRoot]
}

/** 工作区内用户项目的固定目录名称。 */
export const COPIS_PROJECT_DIR = 'project'

/**
 * 返回工作区内用户项目的开发根。
 *
 * - 本地工作区：来源根/project/
 * - 托管工作区：workspace-files/project/
 */
export function getAgentWorkspaceProjectPath(
  workspace: Pick<AgentWorkspace, 'slug' | 'projectRootPath' | 'projectPath'>,
): string {
  if (workspace.projectPath) return resolve(workspace.projectPath)
  if (workspace.projectRootPath) {
    return join(resolve(workspace.projectRootPath), COPIS_PROJECT_DIR)
  }
  return join(getWorkspaceFilesDir(workspace.slug), COPIS_PROJECT_DIR)
}

/** 返回工作区项目开发根；兼容只传 slug 的历史调用。 */
export function getProjectFilesPath(workspaceSlug: string): string {
  const workspace = getAgentWorkspaceBySlug(workspaceSlug)
  return workspace
    ? getAgentWorkspaceProjectPath(workspace)
    : join(getWorkspaceFilesDir(workspaceSlug), COPIS_PROJECT_DIR)
}

/**
 * 返回工作区受控 AGENTS.md 路径。
 * Copis 专家团队托管区块只写入该文件（~/.copis/agent-workspaces/<slug>/），
 * 不写入用户本地项目根目录，避免项目根指令文件绕过 Copis 权限边界。
 */
export function getAgentWorkspaceAgentsPath(workspaceSlug: string): string {
  return join(getAgentWorkspacePath(workspaceSlug), 'AGENTS.md')
}

/** 工作区内由 Copis 管理的受控目录名称。 */
export const COPIS_WORKSPACE_WRITE_DIR = 'copis'
const BROWSER_WORKSPACE_DIR = 'browser'
const BROWSER_AGENT_WORKSPACES_DIR = 'agent-workspaces'
const BROWSER_WORKFLOWS_DIR = 'browser-workflows'

/** 返回工作区内 Copis 可写目录。 */
export function getAgentWorkspaceCopisPath(
  workspace: Pick<AgentWorkspace, 'slug' | 'projectRootPath'>,
): string {
  return join(getAgentWorkspaceSourceRoot(workspace), COPIS_WORKSPACE_WRITE_DIR)
}

/** 返回用户工作区中的浏览器受控目录。 */
export function getAgentWorkspaceBrowserPath(
  workspace: Pick<AgentWorkspace, 'slug' | 'projectRootPath'>,
): string {
  return join(getAgentWorkspaceSourceRoot(workspace), BROWSER_WORKSPACE_DIR)
}

/** 返回指定 Agent 会话的浏览器文件目录。 */
export function getAgentWorkspaceBrowserSessionPath(
  workspace: Pick<AgentWorkspace, 'slug' | 'projectRootPath'>,
  sessionId: string,
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('Agent 会话 ID 不合法')
  return join(getAgentWorkspaceBrowserPath(workspace), BROWSER_AGENT_WORKSPACES_DIR, sessionId)
}

/** 确保指定 Agent 会话的浏览器文件目录存在。 */
export function ensureAgentWorkspaceBrowserSessionPath(
  workspace: Pick<AgentWorkspace, 'slug' | 'projectRootPath'>,
  sessionId: string,
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('Agent 会话 ID 不合法')
  return ensureSafeBrowserDirectory(workspace, [
    BROWSER_WORKSPACE_DIR,
    BROWSER_AGENT_WORKSPACES_DIR,
    sessionId,
  ])
}

/** 返回工作区中已批准浏览器 Workflow 的主存储目录。 */
export function getAgentWorkspaceBrowserWorkflowsDir(
  workspace: Pick<AgentWorkspace, 'slug' | 'projectRootPath'>,
): string {
  return ensureSafeBrowserDirectory(workspace, [BROWSER_WORKSPACE_DIR, BROWSER_WORKFLOWS_DIR])
}

/** 在仍可用的工作区来源根下创建浏览器目录，拒绝路径中的符号链接。 */
function ensureSafeBrowserDirectory(
  workspace: Pick<AgentWorkspace, 'slug' | 'projectRootPath'>,
  segments: string[],
): string {
  if (workspace.projectRootPath) {
    const status = getLocalProjectRootStatus(workspace.projectRootPath)
    if (status !== 'available') throw new Error(`本地项目根目录不可用：${workspace.projectRootPath}`)
  }

  const sourceRoot = resolve(getAgentWorkspaceSourceRoot(workspace))
  if (isSymlinkEntry(sourceRoot) || !isDirectoryEntry(sourceRoot)) {
    throw new Error(`工作区来源根目录不可用：${sourceRoot}`)
  }
  const sourceRootReal = realpathSync(sourceRoot)
  let current = sourceRootReal
  for (const segment of segments) {
    current = join(current, segment)
    if (isSymlinkEntry(current)) throw new Error(`browser 目录不能是符号链接：${current}`)
    if (existsSync(current)) {
      if (!isDirectoryEntry(current)) throw new Error(`browser 目录不是文件夹：${current}`)
    } else {
      mkdirSync(current)
    }
    const currentReal = realpathSync(current)
    if (!isPathWithin(sourceRootReal, currentReal)) {
      throw new Error(`browser 目录不能指向工作区来源根之外：${current}`)
    }
    current = currentReal
  }
  return current
}

/**
 * 返回工作区允许 Agent 写入的根目录。
 *
 * 项目来源根始终只读，Agent 仅能写入来源根下同级的 project/ 与 copis/。
 */
export function getAgentWorkspaceWritableRoot(
  workspace: Pick<AgentWorkspace, 'slug' | 'projectRootPath' | 'projectPath'>,
): string {
  return getAgentWorkspaceCopisPath(workspace)
}

/** 确保工作区项目开发根与 Copis 受控目录存在，并返回 Copis 受控目录路径。 */
export function ensureAgentWorkspaceWritableRoot(
  workspace: Pick<AgentWorkspace, 'slug' | 'projectRootPath' | 'projectPath'>,
): string {
  const projectRoot = resolve(getAgentWorkspaceSourceRoot(workspace))
  const writableRoot = getAgentWorkspaceWritableRoot(workspace)
  const copisRoot = getAgentWorkspaceCopisPath(workspace)
  mkdirSync(writableRoot, { recursive: true })
  mkdirSync(copisRoot, { recursive: true })
  const projectPath = getAgentWorkspaceProjectPath(workspace)
  mkdirSync(projectPath, { recursive: true })
  const projectRootReal = realpathSync(resolve(projectRoot))
  const writableRootReal = realpathSync(resolve(writableRoot))
  const relativeWritableRoot = relative(projectRootReal, writableRootReal)
  if (
    relativeWritableRoot === '..'
    || relativeWritableRoot.startsWith(`..${sep}`)
    || isAbsolute(relativeWritableRoot)
  ) {
    throw new Error(`Copis 项目写入目录不能指向工作区来源根之外: ${writableRoot}`)
  }
  return writableRoot
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(resolve(rootPath), resolve(candidatePath))
  return relativePath === '' || (
    relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
  )
}

function isSymlinkEntry(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function isDirectoryEntry(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

function removeEmptyDirectory(path: string, workspaceLabel: string): void {
  try {
    // 使用 rmdirSync 的非递归语义，避免检查后有新文件写入时误删内容。
    rmdirSync(path)
  } catch (error) {
    console.warn(`[Agent 工作区] 清理空旧项目目录失败，保留原目录 (${workspaceLabel}): ${path}`, error)
  }
}

/** 递归合并旧项目目录，目标冲突条目保留双方。 */
function mergeLegacyProjectDirectory(
  sourcePath: string,
  targetPath: string,
  sourceRootReal: string,
  workspaceLabel: string,
): void {
  for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
    const sourceEntry = join(sourcePath, entry.name)
    const targetEntry = join(targetPath, entry.name)
    if (!isPathWithin(sourceRootReal, sourceEntry) || !isPathWithin(sourceRootReal, targetEntry)) {
      console.warn(`[Agent 工作区] 旧项目条目越过来源根，保留原位置 (${workspaceLabel}): ${sourceEntry}`)
      continue
    }

    const sourceIsSymlink = isSymlinkEntry(sourceEntry)
    const targetExists = existsSync(targetEntry) || isSymlinkEntry(targetEntry)
    if (!targetExists) {
      try {
        // 符号链接只移动链接本身，避免跨边界解析或复制其目标。
        if (sourceIsSymlink) renameSync(sourceEntry, targetEntry)
        else renameWithRetry(sourceEntry, targetEntry)
      } catch (error) {
        console.warn(`[Agent 工作区] 迁移旧项目条目失败，保留原文件 (${workspaceLabel}): ${sourceEntry}`, error)
      }
      continue
    }

    // 同名文件、符号链接或类型冲突均不覆盖任何一方。
    if (sourceIsSymlink || isSymlinkEntry(targetEntry) || !entry.isDirectory() || !isDirectoryEntry(targetEntry)) {
      continue
    }

    mergeLegacyProjectDirectory(sourceEntry, targetEntry, sourceRootReal, workspaceLabel)
    try {
      if (readdirSync(sourceEntry).length === 0) {
        removeEmptyDirectory(sourceEntry, workspaceLabel)
      }
    } catch (error) {
      console.warn(`[Agent 工作区] 清理已合并的旧项目目录失败 (${workspaceLabel}): ${sourceEntry}`, error)
    }
  }
}

/** 将单个工作区的旧 copis/project 迁移到来源根下的 project。 */
function migrateLegacyProjectDirectory(sourceRoot: string, workspaceLabel: string): void {
  if (!existsSync(sourceRoot) || !isDirectoryEntry(sourceRoot)) return

  let sourceRootReal: string
  try {
    sourceRootReal = realpathSync(sourceRoot)
  } catch (error) {
    console.warn(`[Agent 工作区] 无法解析迁移来源根，跳过 (${workspaceLabel}):`, error)
    return
  }

  // 统一使用来源根的真实路径，避免 macOS /var -> /private 等别名造成误判。
  const legacyProjectPath = resolve(sourceRootReal, COPIS_WORKSPACE_WRITE_DIR, COPIS_PROJECT_DIR)
  const projectPath = resolve(sourceRootReal, COPIS_PROJECT_DIR)
  if (!isPathWithin(sourceRootReal, legacyProjectPath) || !isPathWithin(sourceRootReal, projectPath)) {
    console.warn(`[Agent 工作区] 旧项目迁移路径越过来源根，跳过 (${workspaceLabel})`)
    return
  }
  if (!existsSync(legacyProjectPath)) return
  if (isSymlinkEntry(legacyProjectPath) || !isDirectoryEntry(legacyProjectPath)) {
    console.warn(`[Agent 工作区] 旧项目目录不是普通目录，跳过 (${workspaceLabel}): ${legacyProjectPath}`)
    return
  }

  try {
    const legacyProjectReal = realpathSync(legacyProjectPath)
    if (!isPathWithin(sourceRootReal, legacyProjectReal)) {
      console.warn(`[Agent 工作区] 旧项目目录指向来源根外部，跳过 (${workspaceLabel}): ${legacyProjectPath}`)
      return
    }
  } catch (error) {
    console.warn(`[Agent 工作区] 无法解析旧项目目录，跳过 (${workspaceLabel}):`, error)
    return
  }

  const projectExists = existsSync(projectPath) || isSymlinkEntry(projectPath)
  if (!projectExists) {
    try {
      renameWithRetry(legacyProjectPath, projectPath)
      console.log(`[Agent 工作区] 已迁移旧项目目录 (${workspaceLabel}): ${legacyProjectPath} → ${projectPath}`)
    } catch (error) {
      console.warn(`[Agent 工作区] 迁移旧项目目录失败，保留旧目录 (${workspaceLabel}):`, error)
    }
    return
  }

  if (isSymlinkEntry(projectPath) || !isDirectoryEntry(projectPath)) {
    console.warn(`[Agent 工作区] 新项目路径存在冲突，保留双方并跳过迁移 (${workspaceLabel}): ${projectPath}`)
    return
  }

  try {
    mergeLegacyProjectDirectory(legacyProjectPath, projectPath, sourceRootReal, workspaceLabel)
    // 只删除已经完全迁空的旧项目目录，不触碰 copis 根或其余条目。
    if (readdirSync(legacyProjectPath).length === 0) {
      removeEmptyDirectory(legacyProjectPath, workspaceLabel)
    }
  } catch (error) {
    console.warn(`[Agent 工作区] 合并旧项目目录失败，保留未迁移内容 (${workspaceLabel}):`, error)
  }
}

/**
 * 清理根目录直接残留的旧版 .context 目录（长期上下文统一位于 copis/.context）。
 */
function removeLegacyRootContextDirectory(sourceRoot: string, workspaceLabel: string): void {
  const legacyContextPath = resolve(sourceRoot, '.context')
  if (existsSync(legacyContextPath)) {
    try {
      rmSyncWithRetry(legacyContextPath, { recursive: true, force: true })
      console.log(`[Agent 工作区] 已清理根目录残留的 .context 目录 (${workspaceLabel}): ${legacyContextPath}`)
    } catch (error) {
      console.warn(`[Agent 工作区] 清理根目录 .context 失败 (${workspaceLabel}):`, error)
    }
  }
}

/**
 * 在每次更新检查及应用启动时幂等迁移所有工作区的旧 project 目录与根目录残留 .context。
 * 迁移自身吞掉错误，调用方即使遇到文件系统竞态也必须继续更新检查。
 */
export function migrateLegacyAgentWorkspaceProjectDirectories(): void {
  let workspaces: AgentWorkspace[]
  try {
    workspaces = readIndex().workspaces
  } catch (error) {
    console.warn('[Agent 工作区] 读取索引失败，跳过旧项目迁移:', error)
    return
  }

  let workspacesRoot: string
  try {
    workspacesRoot = realpathSync(resolve(getAgentWorkspacesDir()))
  } catch (error) {
    console.warn('[Agent 工作区] 无法解析工作区根，跳过旧项目迁移:', error)
    return
  }

  for (const workspace of workspaces) {
    try {
      const sourceRootPath = workspace.projectRootPath
        ? resolve(workspace.projectRootPath)
        : resolve(resolveWorkspaceFilesDir(workspace.slug))
      let sourceRoot = sourceRootPath
      try {
        sourceRoot = realpathSync(sourceRootPath)
      } catch {
        // 来源根尚不存在时保留词法路径，后续迁移函数会直接跳过。
      }

      // 托管工作区的 slug 来自索引文件，必须拒绝 ../ 等路径逃逸。
      if (!workspace.projectRootPath && !isPathWithin(workspacesRoot, sourceRoot)) {
        console.warn(`[Agent 工作区] 托管工作区来源根越界，跳过 (${workspace.slug}): ${sourceRoot}`)
        continue
      }
      migrateLegacyProjectDirectory(sourceRoot, workspace.slug)
      removeLegacyRootContextDirectory(sourceRoot, workspace.slug)
      if (workspace.projectPath) {
        removeLegacyRootContextDirectory(workspace.projectPath, workspace.slug)
      }
    } catch (error) {
      console.warn(`[Agent 工作区] 旧项目迁移失败，继续处理更新 (${workspace.slug}):`, error)
    }
  }
}

/** 返回工作区项目级 Context 目录；只读项目使用受控写入根，避免修改原始目录。 */
export function getAgentWorkspaceContextDir(
  workspace: Pick<AgentWorkspace, 'slug' | 'projectRootPath' | 'projectPath'>,
): string {
  return join(getAgentWorkspaceWritableRoot(workspace), '.context')
}

/** 确保工作区项目级 Context 存在；项目根不可用时跳过，避免意外重建本地项目。 */
export function ensureAgentWorkspaceContextDir(
  workspace: Pick<AgentWorkspace, 'slug' | 'projectRootPath' | 'projectPath'>,
): string | undefined {
  if (workspace.projectRootPath && getLocalProjectRootStatus(workspace.projectRootPath) !== 'available') {
    return undefined
  }

  // 兼容性清理：根目录直接存在的 .context 属于旧版残留，需自动清理（长期上下文位于 copis/.context）
  if (workspace.projectRootPath) {
    removeLegacyRootContextDirectory(workspace.projectRootPath, workspace.slug)
  }
  if (workspace.projectPath) {
    removeLegacyRootContextDirectory(workspace.projectPath, workspace.slug)
  }

  const contextDir = getAgentWorkspaceContextDir(workspace)
  ensureAgentWorkspaceWritableRoot(workspace)
  mkdirSync(contextDir, { recursive: true })
  return contextDir
}

/** 将 ~/.copis/default-skills/ 的内容逐个复制到工作区 .agents/skills/ 目录 */
function copyDefaultSkills(workspaceSlug: string, options: { throwOnError?: boolean } = {}): void {
  const defaultDir = getDefaultSkillsDir()
  const targetDir = getWorkspaceSkillsDir(workspaceSlug)

  try {
    const entries = readdirSync(defaultDir, { withFileTypes: true })
    if (entries.length === 0) {
      console.warn(`[Agent 工作区] 默认 Skills 模板为空，工作区 Skills 未初始化: ${workspaceSlug}`)
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || isRetiredDefaultSkill(entry.name)) continue
      const source = join(defaultDir, entry.name)
      const target = join(targetDir, entry.name)
      try {
        cpSync(source, target, { recursive: true, filter: skillCopyFilter })
      } catch (err) {
        console.warn(`[Agent 工作区] 复制默认 Skill 失败 (${workspaceSlug}/${entry.name}):`, err)
        if (options.throwOnError) throw err
      }
    }
    console.log(`[Agent 工作区] 已复制默认 Skills 到: ${workspaceSlug}`)
  } catch (err) {
    console.error(`[Agent 工作区] 复制默认 Skills 失败 (${workspaceSlug}):`, err)
    if (options.throwOnError) throw err
  }
}

export function createAgentWorkspace(input: string | CreateAgentWorkspaceInput): AgentWorkspace {
  const { name, projectRootPath, memoryPolicy } = typeof input === 'string'
    ? { name: input, projectRootPath: undefined, memoryPolicy: undefined }
    : input
  const index = readIndex()

  const duplicate = index.workspaces.find((w) => w.name === name)
  if (duplicate) {
    throw new Error(`项目名称「${name}」已存在`)
  }

  const existingSlugs = new Set(index.workspaces.map((w) => w.slug))
  const slug = slugify(name, existingSlugs)
  const now = Date.now()
  let normalizedProjectRootPath: string | undefined

  if (projectRootPath) {
    try {
      normalizedProjectRootPath = realpathSync(resolve(projectRootPath))
      if (!statSync(normalizedProjectRootPath).isDirectory()) {
        throw new Error('选择的路径不是文件夹')
      }
      if (getLocalProjectRootStatus(normalizedProjectRootPath) !== 'available') {
        throw new Error('选择的文件夹不可访问')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法访问选择的文件夹'
      throw new Error(`项目文件夹无效: ${message}`)
    }
  }

  const sourceRoot = normalizedProjectRootPath ?? getWorkspaceFilesDir(slug)
  const projectPath = join(sourceRoot, COPIS_PROJECT_DIR)
  const workspace: AgentWorkspace = {
    id: randomUUID(),
    name,
    slug,
    projectRootPath: normalizedProjectRootPath,
    projectPath,
    ...(memoryPolicy !== undefined ? { memoryPolicy } : {}),
    createdAt: now,
    updatedAt: now,
  }

  try {
    getAgentWorkspacePath(slug)
    copyDefaultSkills(slug, { throwOnError: true })
    ensureAgentWorkspaceWritableRoot(workspace)
  } catch (error) {
    const workspacesRoot = resolve(getAgentWorkspacesDir())
    const workspaceDir = resolve(join(workspacesRoot, slug))
    const relativePath = relative(workspacesRoot, workspaceDir)
    if (relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath) && existsSync(workspaceDir)) {
      try {
        rmSyncWithRetry(workspaceDir, { recursive: true, force: true })
      } catch (cleanupError) {
        console.warn(`[Agent 工作区] 创建失败后清理目录失败 (${slug}):`, cleanupError)
      }
    }
    console.error(`[Agent 工作区] 创建工作区失败 (${name}, slug: ${slug}):`, error)
    throw new Error(`创建项目失败: ${(error as Error)?.message ?? '初始化项目目录失败'}`)
  }

  index.workspaces.unshift(workspace)
  writeIndex(index)

  console.log(`[Agent 工作区] 已创建工作区: ${name} (slug: ${slug})`)
  return workspace
}

/** 更新工作区名称（slug 和目录不变） */
export function updateAgentWorkspace(
  id: string,
  updates: UpdateAgentWorkspaceInput,
): AgentWorkspace {
  const index = readIndex()
  const idx = index.workspaces.findIndex((w) => w.id === id)

  if (idx === -1) {
    throw new Error(`项目不存在: ${id}`)
  }

  const existing = index.workspaces[idx]!

  if (updates.name === undefined && updates.memoryPolicy === undefined) {
    throw new Error('至少提供一个需要更新的工作区字段')
  }

  const name = updates.name?.trim() || existing.name
  const duplicate = index.workspaces.find((w) => w.id !== id && w.name === name)
  if (duplicate) {
    throw new Error(`项目名称「${name}」已存在`)
  }

  const { memoryPolicy: _existingMemoryPolicy, ...existingWithoutMemoryPolicy } = existing
  const updated: AgentWorkspace = {
    ...existingWithoutMemoryPolicy,
    name,
    ...(updates.memoryPolicy !== undefined && updates.memoryPolicy !== null ? { memoryPolicy: updates.memoryPolicy } : {}),
    updatedAt: Date.now(),
  }

  index.workspaces[idx] = updated
  writeIndex(index)

  console.log(`[Agent 工作区] 已更新工作区: ${updated.name} (${updated.id})`)
  return withProjectRootStatus(updated)
}

/** 将本地项目重新关联到一个已有文件夹，保留项目、会话与配置。 */
export function relinkAgentWorkspaceProjectRoot(id: string, projectRootPath: string): AgentWorkspace {
  const index = readIndex()
  const idx = index.workspaces.findIndex((workspace) => workspace.id === id)
  if (idx === -1) throw new Error(`项目不存在: ${id}`)

  let normalizedProjectRootPath: string
  try {
    normalizedProjectRootPath = realpathSync(resolve(projectRootPath))
    if (!statSync(normalizedProjectRootPath).isDirectory()) {
      throw new Error('选择的路径不是文件夹')
    }
    if (getLocalProjectRootStatus(normalizedProjectRootPath) !== 'available') {
      throw new Error('选择的文件夹不可访问')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '无法访问选择的文件夹'
    throw new Error(`项目文件夹无效: ${message}`)
  }

  const updated: AgentWorkspace = {
    ...index.workspaces[idx]!,
    projectRootPath: normalizedProjectRootPath,
    projectPath: join(normalizedProjectRootPath, COPIS_PROJECT_DIR),
    updatedAt: Date.now(),
  }
  index.workspaces[idx] = updated
  writeIndex(index)
  mkdirSync(getAgentWorkspaceWritableRoot(updated), { recursive: true })
  mkdirSync(getAgentWorkspaceProjectPath(updated), { recursive: true })
  console.log(`[Agent 工作区] 已重新关联项目根: ${updated.name} → ${normalizedProjectRootPath}`)
  return withProjectRootStatus(updated)
}

/** 在本地项目原路径恢复一个空目录。仅允许路径确实缺失时执行。 */
export function restoreAgentWorkspaceProjectRoot(id: string): AgentWorkspace {
  const index = readIndex()
  const idx = index.workspaces.findIndex((workspace) => workspace.id === id)
  if (idx === -1) throw new Error(`项目不存在: ${id}`)

  const workspace = index.workspaces[idx]!
  if (!workspace.projectRootPath) throw new Error('该项目不是本地项目')
  const status = getLocalProjectRootStatus(workspace.projectRootPath)
  if (status !== 'missing') {
    throw new Error('只能恢复已缺失的本地项目根目录')
  }

  mkdirSync(workspace.projectRootPath, { recursive: true })
  console.log(`[Agent 工作区] 已在原路径恢复空项目根: ${workspace.projectRootPath}`)
  return withProjectRootStatus(workspace)
}

/** 删除工作区索引条目及其本地目录 */
export function deleteAgentWorkspace(id: string): void {
  const index = readIndex()
  const idx = index.workspaces.findIndex((w) => w.id === id)

  if (idx === -1) {
    throw new Error(`项目不存在: ${id}`)
  }

  const target = index.workspaces[idx]!
  if (target.slug === 'default' || target.slug === 'investment') {
    throw new Error('系统固定工作区不能删除')
  }

  const workspacesRoot = resolve(getAgentWorkspacesDir())
  const workspaceDir = resolve(join(workspacesRoot, target.slug))
  const relativePath = relative(workspacesRoot, workspaceDir)
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`项目配置目录路径异常，已跳过删除: ${workspaceDir}`)
  }

  // 先移除索引条目并落盘，再删目录：
  // 即使随后 rmSync 失败，也只会残留一个无引用目录（无害，可被同 slug 重建覆盖），
  // 而不会留下指向已删目录的孤儿索引条目导致 UI 状态不一致
  const removed = index.workspaces.splice(idx, 1)[0]!
  writeIndex(index)

  if (existsSync(workspaceDir)) {
    try {
      rmSyncWithRetry(workspaceDir, { recursive: true, force: true })
      console.log(`[Agent 工作区] 已删除工作区目录: ${workspaceDir}`)
    } catch (error) {
      console.warn(`[Agent 工作区] 删除工作区目录失败，已残留无引用目录 (${target.slug}):`, error)
    }
  }

  console.log(`[Agent 工作区] 已删除工作区: ${removed.name} (slug: ${removed.slug})`)
}

export const INVESTMENT_WORKSPACE_SLUG = 'investment'

/** 确保默认工作区的本地根目录存在且可读取。 */
function ensureDefaultProjectRootPath(): string {
  const projectRootPath = getDefaultProjectRootPath()
  mkdirSync(projectRootPath, { recursive: true })

  const status = getLocalProjectRootStatus(projectRootPath)
  if (status !== 'available') {
    throw new Error(`默认工作区目录不可用: ${projectRootPath}（${status ?? 'unknown'}）`)
  }

  return realpathSync(resolve(projectRootPath))
}

/** 确保「我的投资」工作区的本地根目录存在且可读取。 */
function ensureInvestmentProjectRootPath(): string {
  const baseRoot = getDefaultProjectRootPath()
  const projectRootPath = join(baseRoot, 'Investment')
  mkdirSync(projectRootPath, { recursive: true })

  const status = getLocalProjectRootStatus(projectRootPath)
  if (status !== 'available') {
    return realpathSync(resolve(baseRoot))
  }

  return realpathSync(resolve(projectRootPath))
}

/** 确保默认工作区存在，首次启动时自动创建（slug: default）。 */
export function ensureDefaultWorkspace(): AgentWorkspace {
  const index = readIndex()
  let defaultWs = index.workspaces.find((w) => w.slug === 'default')

  if (!defaultWs) {
    const now = Date.now()
    const projectRootPath = ensureDefaultProjectRootPath()
    defaultWs = {
      id: randomUUID(),
      name: '默认工作区',
      slug: 'default',
      projectRootPath,
      projectPath: join(projectRootPath, COPIS_PROJECT_DIR),
      createdAt: now,
      updatedAt: now,
    }

    getAgentWorkspacePath('default')
    copyDefaultSkills('default')
    ensureAgentWorkspaceWritableRoot(defaultWs)

    index.workspaces.push(defaultWs)
    writeIndex(index)

    console.log('[Agent 工作区] 已创建默认工作区')
  } else {
    let needsWrite = false

    if (defaultWs.name === '默认项目') {
      defaultWs.name = '默认工作区'
      needsWrite = true
    }

    // 旧版本默认工作区没有本地项目根，迁移到用户文稿下的 Copis 目录。
    // 已经重新关联过其他目录的用户配置保持不变。
    if (!defaultWs.projectRootPath) {
      defaultWs.projectRootPath = ensureDefaultProjectRootPath()
      defaultWs.projectPath = join(defaultWs.projectRootPath, COPIS_PROJECT_DIR)
      needsWrite = true
    }

    if (!defaultWs.projectPath) {
      defaultWs.projectPath = join(defaultWs.projectRootPath, COPIS_PROJECT_DIR)
      needsWrite = true
    }

    ensureAgentWorkspaceWritableRoot(defaultWs)

    if (needsWrite) {
      defaultWs.updatedAt = Date.now()
      writeIndex(index)
      console.log(`[Agent 工作区] 已迁移默认工作区: ${defaultWs.projectRootPath}`)
    }
  }

  return defaultWs
}

/** 确保「我的投资」固定工作区存在（slug: investment），用于承载基金股市/金融投研全部会话。 */
export function ensureInvestmentWorkspace(): AgentWorkspace {
  const index = readIndex()
  let investmentWs = index.workspaces.find(
    (w) => w.slug === INVESTMENT_WORKSPACE_SLUG || w.name === '我的投资'
  )

  if (!investmentWs) {
    const now = Date.now()
    const projectRootPath = ensureInvestmentProjectRootPath()
    investmentWs = {
      id: randomUUID(),
      name: '我的投资',
      slug: INVESTMENT_WORKSPACE_SLUG,
      projectRootPath,
      projectPath: join(projectRootPath, COPIS_PROJECT_DIR),
      createdAt: now,
      updatedAt: now,
    }

    getAgentWorkspacePath(INVESTMENT_WORKSPACE_SLUG)
    copyDefaultSkills(INVESTMENT_WORKSPACE_SLUG)
    ensureAgentWorkspaceWritableRoot(investmentWs)

    index.workspaces.push(investmentWs)
    writeIndex(index)

    console.log('[Agent 工作区] 已创建「我的投资」固定工作区')
  } else {
    let needsWrite = false

    if (investmentWs.name !== '我的投资') {
      investmentWs.name = '我的投资'
      needsWrite = true
    }

    if (investmentWs.slug !== INVESTMENT_WORKSPACE_SLUG) {
      investmentWs.slug = INVESTMENT_WORKSPACE_SLUG
      needsWrite = true
    }

    if (!investmentWs.projectRootPath) {
      investmentWs.projectRootPath = ensureInvestmentProjectRootPath()
      investmentWs.projectPath = join(investmentWs.projectRootPath, COPIS_PROJECT_DIR)
      needsWrite = true
    }

    if (!investmentWs.projectPath) {
      investmentWs.projectPath = join(investmentWs.projectRootPath, COPIS_PROJECT_DIR)
      needsWrite = true
    }

    ensureAgentWorkspaceWritableRoot(investmentWs)

    if (needsWrite) {
      investmentWs.updatedAt = Date.now()
      writeIndex(index)
      console.log(`[Agent 工作区] 已更新「我的投资」工作区: ${investmentWs.projectRootPath}`)
    }
  }

  return investmentWs
}

// ===== 默认 Skills 自动升级 =====

/** 从单个工作区的 active 与 inactive 目录清理已退役的内置 Skills。 */
function removeRetiredDefaultSkillsFromWorkspace(workspace: AgentWorkspace): void {
  const skillDirs = [
    { state: 'active', path: getWorkspaceSkillsDir(workspace.slug) },
    { state: 'inactive', path: getInactiveSkillsDir(workspace.slug) },
  ]

  for (const skillDir of skillDirs) {
    for (const slug of RETIRED_DEFAULT_SKILL_SLUGS) {
      const targetPath = join(skillDir.path, slug)
      if (!existsSync(targetPath)) continue

      try {
        rmSyncWithRetry(targetPath, { recursive: true, force: true })
        console.log(`[Agent 工作区] 已移除退役默认 Skill: ${workspace.slug}/${slug} (${skillDir.state})`)
      } catch (err) {
        console.warn(`[Agent 工作区] 移除退役默认 Skill 失败 (${workspace.slug}/${slug}, ${skillDir.state}):`, err)
      }
    }
  }
}

/** 将已有工作区中的第一方默认 Skill 旧 slug 迁移到当前 slug。 */
function migrateLegacyDefaultSkillSlugsInWorkspace(workspace: AgentWorkspace): void {
  const skillDirs = [getWorkspaceSkillsDir(workspace.slug), getInactiveSkillsDir(workspace.slug)]
  for (const skillDir of skillDirs) {
    for (const alias of DEFAULT_SKILL_SLUG_ALIASES) {
      migrateLegacySkillSlugDirectory(skillDir, alias.legacy, alias.canonical)
    }
  }
}

/**
 * 同步默认 Skills 到所有工作区。规则：
 * - 缺失：注入到 .agents/skills/（active），让升级后新增的内置 Skill 对老用户立即可用
 * - 已存在（active 或 inactive）：比较 SKILL.md 的 version，bundled 更新时才覆盖
 *   （保留用户停用决定 — 在 inactive 的依然在 inactive；同时避免每次启动
 *    全量 cpSync 4MB+ 文件阻塞主进程）
 */
export function upgradeDefaultSkillsInWorkspaces(): void {
  const defaultDir = getDefaultSkillsDir()

  interface DefaultSkillInfo {
    version: string
    sourcePath: string
  }
  const defaultSkills = new Map<string, DefaultSkillInfo>()

  try {
    const entries = readdirSync(defaultDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || isRetiredDefaultSkill(entry.name)) continue
      const sourcePath = join(defaultDir, entry.name)
      defaultSkills.set(entry.name, {
        version: parseSkillVersion(sourcePath),
        sourcePath,
      })
    }
  } catch {
    return
  }

  const index = readIndex()

  for (const workspace of index.workspaces) {
    migrateLegacyDefaultSkillSlugsInWorkspace(workspace)
    removeRetiredDefaultSkillsFromWorkspace(workspace)
    if (defaultSkills.size === 0) continue

    const activeDir = getWorkspaceSkillsDir(workspace.slug)
    const inactiveDir = getInactiveSkillsDir(workspace.slug)

    for (const [slug, info] of defaultSkills) {
      const activePath = join(activeDir, slug)
      const inactivePath = join(inactiveDir, slug)

      if (existsSync(activePath)) {
        const currentVer = parseSkillVersion(activePath)
        if (compareSemver(info.version, currentVer) > 0) {
          if (safeReplaceSkillDir(info.sourcePath, activePath)) {
            console.log(
              `[Agent 工作区] 已升级默认 Skill: ${workspace.slug}/${slug} (active, ${currentVer} → ${info.version})`,
            )
          } else {
            console.warn(
              `[Agent 工作区] 升级默认 Skill 失败 (${workspace.slug}/${slug}, active)，跳过`,
            )
          }
        }
        continue
      }

      if (existsSync(inactivePath)) {
        const currentVer = parseSkillVersion(inactivePath)
        if (compareSemver(info.version, currentVer) > 0) {
          if (safeReplaceSkillDir(info.sourcePath, inactivePath)) {
            console.log(
              `[Agent 工作区] 已升级默认 Skill: ${workspace.slug}/${slug} (inactive, ${currentVer} → ${info.version})`,
            )
          } else {
            console.warn(
              `[Agent 工作区] 升级默认 Skill 失败 (${workspace.slug}/${slug}, inactive)，跳过`,
            )
          }
        }
        continue
      }

      try {
        if (!existsSync(activeDir)) mkdirSync(activeDir, { recursive: true })
        cpSync(info.sourcePath, activePath, { recursive: true, filter: skillCopyFilter })
        console.log(`[Agent 工作区] 已注入新默认 Skill: ${workspace.slug}/${slug} → active`)
      } catch (err) {
        console.warn(`[Agent 工作区] 注入默认 Skill 失败 (${workspace.slug}/${slug}):`, err)
      }
    }
  }
}

/**
 * 安全替换一个 skill 目录：先 rmSync 再 cpSync，每步独立 try/catch。
 *
 * 直接 cpSync({ force: true }) 在目标存在只读文件（如 .git/objects/ 下的 0444
 * 文件）时会因 EACCES 失败；rmSync({ force: true }) 不依赖目标文件的写权限，
 * 仅需父目录可写即可 unlink。这种"先删后拷"也修正了 cpSync 的合并语义——
 * bundle 已删除的文件能从用户目录中真正消失。
 *
 * @returns 成功返回 true；任何步骤失败返回 false（已记录日志，不抛出）
 */
function safeReplaceSkillDir(sourcePath: string, targetPath: string): boolean {
  try {
    rmSyncWithRetry(targetPath, { recursive: true, force: true })
    cpSync(sourcePath, targetPath, { recursive: true, filter: skillCopyFilter })
    return true
  } catch (err) {
    console.warn(`[Agent 工作区] safeReplaceSkillDir 失败 (${targetPath}):`, err)
    return false
  }
}

/** 防御性目录基名集合：复制 skill 时永远跳过这些目录，避免 .git 0444 文件、
 *  node_modules 文件爆炸等场景把启动期同步链路炸掉。 */
const SKILL_COPY_BLOCKLIST = new Set([
  '.git',
  '.DS_Store',
  'node_modules',
  'dist',
  '.next',
  '.cache',
  '.turbo',
  '__pycache__',
])

export function skillCopyFilter(src: string): boolean {
  return !SKILL_COPY_BLOCKLIST.has(basename(src))
}

/** 比较两个 semver 版本字符串，返回值 >0 表示 a 更新 */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

// ===== MCP 配置管理 =====

export function normalizeWorkspaceMcpConfig(config: Partial<WorkspaceMcpConfig>): WorkspaceMcpConfig {
  const servers: WorkspaceMcpConfig['servers'] = {}
  const rawServers = config.servers ?? {}

  for (const [name, rawEntry] of Object.entries(rawServers)) {
    if (!rawEntry || typeof rawEntry !== 'object') continue
    if (RESERVED_BUILTIN_KEYS.has(name)) {
      console.warn(`[Agent 工作区] MCP 服务器 "${name}" 与内置 MCP 保留名冲突，已忽略（内置 MCP 不写入 mcp.json）`)
      continue
    }

    const entryRecord = { ...(rawEntry as unknown as Record<string, unknown>) }
    const entry = entryRecord as unknown as WorkspaceMcpConfig['servers'][string] & { type?: unknown }
    const normalizedType = normalizeMcpTransportType(entry.type)

    if (normalizedType) {
      if (entry.type !== normalizedType) {
        console.log(`[Agent 工作区] MCP 服务器 "${name}" 的 type "${String(entry.type)}" 已规范化为 "${normalizedType}"`)
      }
      entry.type = normalizedType
    } else if (!entry.type) {
      entry.type = inferMcpTransportType(entry)
      console.log(`[Agent 工作区] MCP 服务器 "${name}" 缺少 type 字段，已自动推断为 "${entry.type}"`)
    }

    servers[name] = entry as WorkspaceMcpConfig['servers'][string]
  }

  return { servers }
}

export function getWorkspaceMcpConfig(workspaceSlug: string): WorkspaceMcpConfig {
  const mcpPath = getWorkspaceMcpPath(workspaceSlug)

  if (!existsSync(mcpPath)) {
    return { servers: {} }
  }

  try {
    const raw = readFileSync(mcpPath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<WorkspaceMcpConfig>
    return normalizeWorkspaceMcpConfig(parsed)
  } catch (error) {
    console.error('[Agent 工作区] 读取 MCP 配置失败:', error)
    return { servers: {} }
  }
}

export function saveWorkspaceMcpConfig(workspaceSlug: string, config: WorkspaceMcpConfig): void {
  const mcpPath = getWorkspaceMcpPath(workspaceSlug)

  try {
    writeFileSync(mcpPath, JSON.stringify(normalizeWorkspaceMcpConfig(config), null, 2), 'utf-8')
    console.log(`[Agent 工作区] 已保存 MCP 配置: ${workspaceSlug}`)
  } catch (error) {
    console.error('[Agent 工作区] 保存 MCP 配置失败:', error)
    throw new Error('保存 MCP 配置失败')
  }
}

// ===== Skill 目录扫描 =====

/** 扫描工作区活跃 Skills，仅返回 .agents/skills/ 下的 Skill */
export function getWorkspaceSkills(workspaceSlug: string): SkillMeta[] {
  return scanSkillsInDir(getWorkspaceSkillsDir(workspaceSlug), true)
}

/** 解析 SKILL.md 的 YAML frontmatter，支持单行值、block scalar（`|` / `>`）和多行缩进 */
function parseSkillFrontmatter(content: string, slug: string, enabled: boolean): SkillMeta {
  const meta: SkillMeta = { slug, name: slug, enabled }

  // 移除 UTF-8 BOM（﻿），确保 YAML frontmatter 匹配不受 BOM 干扰
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1)

  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!fmMatch) return meta

  const yaml = fmMatch[1]
  if (!yaml) return meta

  const validKeys = new Set(['name', 'displayName', 'description', 'group', 'icon', 'version', 'category'])
  const entries: Record<string, string> = {}
  let currentKey = ''
  let isFolded = false

  for (const line of yaml.split('\n')) {
    const indented = /^\s/.test(line)

    if (!indented) {
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) { currentKey = ''; continue }

      const key = line.slice(0, colonIdx).trim()
      const raw = line.slice(colonIdx + 1).trim()

      if (!validKeys.has(key)) { currentKey = ''; isFolded = false; continue }

      if (raw === '|' || raw === '>') {
        currentKey = key
        isFolded = raw === '>'
        entries[key] = ''
        continue
      }

      currentKey = key
      isFolded = false
      entries[key] = raw.replace(/^["']|["']$/g, '')
    } else if (currentKey) {
      const text = line.trim()
      if (!text) { if (entries[currentKey]) entries[currentKey] += '\n'; continue }
      const sep = isFolded ? ' ' : '\n'
      entries[currentKey] = entries[currentKey] ? entries[currentKey] + sep + text : text
    }
  }

  if (entries.name) meta.name = entries.name.trim()
  if (entries.displayName) meta.displayName = entries.displayName.trim()
  if (entries.description) meta.description = entries.description.trim()
  if (entries.group) meta.group = entries.group.trim()
  if (entries.icon) meta.icon = entries.icon.trim()
  if (entries.version) meta.version = entries.version.trim()
  if (entries.category) meta.category = entries.category.trim()

  return meta
}

// ===== 工作区能力摘要 =====

export function getWorkspaceCapabilities(workspaceSlug: string): WorkspaceCapabilities {
  const mcpConfig = getWorkspaceMcpConfig(workspaceSlug)
  const skills = getWorkspaceSkills(workspaceSlug)
  const builtinMcpServers = listBuiltinMcpServers({ workspaceSlug })

  const mcpServers = Object.entries(mcpConfig.servers ?? {}).map(([name, entry]) => ({
    name,
    enabled: entry.enabled,
    type: entry.type,
  }))

  return { mcpServers, builtinMcpServers, skills }
}

export function deleteWorkspaceSkill(workspaceSlug: string, skillSlug: string): void {
  const skillsDir = getWorkspaceSkillsDir(workspaceSlug)
  const skillPath = join(skillsDir, skillSlug)

  if (!existsSync(skillPath)) {
    throw new Error(`Skill 不存在: ${skillSlug}`)
  }

  rmSyncWithRetry(skillPath, { recursive: true, force: true })
  console.log(`[Agent 工作区] 已删除 Skill: ${workspaceSlug}/${skillSlug}`)
}

/** 扫描指定目录下的 Skills，供 getWorkspaceSkills 和 getAllWorkspaceSkills 复用 */
function isSkillDirectoryEntry(dir: string, entry: Dirent): boolean {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false

  try {
    return statSync(join(dir, entry.name)).isDirectory()
  } catch {
    return false
  }
}

function scanSkillsInDir(dir: string, enabled: boolean): SkillMeta[] {
  const skills: SkillMeta[] = []

  try {
    const entries = readdirSync(dir, { withFileTypes: true })

    for (const entry of entries) {
      if (!isSkillDirectoryEntry(dir, entry)) continue

      const skillMdPath = join(dir, entry.name, 'SKILL.md')
      if (!existsSync(skillMdPath)) continue

      try {
        const content = readFileSync(skillMdPath, 'utf-8')
        const meta = parseSkillFrontmatter(content, entry.name, enabled)

        // 如果是导入的 Skill，读取来源信息并检测更新
        const importSource = readSkillImportSource(join(dir, entry.name))
        if (importSource) {
          meta.importSource = importSource
          const sourceSkillDir = resolveSkillDir(importSource.sourceWorkspaceSlug, entry.name)
          if (sourceSkillDir) {
            const currentSourceVersion = parseSkillVersion(sourceSkillDir)
            meta.hasUpdate = isNewerVersion(currentSourceVersion, importSource.sourceVersion)
          }
        }

        const marketSource = readSkillMarketSource(join(dir, entry.name))
        if (marketSource) meta.marketSource = marketSource

        skills.push(meta)
      } catch {
        console.warn(`[Agent 工作区] 解析 Skill 失败: ${entry.name}`)
      }
    }
  } catch {
    // 目录可能不存在
  }

  return skills
}

/** 获取默认 Skills 的 slug 列表（来自 ~/.copis/default-skills/） */
export function getDefaultSkillSlugs(): string[] {
  const dir = getDefaultSkillsDir()
  if (!existsSync(dir)) return []

  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !isRetiredDefaultSkill(entry.name))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/** 获取工作区所有 Skills（含活跃和不活跃），用于设置页 UI */
export function getAllWorkspaceSkills(workspaceSlug: string): SkillMeta[] {
  const activeSkills = scanSkillsInDir(getWorkspaceSkillsDir(workspaceSlug), true)
  const inactiveSkills = scanSkillsInDir(getInactiveSkillsDir(workspaceSlug), false)
  return [...activeSkills, ...inactiveSkills]
}

/** 在 .agents/skills/ 和 .agents/skills-inactive/ 之间移动来切换启用/禁用 */
export function toggleWorkspaceSkill(workspaceSlug: string, skillSlug: string, enabled: boolean): void {
  const activeDir = getWorkspaceSkillsDir(workspaceSlug)
  const inactiveDir = getInactiveSkillsDir(workspaceSlug)

  const srcDir = enabled ? inactiveDir : activeDir
  const destDir = enabled ? activeDir : inactiveDir

  const srcPath = join(srcDir, skillSlug)
  const destPath = join(destDir, skillSlug)

  if (!existsSync(srcPath)) {
    throw new Error(`Skill 不存在: ${skillSlug}`)
  }

  if (existsSync(destPath)) {
    throw new Error(`目标目录已存在同名 Skill: ${skillSlug}`)
  }

  renameWithRetry(srcPath, destPath)
  console.log(`[Agent 工作区] Skill ${enabled ? '启用' : '禁用'}: ${workspaceSlug}/${skillSlug}`)
}

/**
 * 获取其他工作区的 Skill 列表，按工作区分组返回。
 */
export function getOtherWorkspaceSkills(currentSlug: string): OtherWorkspaceSkillsGroup[] {
  const workspaces = listAgentWorkspaces()
  const result: OtherWorkspaceSkillsGroup[] = []

  for (const workspace of workspaces) {
    if (workspace.slug === currentSlug) continue

    const skills = getAllWorkspaceSkills(workspace.slug)
    if (skills.length === 0) continue

    result.push({
      workspaceName: workspace.name,
      workspaceSlug: workspace.slug,
      skills,
    })
  }

  return result
}

/**
 * 从其他工作区导入 Skill 到当前工作区。
 *
 * 复制目录并记录来源元数据（.source.json），支持后续版本检测和同步更新。
 */
export function importSkillFromWorkspace(
  targetSlug: string,
  sourceSlug: string,
  skillSlug: string,
): SkillMeta {
  const sourcePath = resolveSkillDir(sourceSlug, skillSlug)

  if (!sourcePath) {
    throw new Error(`来源项目中不存在 Skill: ${skillSlug}`)
  }

  // P0 修复：复制前校验源 SKILL.md 存在，避免产生孤立目录
  const sourceSkillMdPath = join(sourcePath, 'SKILL.md')
  if (!existsSync(sourceSkillMdPath)) {
    throw new Error(`源 Skill 缺少 SKILL.md: ${skillSlug}`)
  }

  const targetPath = join(getWorkspaceSkillsDir(targetSlug), skillSlug)
  const targetInactivePath = join(getInactiveSkillsDir(targetSlug), skillSlug)

  if (existsSync(targetPath) || existsSync(targetInactivePath)) {
    throw new Error(`当前项目已存在同名 Skill: ${skillSlug}`)
  }

  cpSync(sourcePath, targetPath, { recursive: true })

  // 写入来源元数据
  const sourceWorkspace = listAgentWorkspaces().find((w) => w.slug === sourceSlug)
  const importSource: SkillImportSource = {
    sourceWorkspaceSlug: sourceSlug,
    sourceWorkspaceName: sourceWorkspace?.name ?? sourceSlug,
    importedAt: new Date().toISOString(),
    sourceVersion: parseSkillVersion(sourcePath),
  }
  writeSkillImportSource(targetPath, importSource)

  console.log(`[Agent 工作区] 已从 ${sourceSlug} 导入 Skill: ${targetSlug}/${skillSlug}`)

  const content = readFileSync(join(targetPath, 'SKILL.md'), 'utf-8')
  const meta = parseSkillFrontmatter(content, skillSlug, true)
  meta.importSource = importSource
  return meta
}

/**
 * 从源工作区同步更新已导入的 Skill（覆盖更新）。
 *
 * - 源不存在：抛出错误，不修改目标
 * - 本地已禁用（.agents/skills-inactive）：在 inactive 目录中原地更新，保留 enabled 状态
 */
export function updateSkillFromSource(
  targetSlug: string,
  skillSlug: string,
): SkillMeta {
  const activeDir = getWorkspaceSkillsDir(targetSlug)
  const inactiveDir = getInactiveSkillsDir(targetSlug)

  const targetPath = existsSync(join(activeDir, skillSlug))
    ? join(activeDir, skillSlug)
    : existsSync(join(inactiveDir, skillSlug))
      ? join(inactiveDir, skillSlug)
      : null

  if (!targetPath) {
    throw new Error(`当前项目中不存在 Skill: ${skillSlug}`)
  }

  const existingSource = readSkillImportSource(targetPath)
  if (!existingSource) {
    throw new Error(`Skill ${skillSlug} 不是从其他项目导入的，无法从源更新`)
  }

  const sourcePath = resolveSkillDir(existingSource.sourceWorkspaceSlug, skillSlug)
  if (!sourcePath) {
    throw new Error(`来源项目中不再存在 Skill: ${skillSlug}（来源: ${existingSource.sourceWorkspaceName}）`)
  }

  if (!existsSync(join(sourcePath, 'SKILL.md'))) {
    throw new Error(`源 Skill 缺少 SKILL.md: ${skillSlug}`)
  }

  // 先复制到临时目录，成功后再替换旧目录，确保原子性
  const parentDir = join(targetPath, '..')
  const tmpPath = join(parentDir, `.${skillSlug}.updating`)
  try {
    cpSync(sourcePath, tmpPath, { recursive: true })
  } catch (err) {
    // 复制失败时清理临时目录，保留原目录不变
    if (existsSync(tmpPath)) rmSyncWithRetry(tmpPath, { recursive: true, force: true })
    throw err
  }
  rmSyncWithRetry(targetPath, { recursive: true, force: true })
  renameWithRetry(tmpPath, targetPath)

  // 更新来源元数据（保留原始 importedAt）
  const sourceWorkspace = listAgentWorkspaces().find((w) => w.slug === existingSource.sourceWorkspaceSlug)
  const updatedSource: SkillImportSource = {
    sourceWorkspaceSlug: existingSource.sourceWorkspaceSlug,
    sourceWorkspaceName: sourceWorkspace?.name ?? existingSource.sourceWorkspaceName,
    importedAt: existingSource.importedAt,
    sourceVersion: parseSkillVersion(sourcePath),
  }
  writeSkillImportSource(targetPath, updatedSource)

  const enabled = targetPath === join(activeDir, skillSlug)
  const content = readFileSync(join(targetPath, 'SKILL.md'), 'utf-8')
  const meta = parseSkillFrontmatter(content, skillSlug, enabled)
  meta.importSource = updatedSource
  meta.hasUpdate = false

  console.log(`[Agent 工作区] 已从源更新 Skill: ${targetSlug}/${skillSlug}`)
  return meta
}

// ===== Skill 来源追踪 helpers =====

const SOURCE_META_FILE = '.source.json'
export const MARKET_SOURCE_META_FILE = '.market.json'

function readSkillImportSource(skillDir: string): SkillImportSource | undefined {
  const p = join(skillDir, SOURCE_META_FILE)
  if (!existsSync(p)) return undefined
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as SkillImportSource
  } catch {
    return undefined
  }
}

function writeSkillImportSource(skillDir: string, source: SkillImportSource): void {
  writeFileSync(join(skillDir, SOURCE_META_FILE), JSON.stringify(source, null, 2), 'utf-8')
}

/** 读取市场安装标记；标记损坏时按普通本地 Skill 处理，避免阻塞整个工作区加载。 */
export function readSkillMarketSource(skillDir: string): SkillMarketSource | undefined {
  const filePath = join(skillDir, MARKET_SOURCE_META_FILE)
  if (!existsSync(filePath)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf-8'))
    if (!parsed || typeof parsed !== 'object') return undefined
    const value = parsed as Record<string, unknown>
    const id = value.id
    if ((typeof id !== 'string' && typeof id !== 'number') || !String(id).trim()) return undefined
    const slug = typeof value.slug === 'string' ? value.slug.trim() : ''
    const version = typeof value.version === 'string' ? value.version.trim() : ''
    const sourceProvider = typeof value.sourceProvider === 'string' ? value.sourceProvider.trim() : ''
    const installedAt = typeof value.installedAt === 'string' ? value.installedAt.trim() : ''
    if (!slug || !version || !sourceProvider || !installedAt) return undefined
    return { id, slug, version, sourceProvider, installedAt }
  } catch {
    return undefined
  }
}

/** 写入市场来源标记，供市场安装服务在原子替换后记录来源。 */
export function writeSkillMarketSource(skillDir: string, source: SkillMarketSource): void {
  writeFileSync(join(skillDir, MARKET_SOURCE_META_FILE), `${JSON.stringify(source, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
}

/** 解析 Skill 所在目录（active 或 inactive），不存在则返回 null */
function resolveSkillDir(workspaceSlug: string, skillSlug: string): string | null {
  const active = join(getWorkspaceSkillsDir(workspaceSlug), skillSlug)
  if (existsSync(active)) return active
  const inactive = join(getInactiveSkillsDir(workspaceSlug), skillSlug)
  if (existsSync(inactive)) return inactive
  return null
}

export function readWorkspaceSkillContent(workspaceSlug: string, skillSlug: string): string {
  const dir = resolveSkillDir(workspaceSlug, skillSlug)
  if (!dir) throw new Error(`Skill 不存在: ${workspaceSlug}/${skillSlug}`)
  const mdPath = join(dir, 'SKILL.md')
  if (!existsSync(mdPath)) throw new Error(`SKILL.md 不存在: ${mdPath}`)
  return readFileSync(mdPath, 'utf-8')
}

export function writeWorkspaceSkillContent(workspaceSlug: string, skillSlug: string, content: string): void {
  const dir = resolveSkillDir(workspaceSlug, skillSlug)
  if (!dir) throw new Error(`Skill 不存在: ${workspaceSlug}/${skillSlug}`)
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf-8')
  console.log(`[Agent 工作区] 已更新 SKILL.md: ${workspaceSlug}/${skillSlug}`)
}

// ===== Skill 子文件管理 =====

/** 单个子文件大小上限（10 MB），超过则拒绝读入到编辑器 */
const SKILL_FILE_SIZE_LIMIT = 10 * 1024 * 1024
/** 文件树递归深度上限，防止异常深嵌套 */
const SKILL_TREE_MAX_DEPTH = 8

/** 把相对路径限制在 Skill 根目录内，并拒绝直接覆盖 SKILL.md */
function resolveSkillChildPath(skillDir: string, relativePath: string, opts: { allowSkillMd?: boolean } = {}): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('相对路径不能为空')
  }
  if (isAbsolute(relativePath)) {
    throw new Error('禁止传入绝对路径')
  }
  const normalized = relativePath.replace(/\\/g, '/')
  const resolved = resolve(skillDir, normalized)
  const rel = relative(skillDir, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('非法路径：禁止访问 Skill 目录外')
  }
  // 用 lowercase 比较，避免 macOS/Windows 的大小写不敏感文件系统上 skill.md/Skill.MD 绕过保护
  if (!opts.allowSkillMd && rel.split(/[\\/]/).join('/').toLowerCase() === 'skill.md') {
    throw new Error('SKILL.md 由专用接口管理，请通过 readWorkspaceSkillContent / writeWorkspaceSkillContent')
  }
  return resolved
}

/** 用文件头判断是否为二进制文件（粗略：含 NUL 字节即视为二进制）。只读前 8KB，避免把大文件全量读入内存 */
function isLikelyBinaryFile(absPath: string, size: number): boolean {
  if (size === 0) return false
  let fd: number | undefined
  try {
    fd = openSync(absPath, 'r')
    const buf = Buffer.alloc(Math.min(size, 8192))
    const n = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n).includes(0)
  } catch {
    return true
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function buildSkillFileTree(rootDir: string, currentDir: string, depth: number): SkillFileNode[] {
  if (depth > SKILL_TREE_MAX_DEPTH) return []
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(currentDir, { withFileTypes: true })
  } catch {
    return []
  }

  const nodes: SkillFileNode[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue // 跳过隐藏文件，如 .source.json
    const absPath = join(currentDir, entry.name)
    const rel = relative(rootDir, absPath).split(/[\\/]/).join('/')

    if (rel === 'SKILL.md') continue // SKILL.md 由主编辑器管理

    const isDir = entry.isDirectory()
    if (isDir) {
      nodes.push({
        relativePath: rel,
        name: entry.name,
        type: 'directory',
        children: buildSkillFileTree(rootDir, absPath, depth + 1),
      })
    } else if (entry.isFile()) {
      let size = 0
      try {
        size = statSync(absPath).size
      } catch {
        // ignore
      }
      nodes.push({
        relativePath: rel,
        name: entry.name,
        type: 'file',
        size,
        isText: !isLikelyBinaryFile(absPath, size),
      })
    }
  }

  // 目录优先 + 名称升序
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return nodes
}

export function listSkillFiles(workspaceSlug: string, skillSlug: string): SkillFileNode[] {
  const dir = resolveSkillDir(workspaceSlug, skillSlug)
  if (!dir) throw new Error(`Skill 不存在: ${workspaceSlug}/${skillSlug}`)
  return buildSkillFileTree(dir, dir, 0)
}

export function readSkillFile(workspaceSlug: string, skillSlug: string, relativePath: string): SkillFileContent {
  const dir = resolveSkillDir(workspaceSlug, skillSlug)
  if (!dir) throw new Error(`Skill 不存在: ${workspaceSlug}/${skillSlug}`)
  const abs = resolveSkillChildPath(dir, relativePath)
  if (!existsSync(abs)) throw new Error(`文件不存在: ${relativePath}`)

  const st = statSync(abs)
  if (!st.isFile()) throw new Error(`目标不是文件: ${relativePath}`)
  if (st.size > SKILL_FILE_SIZE_LIMIT) {
    throw new Error(`文件过大（${(st.size / 1024 / 1024).toFixed(2)} MB），超过 10 MB 限制`)
  }

  const binary = isLikelyBinaryFile(abs, st.size)
  return {
    relativePath: relative(dir, abs).split(/[\\/]/).join('/'),
    isText: !binary,
    size: st.size,
    content: binary ? undefined : readFileSync(abs, 'utf-8'),
  }
}

export function writeSkillFile(workspaceSlug: string, skillSlug: string, relativePath: string, content: string): void {
  const dir = resolveSkillDir(workspaceSlug, skillSlug)
  if (!dir) throw new Error(`Skill 不存在: ${workspaceSlug}/${skillSlug}`)
  const abs = resolveSkillChildPath(dir, relativePath)

  const byteLen = Buffer.byteLength(content, 'utf-8')
  if (byteLen > SKILL_FILE_SIZE_LIMIT) {
    throw new Error(`内容过大（${(byteLen / 1024 / 1024).toFixed(2)} MB），超过 10 MB 限制`)
  }

  if (existsSync(abs) && statSync(abs).isDirectory()) {
    throw new Error(`目标是目录，无法写入文件内容: ${relativePath}`)
  }

  // 自动创建父目录
  const parent = dirname(abs)
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true })
  }

  writeFileSync(abs, content, 'utf-8')
  console.log(`[Agent 工作区] 已更新 Skill 子文件: ${workspaceSlug}/${skillSlug}/${relativePath}`)
}

export function createSkillEntry(
  workspaceSlug: string,
  skillSlug: string,
  relativePath: string,
  type: 'file' | 'directory',
): void {
  const dir = resolveSkillDir(workspaceSlug, skillSlug)
  if (!dir) throw new Error(`Skill 不存在: ${workspaceSlug}/${skillSlug}`)
  const abs = resolveSkillChildPath(dir, relativePath)

  if (existsSync(abs)) {
    throw new Error(`目标已存在: ${relativePath}`)
  }

  if (type === 'directory') {
    mkdirSync(abs, { recursive: true })
  } else {
    const parent = dirname(abs)
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true })
    }
    writeFileSync(abs, '', 'utf-8')
  }
  console.log(`[Agent 工作区] 已创建 Skill 子${type === 'directory' ? '目录' : '文件'}: ${workspaceSlug}/${skillSlug}/${relativePath}`)
}

export function deleteSkillEntry(workspaceSlug: string, skillSlug: string, relativePath: string): void {
  const dir = resolveSkillDir(workspaceSlug, skillSlug)
  if (!dir) throw new Error(`Skill 不存在: ${workspaceSlug}/${skillSlug}`)
  const abs = resolveSkillChildPath(dir, relativePath)
  if (!existsSync(abs)) {
    throw new Error(`目标不存在: ${relativePath}`)
  }
  rmSyncWithRetry(abs, { recursive: true, force: true })
  console.log(`[Agent 工作区] 已删除 Skill 子项: ${workspaceSlug}/${skillSlug}/${relativePath}`)
}

export function renameSkillEntry(
  workspaceSlug: string,
  skillSlug: string,
  fromRelative: string,
  toRelative: string,
): void {
  const dir = resolveSkillDir(workspaceSlug, skillSlug)
  if (!dir) throw new Error(`Skill 不存在: ${workspaceSlug}/${skillSlug}`)
  const fromAbs = resolveSkillChildPath(dir, fromRelative)
  const toAbs = resolveSkillChildPath(dir, toRelative)
  if (!existsSync(fromAbs)) {
    throw new Error(`源不存在: ${fromRelative}`)
  }
  if (existsSync(toAbs)) {
    throw new Error(`目标已存在: ${toRelative}`)
  }
  const parent = dirname(toAbs)
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true })
  }
  renameWithRetry(fromAbs, toAbs)
  console.log(`[Agent 工作区] Skill 子项重命名: ${workspaceSlug}/${skillSlug}: ${fromRelative} → ${toRelative}`)
}

/** 简单 semver 比较：a 是否比 b 更新 */
function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

// ===== 工作区配置管理 =====

interface WorkspaceConfig {
  attachedDirectories?: string[]
  attachedFiles?: string[]
  worktreeRepos?: import('@copis/shared').WorkspaceWorktreeRepo[]
}

function getWorkspaceConfigPath(workspaceSlug: string): string {
  return join(getAgentWorkspacePath(workspaceSlug), 'config.json')
}

function readWorkspaceConfig(workspaceSlug: string): WorkspaceConfig {
  const configPath = getWorkspaceConfigPath(workspaceSlug)

  if (!existsSync(configPath)) {
    return {}
  }

  try {
    const raw = readFileSync(configPath, 'utf-8')
    const data = JSON.parse(raw) as Partial<WorkspaceConfig>
    const attachedDirectories = filterAttachedPaths(data.attachedDirectories)
    const attachedFiles = filterAttachedPaths(data.attachedFiles)
    return {
      attachedDirectories: attachedDirectories.length > 0 ? attachedDirectories : undefined,
      attachedFiles: attachedFiles.length > 0 ? attachedFiles : undefined,
      worktreeRepos: Array.isArray(data.worktreeRepos)
        ? data.worktreeRepos.filter((r) => r && typeof r.name === 'string' && typeof r.repoPath === 'string' && typeof r.worktreesPath === 'string')
        : undefined,
    }
  } catch {
    return {}
  }
}

function writeWorkspaceConfig(workspaceSlug: string, config: WorkspaceConfig): void {
  const configPath = getWorkspaceConfigPath(workspaceSlug)
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
}

// ===== 工作区级附加目录管理 =====

export function getWorkspaceAttachedDirectories(workspaceSlug: string): string[] {
  const config = readWorkspaceConfig(workspaceSlug)
  return config.attachedDirectories ?? []
}

export function attachWorkspaceDirectory(workspaceSlug: string, directoryPath: string): string[] {
  directoryPath = requireAttachedPath(directoryPath, '附加目录路径')
  const config = readWorkspaceConfig(workspaceSlug)
  const existing = config.attachedDirectories ?? []

  if (existing.includes(directoryPath)) {
    return existing
  }

  const updated = [...existing, directoryPath]
  writeWorkspaceConfig(workspaceSlug, { ...config, attachedDirectories: updated })
  console.log(`[Agent 工作区] 已附加工作区目录: ${directoryPath} → ${workspaceSlug}`)
  return updated
}

export function detachWorkspaceDirectory(workspaceSlug: string, directoryPath: string): string[] {
  const config = readWorkspaceConfig(workspaceSlug)
  const existing = config.attachedDirectories ?? []
  const updated = existing.filter((d) => d !== directoryPath)
  writeWorkspaceConfig(workspaceSlug, { ...config, attachedDirectories: updated })
  console.log(`[Agent 工作区] 已移除工作区目录: ${directoryPath} ← ${workspaceSlug}`)
  return updated
}

// ===== 工作区级附加文件管理 =====

export function getWorkspaceAttachedFiles(workspaceSlug: string): string[] {
  const config = readWorkspaceConfig(workspaceSlug)
  return config.attachedFiles ?? []
}

export function attachWorkspaceFile(workspaceSlug: string, filePath: string): string[] {
  filePath = requireAttachedPath(filePath, '附加文件路径')
  const config = readWorkspaceConfig(workspaceSlug)
  const existing = config.attachedFiles ?? []

  if (existing.includes(filePath)) {
    return existing
  }

  const updated = [...existing, filePath]
  writeWorkspaceConfig(workspaceSlug, { ...config, attachedFiles: updated })
  console.log(`[Agent 工作区] 已附加工作区文件: ${filePath} → ${workspaceSlug}`)
  return updated
}

export function detachWorkspaceFile(workspaceSlug: string, filePath: string): string[] {
  const config = readWorkspaceConfig(workspaceSlug)
  const existing = config.attachedFiles ?? []
  const updated = existing.filter((f) => f !== filePath)
  writeWorkspaceConfig(workspaceSlug, { ...config, attachedFiles: updated })
  console.log(`[Agent 工作区] 已移除工作区文件: ${filePath} ← ${workspaceSlug}`)
  return updated
}

// ===== 工作区级 Worktree 仓库管理 =====

/**
 * 获取工作区的 Worktree 仓库列表。
 *
 * 优先从工作区的「附加目录」中自动探测 git 仓库根，避免依赖手动维护的
 * worktreeRepos 配置（其 repoPath 容易因仓库移动而失效，导致 WorktreeSelector
 * 静默找不到 worktree）。同时保留 config 中仍然存在的手动配置项（如不在附加
 * 目录内的额外仓库），并自动过滤掉路径已不存在的陈旧条目。
 */
export async function getWorktreeRepos(workspaceSlug: string): Promise<import('@copis/shared').WorkspaceWorktreeRepo[]> {
  const config = readWorkspaceConfig(workspaceSlug)

  // repoPath 归一化后去重
  const byPath = new Map<string, import('@copis/shared').WorkspaceWorktreeRepo>()

  // 1. 从附加目录自动探测 git 仓库根
  const attachedDirs = config.attachedDirectories ?? []
  for (const dir of attachedDirs) {
    let roots: string[]
    try {
      roots = await findAllGitRoots(dir)
    } catch {
      continue
    }
    for (const root of roots) {
      if (!byPath.has(root)) {
        byPath.set(root, {
          name: basename(root),
          repoPath: root,
          worktreesPath: '',
          priority: 1,
        })
      }
    }
  }

  // 2. 合并手动配置中仍然存在的仓库（自动过滤失效路径）
  for (const repo of config.worktreeRepos ?? []) {
    const normalized = normalizeGitRoot(repo.repoPath)
    if (!byPath.has(normalized) && existsSync(repo.repoPath)) {
      byPath.set(normalized, repo)
    }
  }

  return Array.from(byPath.values()).sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
}

export function addWorktreeRepo(workspaceSlug: string, repo: import('@copis/shared').WorkspaceWorktreeRepo): import('@copis/shared').WorkspaceWorktreeRepo[] {
  const config = readWorkspaceConfig(workspaceSlug)
  const existing = config.worktreeRepos ?? []

  if (existing.some((r) => r.repoPath === repo.repoPath)) {
    return existing
  }

  const updated = [...existing, repo]
  writeWorkspaceConfig(workspaceSlug, { ...config, worktreeRepos: updated })
  console.log(`[Agent 工作区] 已添加 worktree 仓库: ${repo.name} (${repo.repoPath}) → ${workspaceSlug}`)
  return updated
}

export function removeWorktreeRepo(workspaceSlug: string, repoPath: string): import('@copis/shared').WorkspaceWorktreeRepo[] {
  const config = readWorkspaceConfig(workspaceSlug)
  const existing = config.worktreeRepos ?? []
  const updated = existing.filter((r) => r.repoPath !== repoPath)
  writeWorkspaceConfig(workspaceSlug, { ...config, worktreeRepos: updated })
  console.log(`[Agent 工作区] 已移除 worktree 仓库: ${repoPath} ← ${workspaceSlug}`)
  return updated
}

/**
 * 清理所有工作区中不存在的附加目录和附加文件
 * @returns 清理的条目总数
 */
export function cleanupStaleWorkspaceAttachedPaths(): number {
  const workspaces = listAgentWorkspaces()
  let count = 0

  for (const ws of workspaces) {
    const config = readWorkspaceConfig(ws.slug)
    let changed = false

    if (config.attachedDirectories?.length) {
      const valid = filterAttachedPaths(config.attachedDirectories).filter((d) => existsSync(d))
      if (valid.length < config.attachedDirectories.length) {
        count += config.attachedDirectories.length - valid.length
        config.attachedDirectories = valid.length > 0 ? valid : undefined
        changed = true
      }
    }

    if (config.attachedFiles?.length) {
      const valid = filterAttachedPaths(config.attachedFiles).filter((f) => existsSync(f))
      if (valid.length < config.attachedFiles.length) {
        count += config.attachedFiles.length - valid.length
        config.attachedFiles = valid.length > 0 ? valid : undefined
        changed = true
      }
    }

    if (changed) {
      writeWorkspaceConfig(ws.slug, config)
    }
  }

  if (count > 0) {
    console.log(`[Agent 工作区] 清理了 ${count} 个不存在的附加路径`)
  }

  return count
}
