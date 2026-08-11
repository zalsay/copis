import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { FunctionalModuleFormat } from '@copis/shared'

const ARCHIVE_PAYLOAD_FILE = '.artifact.tar.gz'
const MAX_ARCHIVE_UNPACKED_BYTES = 512 * 1024 * 1024
const TAR_TYPE_PAX_GLOBAL_EXTENDED_HEADER = 'g'.charCodeAt(0)
const TAR_TYPE_PAX_EXTENDED_HEADER = 'x'.charCodeAt(0)

export interface FunctionalModulePackage {
  name: string
  version: string
  sha256: string
  size: number
  format: FunctionalModuleFormat
  entrypoint: string
  required: boolean
}

interface FunctionalModuleCacheMetadata {
  package: FunctionalModulePackage
  files: string[]
}

interface ActiveFunctionalModuleMetadata extends FunctionalModulePackage {
  versionDir: string
}

interface ActiveFunctionalModulesFile {
  modules: Record<string, ActiveFunctionalModuleMetadata>
}

export interface ActiveFunctionalModule extends FunctionalModulePackage {
  path: string
}

export interface FunctionalModulePaths {
  rootDir: string
  cacheDir: string
  versionsDir: string
  downloadsDir: string
  activeFile: string
}

export function getFunctionalModulePaths(rootDir: string): FunctionalModulePaths {
  const normalizedRoot = resolve(rootDir)
  return {
    rootDir: normalizedRoot,
    cacheDir: join(normalizedRoot, 'cache'),
    versionsDir: join(normalizedRoot, 'versions'),
    downloadsDir: join(normalizedRoot, 'downloads'),
    activeFile: join(normalizedRoot, 'active.json'),
  }
}

export function moduleCacheComplete(
  paths: FunctionalModulePaths,
  packageInfo: FunctionalModulePackage,
): boolean {
  try {
    validateModulePackage(packageInfo)
    const dir = moduleCacheDir(paths, packageInfo)
    if (!existsSync(join(dir, '.complete')) || !existsSync(join(dir, 'payload'))) return false

    const metadata = JSON.parse(readFileSync(join(dir, 'module.json'), 'utf-8')) as FunctionalModuleCacheMetadata
    return metadata.package.name === packageInfo.name
      && metadata.package.version === packageInfo.version
      && metadata.package.sha256.toLowerCase() === packageInfo.sha256.toLowerCase()
      && metadata.package.size === packageInfo.size
      && metadata.package.format === packageInfo.format
      && metadata.package.entrypoint === packageInfo.entrypoint
      && metadata.package.required === packageInfo.required
      && metadata.files.includes(moduleCachePayloadName(packageInfo))
      && existsSync(join(dir, 'payload', moduleCachePayloadName(packageInfo)))
  } catch {
    return false
  }
}

export async function cacheFunctionalModule(
  paths: FunctionalModulePaths,
  packageInfo: FunctionalModulePackage,
  sourcePath: string,
): Promise<string> {
  validateModulePackage(packageInfo)
  const source = resolve(sourcePath)
  const sourceStats = await stat(source).catch(() => undefined)
  if (!sourceStats?.isFile()) throw new Error(`模块源文件不存在: ${source}`)

  const targetDir = moduleCacheDir(paths, packageInfo)
  const payloadPath = join(targetDir, 'payload', moduleCachePayloadName(packageInfo))
  if (moduleCacheComplete(paths, packageInfo)) return payloadPath

  const temporaryDir = join(
    dirname(targetDir),
    `.${packageInfo.sha256}.${process.pid}.${Date.now()}.tmp`,
  )
  await rm(temporaryDir, { recursive: true, force: true })

  try {
    const temporaryPayloadPath = join(temporaryDir, 'payload', moduleCachePayloadName(packageInfo))
    await mkdir(dirname(temporaryPayloadPath), { recursive: true })
    await copyFile(source, temporaryPayloadPath)
    if (packageInfo.format === 'binary') await markExecutable(temporaryPayloadPath)
    await writeFile(
      join(temporaryDir, 'module.json'),
      JSON.stringify({ package: packageInfo, files: [moduleCachePayloadName(packageInfo)] } satisfies FunctionalModuleCacheMetadata, null, 2),
      'utf-8',
    )
    await writeFile(join(temporaryDir, '.complete'), 'complete\n', 'utf-8')
    await mkdir(dirname(targetDir), { recursive: true })

    if (existsSync(targetDir)) {
      if (moduleCacheComplete(paths, packageInfo)) return payloadPath
      await rm(targetDir, { recursive: true, force: true })
    }
    await rename(temporaryDir, targetDir)
  } catch (error) {
    if (moduleCacheComplete(paths, packageInfo)) return payloadPath
    throw new Error(`写入功能模块缓存失败: ${packageInfo.name}`, { cause: error })
  } finally {
    await rm(temporaryDir, { recursive: true, force: true })
  }

  return payloadPath
}

