import AdmZip from 'adm-zip'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import type {
  SkillMeta,
  SkillMarketSource,
  WorkingExpertSkillMarketItem,
  WorkingSkill,
} from '@copis/shared'
import {
  getAgentWorkspaceBySlug,
  getAllWorkspaceSkills,
  listAgentWorkspaces,
  readSkillMarketSource,
  writeSkillMarketSource,
} from './agent-workspace-manager'
import { getInactiveSkillsDir, getWorkspaceSkillsDir } from './config-paths'
import { rmSyncWithRetry, renameWithRetry } from './fs-retry'
import { getWorkingApiClient } from './working-api-service'

const MAX_PACKAGE_BYTES = 20 * 1024 * 1024
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024
const MAX_PACKAGE_FILES = 512
const DOWNLOAD_TIMEOUT_MS = 30 * 1000
const MARKET_INSTALL_LOCKS = new Map<string, Promise<unknown>>()

interface RuntimeSkillPackage {
  slug: string
  name: string
  description?: string
  version?: string
  instructions?: string
  downloadUrl?: string
  sha256?: string
  size?: number
}

function isSupportedIdentifier(value: unknown): value is number | string {
  return (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.trim().length > 0)
}

function sameIdentifier(left: number | string, right: number | string): boolean {
  return String(left) === String(right)
}

function safeSkillSlug(value: string): string {
  const slug = value.trim().toLowerCase()
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 96 ? slug : ''
}

function pathWithinRoot(candidate: string, root: string): boolean {
  const rootPath = statSync(root).isDirectory() ? root : dirname(root)
  const relativePath = relative(rootPath, candidate)
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !relativePath.startsWith(sep))
}

function normalizeArchiveEntryPath(entryName: string): string {
  const raw = entryName.replaceAll('\\', '/').trim()
  if (!raw || raw.startsWith('/')) throw new Error(`技能包包含不安全路径: ${entryName}`)

  const stripped = raw.replace(/^\.\//, '')
  const segments = stripped.split('/').filter((segment) => segment.length > 0)
  if (segments.length === 0 || segments.some((segment) => segment === '..')) {
    throw new Error(`技能包包含不安全路径: ${entryName}`)
  }
  const normalized = segments.join('/')
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`技能包包含不安全路径: ${entryName}`)
  }
  return normalized
}

function isZipSymlink(entry: AdmZip.IZipEntry): boolean {
  const unixMode = (entry.attr >>> 16) & 0xffff
  const externalMode = entry.attr & 0xffff
  return (unixMode & 0o170000) === 0o120000 || (externalMode & 0o170000) === 0o120000
}

function findSkillRoot(root: string): string {
  const candidates: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(entryPath)
      } else if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') {
        candidates.push(dirname(entryPath))
      }
    }
  }
  visit(root)

  const direct = candidates.find((candidate) => candidate === root)
  if (direct) return direct
  if (candidates.length !== 1) {
    throw new Error(candidates.length === 0 ? '技能包缺少 SKILL.md' : '技能包必须只包含一个 Skill 根目录')
  }
  return candidates[0]!
}

/**
 * 安全解压市场技能包到指定临时目录，并返回包含 SKILL.md 的根目录。
 * 该函数不接触工作区目录，便于独立验证 ZIP Slip、软链接和大小限制。
 */
