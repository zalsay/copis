import { chmod, copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface FunctionalModulePackage {
  name: string
  version: string
  sha256: string
  size: number
  format: 'binary'
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
      && metadata.files.includes(packageInfo.entrypoint)
      && existsSync(join(dir, 'payload', packageInfo.entrypoint))
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
  const payloadPath = join(targetDir, 'payload', packageInfo.entrypoint)
  if (moduleCacheComplete(paths, packageInfo)) return payloadPath

  const temporaryDir = join(
    dirname(targetDir),
    `.${packageInfo.sha256}.${process.pid}.${Date.now()}.tmp`,
  )
  await rm(temporaryDir, { recursive: true, force: true })

  try {
    const temporaryPayloadPath = join(temporaryDir, 'payload', packageInfo.entrypoint)
    await mkdir(dirname(temporaryPayloadPath), { recursive: true })
    await copyFile(source, temporaryPayloadPath)
    await markExecutable(temporaryPayloadPath)
    await writeFile(
      join(temporaryDir, 'module.json'),
      JSON.stringify({ package: packageInfo, files: [packageInfo.entrypoint] } satisfies FunctionalModuleCacheMetadata, null, 2),
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

  const sourcePath = join(moduleCacheDir(paths, packageInfo), 'payload', packageInfo.entrypoint)
  const versionDir = moduleVersionDir(paths, packageInfo)
  if (moduleVersionComplete(versionDir, packageInfo)) return versionDir

  const temporaryDir = join(
    dirname(versionDir),
    `.${packageInfo.version}-${packageInfo.sha256}.${process.pid}.${Date.now()}.tmp`,
  )
  await rm(temporaryDir, { recursive: true, force: true })

  try {
    const temporaryPath = join(temporaryDir, packageInfo.entrypoint)
    await mkdir(dirname(temporaryPath), { recursive: true })
    await copyFile(sourcePath, temporaryPath)
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
  if (packageInfo.format !== 'binary') {
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