export async function assembleFunctionalModule(
  paths: FunctionalModulePaths,
  packageInfo: FunctionalModulePackage,
): Promise<string> {
  validateModulePackage(packageInfo)
  if (!moduleCacheComplete(paths, packageInfo)) {
    throw new Error(`功能模块缓存不完整: ${packageInfo.name}`)
  }

  const sourcePath = join(moduleCacheDir(paths, packageInfo), 'payload', moduleCachePayloadName(packageInfo))
  const versionDir = moduleVersionDir(paths, packageInfo)
  if (moduleVersionComplete(versionDir, packageInfo)) return versionDir

  const temporaryDir = join(
    dirname(versionDir),
    `.${packageInfo.version}-${packageInfo.sha256}.${process.pid}.${Date.now()}.tmp`,
  )
  await rm(temporaryDir, { recursive: true, force: true })

  try {
    const temporaryPath = join(temporaryDir, packageInfo.entrypoint)
    if (packageInfo.format === 'binary') {
      await mkdir(dirname(temporaryPath), { recursive: true })
      await copyFile(sourcePath, temporaryPath)
    } else {
      await extractTarGz(sourcePath, temporaryDir)
    }
    if (!existsSync(temporaryPath)) {
      throw new Error(`归档模块缺少入口文件: ${packageInfo.entrypoint}`)
    }
    await markExecutable(temporaryPath)
    await writeFile(
      join(temporaryDir, 'module-lock.json'),
      JSON.stringify({ package: packageInfo }, null, 2),
      'utf-8',
    )
    await writeFile(join(temporaryDir, '.complete'), 'complete\n', 'utf-8')
    await mkdir(dirname(versionDir), { recursive: true })

    if (existsSync(versionDir)) {
      if (moduleVersionComplete(versionDir, packageInfo)) return versionDir
      await rm(versionDir, { recursive: true, force: true })
    }
    await rename(temporaryDir, versionDir)
  } catch (error) {
    if (moduleVersionComplete(versionDir, packageInfo)) return versionDir
    throw new Error(`组装功能模块版本失败: ${packageInfo.name}`, { cause: error })
  } finally {
    await rm(temporaryDir, { recursive: true, force: true })
  }

  return versionDir
}

export async function activateFunctionalModule(
  paths: FunctionalModulePaths,
  packageInfo: FunctionalModulePackage,
  versionDir: string,
): Promise<void> {
  validateModulePackage(packageInfo)
  const normalizedVersionDir = resolve(versionDir)
  if (!isPathWithin(paths.versionsDir, normalizedVersionDir)) {
    throw new Error(`功能模块版本目录不在受管路径内: ${versionDir}`)
  }
  if (!moduleVersionComplete(normalizedVersionDir, packageInfo)) {
    throw new Error(`不能激活未完成的功能模块版本: ${packageInfo.name}`)
  }

  const current = readActiveFile(paths)
  const versionDirRelative = relative(paths.rootDir, normalizedVersionDir).split(sep).join('/')
  const next: ActiveFunctionalModulesFile = {
    modules: {
      ...current.modules,
      [packageInfo.name]: {
        ...packageInfo,
        versionDir: versionDirRelative,
      },
    },
  }
  await writeJsonAtomically(paths.activeFile, next)
}

/** 将一个已经完成的旧版本重新写回 active 指针，用于更新失败后的恢复。 */
export async function restoreFunctionalModule(
  paths: FunctionalModulePaths,
  active: ActiveFunctionalModule,
): Promise<void> {
  const packageInfo: FunctionalModulePackage = {
    name: active.name,
    version: active.version,
    sha256: active.sha256,
    size: active.size,
    format: active.format,
    entrypoint: active.entrypoint,
    required: active.required,
  }
  await activateFunctionalModule(paths, packageInfo, moduleVersionDir(paths, packageInfo))
}