export function extractWorkingSkillArchive(archive: Buffer, destinationRoot: string): string {
  if (archive.length === 0 || archive.length > MAX_PACKAGE_BYTES) {
    throw new Error(`技能包大小无效: ${archive.length}`)
  }
  mkdirSync(destinationRoot, { recursive: true, mode: 0o700 })

  let zip: AdmZip
  try {
    zip = new AdmZip(archive)
    if (!zip.test()) throw new Error('ZIP 校验失败')
  } catch (error) {
    throw new Error(`技能包不是有效 ZIP: ${error instanceof Error ? error.message : String(error)}`)
  }

  const entries = zip.getEntries()
  if (entries.length === 0 || entries.length > MAX_PACKAGE_FILES) {
    throw new Error(`技能包文件数量无效: ${entries.length}`)
  }

  const seen = new Set<string>()
  let totalBytes = 0
  for (const entry of entries) {
    const normalized = normalizeArchiveEntryPath(entry.entryName)
    if (seen.has(normalized)) throw new Error(`技能包包含重复路径: ${entry.entryName}`)
    seen.add(normalized)
    if (isZipSymlink(entry)) throw new Error(`技能包不允许软链接: ${entry.entryName}`)

    const declaredSize = entry.header.size
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
      throw new Error(`技能包文件大小无效: ${entry.entryName}`)
    }
    totalBytes += declaredSize
    if (totalBytes > MAX_UNCOMPRESSED_BYTES) throw new Error('技能包解压后过大')

    const targetPath = join(destinationRoot, ...normalized.split('/'))
    if (!pathWithinRoot(targetPath, destinationRoot)) throw new Error(`技能包路径越界: ${entry.entryName}`)
    if (entry.isDirectory) {
      mkdirSync(targetPath, { recursive: true, mode: 0o700 })
      continue
    }

    mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 })
    const data = entry.getData()
    if (data.length > MAX_UNCOMPRESSED_BYTES || data.length !== declaredSize) {
      throw new Error(`技能包文件大小校验失败: ${entry.entryName}`)
    }
    writeFileSync(targetPath, data, { mode: 0o600 })
  }

  const skillRoot = findSkillRoot(destinationRoot)
  const skillMdPath = join(skillRoot, 'SKILL.md')
  if (!existsSync(skillMdPath)) {
    const alternate = readdirSync(skillRoot).find((entry) => entry.toLowerCase() === 'skill.md')
    if (alternate) renameSync(join(skillRoot, alternate), skillMdPath)
  }
  if (!existsSync(skillMdPath) || statSync(skillMdPath).size === 0) throw new Error('技能包缺少有效 SKILL.md')
  return skillRoot
}

function buildGeneratedSkillMarkdown(skill: WorkingExpertSkillMarketItem, runtime: RuntimeSkillPackage): string {
  const slug = safeSkillSlug(skill.slug)
  const description = (skill.description || runtime.description || '').replace(/[\r\n]+/g, ' ').trim()
  const name = (skill.name || runtime.name || slug).replace(/[\r\n]+/g, ' ').trim() || slug
  const version = (runtime.version || skill.version || '1.0.0').trim() || '1.0.0'
  const instructions = (runtime.instructions ?? '').trim()
  if (!instructions) throw new Error(`技能 ${slug} 没有可安装的 instructions`)
  return `---\nname: ${slug}\ndescription: ${JSON.stringify(description)}\nmetadata:\n  version: ${JSON.stringify(version)}\n---\n\n# ${name}\n\n${instructions}\n`
}

function readRuntimeSkillPackage(skill: WorkingSkill): RuntimeSkillPackage {
  return {
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    instructions: skill.instructions,
    downloadUrl: skill.downloadUrl,
    sha256: skill.sha256,
    size: skill.size,
  }
}

async function downloadSkillArchive(runtime: RuntimeSkillPackage): Promise<Buffer> {
  const rawUrl = runtime.downloadUrl?.trim()
  if (!rawUrl) throw new Error('技能没有可下载的安装包')
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('技能下载地址无效')
  }
  const isLocalHttp = parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1')
  if (parsed.protocol !== 'https:' && !isLocalHttp) throw new Error('技能下载地址必须使用 HTTPS')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const response = await fetch(parsed.toString(), { signal: controller.signal })
    if (!response.ok) throw new Error(`技能包下载失败（HTTP ${response.status}）`)
    const contentLength = response.headers.get('content-length')
    if (contentLength && Number(contentLength) > MAX_PACKAGE_BYTES) throw new Error('技能包下载大小超过限制')
    const data = Buffer.from(await response.arrayBuffer())
    if (data.length === 0 || data.length > MAX_PACKAGE_BYTES) throw new Error(`技能包大小无效: ${data.length}`)
    if (runtime.size !== undefined && runtime.size > 0 && data.length !== runtime.size) {
      throw new Error('技能包大小校验失败')
    }
    const expectedSHA = runtime.sha256?.trim().toLowerCase()
    if (expectedSHA) {
      if (!/^[a-f0-9]{64}$/.test(expectedSHA)) throw new Error('技能包 SHA-256 格式无效')
      const actualSHA = createHash('sha256').update(data).digest('hex')
      if (actualSHA !== expectedSHA) throw new Error('技能包 SHA-256 校验失败')
    }
    return data
  } finally {
    clearTimeout(timer)
  }
}