export async function deactivateFunctionalModule(
  paths: FunctionalModulePaths,
  name: string,
): Promise<void> {
  const current = readActiveFile(paths)
  if (!(name in current.modules)) return
  const modules = { ...current.modules }
  delete modules[name]
  await writeJsonAtomically(paths.activeFile, { modules } satisfies ActiveFunctionalModulesFile)
}

export function readActiveFunctionalModule(
  paths: FunctionalModulePaths,
  name: string,
): ActiveFunctionalModule | undefined {
  const record = readActiveFile(paths).modules[name]
  if (!record) return undefined

  try {
    validateModulePackage(record)
    if (record.name !== name) return undefined
    const versionDir = resolve(paths.rootDir, record.versionDir)
    if (!isPathWithin(paths.rootDir, versionDir) || !isPathWithin(paths.versionsDir, versionDir)) return undefined
    if (!moduleVersionComplete(versionDir, record)) return undefined
    return {
      ...record,
      path: join(versionDir, record.entrypoint),
    }
  } catch {
    return undefined
  }
}

export function readActiveFunctionalModules(
  rootDir: string,
): Record<string, ActiveFunctionalModule> {
  const paths = getFunctionalModulePaths(rootDir)
  const active: Record<string, ActiveFunctionalModule> = {}
  for (const name of Object.keys(readActiveFile(paths).modules)) {
    const item = readActiveFunctionalModule(paths, name)
    if (item) active[name] = item
  }
  return active
}

export function moduleCacheDir(
  paths: FunctionalModulePaths,
  packageInfo: FunctionalModulePackage,
): string {
  return join(paths.cacheDir, packageInfo.name, packageInfo.sha256.toLowerCase())
}

export function moduleVersionDir(
  paths: FunctionalModulePaths,
  packageInfo: FunctionalModulePackage,
): string {
  return join(paths.versionsDir, packageInfo.name, `${packageInfo.version}-${packageInfo.sha256.toLowerCase()}`)
}

function moduleVersionComplete(versionDir: string, packageInfo: FunctionalModulePackage): boolean {
  if (!existsSync(join(versionDir, '.complete')) || !existsSync(join(versionDir, 'module-lock.json'))) return false
  try {
    const lock = JSON.parse(readFileSync(join(versionDir, 'module-lock.json'), 'utf-8')) as { package?: FunctionalModulePackage }
    return lock.package?.name === packageInfo.name
      && lock.package.version === packageInfo.version
      && lock.package.sha256.toLowerCase() === packageInfo.sha256.toLowerCase()
      && lock.package.size === packageInfo.size
      && lock.package.format === packageInfo.format
      && lock.package.entrypoint === packageInfo.entrypoint
      && lock.package.required === packageInfo.required
      && existsSync(join(versionDir, packageInfo.entrypoint))
  } catch {
    return false
  }
}

function readActiveFile(paths: FunctionalModulePaths): ActiveFunctionalModulesFile {
  if (!existsSync(paths.activeFile)) return { modules: {} }
  try {
    const value = JSON.parse(readFileSync(paths.activeFile, 'utf-8')) as Partial<ActiveFunctionalModulesFile>
    return value.modules && typeof value.modules === 'object' ? { modules: value.modules } : { modules: {} }
  } catch {
    return { modules: {} }
  }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temporaryPath, JSON.stringify(value, null, 2), 'utf-8')
  try {
    await rename(temporaryPath, path)
  } catch (error) {
    const backupPath = `${path}.${process.pid}.backup`
    try {
      if (existsSync(path)) await rename(path, backupPath)
      await rename(temporaryPath, path)
      await rm(backupPath, { force: true })
    } catch (replaceError) {
      if (existsSync(backupPath) && !existsSync(path)) await rename(backupPath, path)
      throw new Error(`写入功能模块 active 文件失败: ${path}`, { cause: replaceError })
    } finally {
      await rm(temporaryPath, { force: true })
    }
  }
}

function validateModulePackage(packageInfo: FunctionalModulePackage): void {
  for (const [label, value] of [
    ['模块名称', packageInfo.name],
    ['模块版本', packageInfo.version],
    ['模块 sha256', packageInfo.sha256],
  ] as const) {
    if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
      throw new Error(`${label}不合法: ${value}`)
    }
  }
  if (!/^[a-f0-9]{64}$/i.test(packageInfo.sha256)) {
    throw new Error(`模块 sha256 不合法: ${packageInfo.sha256}`)
  }
  if (!Number.isSafeInteger(packageInfo.size) || packageInfo.size < 0) {
    throw new Error(`模块 size 不合法: ${packageInfo.size}`)
  }
  if (packageInfo.format !== 'binary' && packageInfo.format !== 'tar.gz') {
    throw new Error(`模块 format 不支持: ${packageInfo.format}`)
  }
  if (typeof packageInfo.required !== 'boolean') {
    throw new Error(`模块 required 不合法: ${packageInfo.required}`)
  }
  if (!isSafeRelativePath(packageInfo.entrypoint)) {
    throw new Error(`模块入口路径不安全: ${packageInfo.entrypoint}`)
  }
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.includes('\0') || isAbsolute(value)) return false
  const normalized = value.replaceAll('\\', '/')
  return normalized !== '.' && normalized !== '..' && !normalized.startsWith('../') && !normalized.includes('/../')
}

function isPathWithin(root: string, target: string): boolean {
  const relativePath = relative(resolve(root), resolve(target))
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

async function markExecutable(path: string): Promise<void> {
  if (process.platform === 'win32') return
  await chmod(path, 0o755)
}

function moduleCachePayloadName(packageInfo: FunctionalModulePackage): string {
  return packageInfo.format === 'binary' ? packageInfo.entrypoint : ARCHIVE_PAYLOAD_FILE
}

async function extractTarGz(sourcePath: string, targetDir: string): Promise<void> {
  let tar: Buffer
  try {
    tar = gunzipSync(await readFile(sourcePath), { maxOutputLength: MAX_ARCHIVE_UNPACKED_BYTES })
  } catch (error) {
    throw new Error(`无法解压 tar.gz 功能模块: ${error instanceof Error ? error.message : String(error)}`)
  }

  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) return

    const name = readTarString(header, 0, 100)
    const prefix = readTarString(header, 345, 155)
    const path = [prefix, name].filter(Boolean).join('/')
    const size = readTarSize(header)
    const type = header[156] ?? 0
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    if (dataEnd > tar.length) throw new Error('tar.gz 功能模块内容不完整')

    // macOS tar 会写入 PAX 扩展头保存时间戳和扩展属性；它们不代表待落盘的文件。
    if (type === TAR_TYPE_PAX_GLOBAL_EXTENDED_HEADER || type === TAR_TYPE_PAX_EXTENDED_HEADER) {
      offset = dataStart + Math.ceil(size / 512) * 512
      continue
    }

    const normalizedPath = path.replace(/^\.\//, '')
    // GNU tar 和 BSD tar 都可能在归档开头写入 "./" 根目录条目；它不代表文件，跳过即可。
    if ((path === '.' || path === './' || normalizedPath === '') && type === 53 && size === 0) {
      offset = dataStart + Math.ceil(size / 512) * 512
      continue
    }
    if (!isSafeRelativePath(normalizedPath)) {
      throw new Error(`tar.gz 功能模块包含不安全路径: ${path}`)
    }
    const targetPath = resolve(targetDir, normalizedPath)
    if (!isPathWithin(targetDir, targetPath)) {
      throw new Error(`tar.gz 功能模块路径超出目标目录: ${path}`)
    }

    if (type === 0 || type === 48) {
      await mkdir(dirname(targetPath), { recursive: true })
      await writeFile(targetPath, tar.subarray(dataStart, dataEnd))
      if (normalizedPath.startsWith('bin/')) await markExecutable(targetPath)
    } else if (type === 53) {
      await mkdir(targetPath, { recursive: true })
    } else {
      throw new Error(`tar.gz 功能模块不支持的条目类型: ${String.fromCharCode(type)}`)
    }
    offset = dataStart + Math.ceil(size / 512) * 512
  }

  throw new Error('tar.gz 功能模块缺少结束标记')
}

function readTarString(header: Buffer, start: number, length: number): string {
  const value = header.subarray(start, start + length)
  const end = value.indexOf(0)
  return value.subarray(0, end < 0 ? value.length : end).toString('utf-8')
}

function readTarSize(header: Buffer): number {
  const value = readTarString(header, 124, 12).trim()
  if (!value) return 0
  if (!/^[0-7]+$/.test(value)) throw new Error('tar.gz 功能模块条目大小不合法')
  const size = Number.parseInt(value, 8)
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ARCHIVE_UNPACKED_BYTES) {
    throw new Error('tar.gz 功能模块条目过大')
  }
  return size
}