function localMarketSkill(workspaceSlug: string, skillId: number | string, slug?: string): { meta: SkillMeta; directory: string } | undefined {
  const skill = getAllWorkspaceSkills(workspaceSlug).find((item) => {
    if (!item.marketSource) return false
    return sameIdentifier(item.marketSource.id, skillId) || (slug !== undefined && item.slug === slug)
  })
  if (!skill) return undefined
  const parent = skill.enabled ? getWorkspaceSkillsDir(workspaceSlug) : getInactiveSkillsDir(workspaceSlug)
  return { meta: skill, directory: join(parent, skill.slug) }
}

function removeLocalMarketSkill(workspaceSlug: string, skillId: number | string): void {
  const local = localMarketSkill(workspaceSlug, skillId)
  if (local) rmSyncWithRetry(local.directory, { recursive: true, force: true })
}

function hasMarketSkillInOtherWorkspace(workspaceSlug: string, skillId: number | string): boolean {
  return listAgentWorkspaces()
    .filter((workspace) => workspace.slug !== workspaceSlug)
    .some((workspace) => localMarketSkill(workspace.slug, skillId) !== undefined)
}

function currentSkillMeta(workspaceSlug: string, slug: string): SkillMeta {
  const skill = getAllWorkspaceSkills(workspaceSlug).find((item) => item.slug === slug)
  if (!skill) throw new Error(`市场 Skill 安装后未找到: ${slug}`)
  return skill
}

function installIntoWorkspace(
  workspaceSlug: string,
  marketSkill: WorkingExpertSkillMarketItem,
  runtime: RuntimeSkillPackage,
  archive: Buffer | undefined,
): SkillMeta {
  const slug = safeSkillSlug(marketSkill.slug)
  if (!slug) throw new Error(`市场 Skill slug 无效: ${marketSkill.slug}`)
  if (runtime.slug && runtime.slug !== slug) throw new Error(`市场 Skill slug 不一致: ${runtime.slug}`)

  const existing = getAllWorkspaceSkills(workspaceSlug).find((item) => item.slug === slug)
  if (existing && !existing.marketSource) {
    throw new Error(`当前项目已存在同名本地 Skill: ${slug}`)
  }
  const targetParent = existing?.enabled === false ? getInactiveSkillsDir(workspaceSlug) : getWorkspaceSkillsDir(workspaceSlug)
  const target = join(targetParent, slug)
  const temporary = mkdtempSync(join(targetParent, '.copis-market-skill-'))

  try {
    const extractedRoot = archive
      ? extractWorkingSkillArchive(archive, temporary)
      : (() => {
        mkdirSync(temporary, { recursive: true, mode: 0o700 })
        writeFileSync(join(temporary, 'SKILL.md'), buildGeneratedSkillMarkdown(marketSkill, runtime), { encoding: 'utf-8', mode: 0o600 })
        return temporary
      })()

    const source: SkillMarketSource = {
      id: marketSkill.id,
      slug,
      version: runtime.version || marketSkill.version || '1.0.0',
      sourceProvider: marketSkill.sourceProvider,
      installedAt: new Date().toISOString(),
    }
    const backup = `${target}.copis-market-backup-${randomUUID()}`
    if (existsSync(target)) renameWithRetry(target, backup)
    try {
      renameWithRetry(extractedRoot, target)
      writeSkillMarketSource(target, source)
      if (existsSync(backup)) rmSyncWithRetry(backup, { recursive: true, force: true })
    } catch (error) {
      if (existsSync(target)) rmSyncWithRetry(target, { recursive: true, force: true })
      if (existsSync(backup)) renameWithRetry(backup, target)
      throw error
    }
  } finally {
    if (existsSync(temporary)) rmSyncWithRetry(temporary, { recursive: true, force: true })
  }
  return currentSkillMeta(workspaceSlug, slug)
}

async function withMarketInstallLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = MARKET_INSTALL_LOCKS.get(key)
  const current = (previous ?? Promise.resolve()).then(operation)
  MARKET_INSTALL_LOCKS.set(key, current)
  try {
    return await current
  } finally {
    if (MARKET_INSTALL_LOCKS.get(key) === current) MARKET_INSTALL_LOCKS.delete(key)
  }
}

export async function listWorkingExpertSkillMarket(): Promise<WorkingExpertSkillMarketItem[]> {
  return getWorkingApiClient().listExpertSkillMarket()
}

/** 将账号级市场状态与当前 Copis 工作区的本地落地状态合并。 */
export async function listWorkingExpertSkillMarketForWorkspace(
  workspaceSlug: string,
): Promise<WorkingExpertSkillMarketItem[]> {
  const workspace = getAgentWorkspaceBySlug(workspaceSlug)
  if (!workspace) throw new Error(`工作区不存在: ${workspaceSlug}`)

  const [marketItems, localSkills] = await Promise.all([
    listWorkingExpertSkillMarket(),
    Promise.resolve(getAllWorkspaceSkills(workspaceSlug)),
  ])
  const localMarketSkills = localSkills.filter((skill) => skill.marketSource !== undefined)

  return marketItems.map((item) => {
    const localSkill = localMarketSkills.find((skill) => (
      skill.slug === item.slug
      || (skill.marketSource !== undefined && sameIdentifier(skill.marketSource.id, item.id))
    ))
    return {
      ...item,
      localInstalled: localSkill !== undefined,
      ...(localSkill
        ? { localVersion: localSkill.marketSource?.version ?? localSkill.version ?? item.version }
        : {}),
    }
  })
}

/** 按父项目协议安装账号技能，再把 runtime 包落到当前 Copis 工作区。 */
export async function installWorkingExpertSkill(workspaceSlug: string, skillId: number | string): Promise<SkillMeta> {
  const workspace = getAgentWorkspaceBySlug(workspaceSlug)
  if (!workspace) throw new Error(`工作区不存在: ${workspaceSlug}`)
  if (!isSupportedIdentifier(skillId)) throw new Error('技能市场 ID 不正确')

  return withMarketInstallLock(`${workspaceSlug}:${String(skillId)}`, async () => {
    const client = getWorkingApiClient()
    const marketSkill = await client.installExpertSkill(skillId)
    const runtimeSkills = await client.listSkills()
    const runtime = runtimeSkills.find((item) => item.slug === marketSkill.slug)
    if (!runtime) throw new Error(`Working runtime 未返回已安装 Skill: ${marketSkill.slug}`)
    const runtimePackage = readRuntimeSkillPackage(runtime)
    const archive = runtimePackage.downloadUrl ? await downloadSkillArchive(runtimePackage) : undefined
    return installIntoWorkspace(workspaceSlug, marketSkill, runtimePackage, archive)
  })
}

/** 删除当前工作区市场副本；没有其他 Copis 工作区使用时再同步账号卸载。 */
export async function uninstallWorkingExpertSkill(workspaceSlug: string, skillId: number | string): Promise<void> {
  const workspace = getAgentWorkspaceBySlug(workspaceSlug)
  if (!workspace) throw new Error(`工作区不存在: ${workspaceSlug}`)
  if (!isSupportedIdentifier(skillId)) throw new Error('技能市场 ID 不正确')

  await withMarketInstallLock(`${workspaceSlug}:${String(skillId)}`, async () => {
    removeLocalMarketSkill(workspaceSlug, skillId)
    if (!hasMarketSkillInOtherWorkspace(workspaceSlug, skillId)) {
      await getWorkingApiClient().uninstallExpertSkill(skillId)
    }
  })
}

/** 删除本地市场副本时供工作区管理器复用，避免把普通 Skill 当成市场 Skill。 */
export function isLocalMarketSkill(workspaceSlug: string, skillSlug: string): boolean {
  return getAllWorkspaceSkills(workspaceSlug).some((skill) => skill.slug === skillSlug && skill.marketSource !== undefined)
}
