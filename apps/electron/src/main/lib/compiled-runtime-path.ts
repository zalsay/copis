import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type CompiledRuntimePlatform = 'win32' | 'darwin' | 'linux'
export type CompiledRuntimeArch = 'x64' | 'arm64'

const SUPPORTED_PLATFORMS = new Set<CompiledRuntimePlatform>(['win32', 'darwin', 'linux'])
const SUPPORTED_ARCHES = new Set<CompiledRuntimeArch>(['x64', 'arm64'])

export interface ResolveBundledCliPathOptions {
  resourcesPath: string
  platform?: string
  arch?: string
  exists?: (path: string) => boolean
}

/** 返回当前平台和架构对应的自包含 Copis 目录名。 */
export function resolveCompiledRuntimeDirectoryName(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  if (!SUPPORTED_PLATFORMS.has(platform as CompiledRuntimePlatform)) {
    throw new Error(`不支持的 Copis runtime 平台: ${platform}`)
  }
  if (!SUPPORTED_ARCHES.has(arch as CompiledRuntimeArch)) {
    throw new Error(`不支持的 Copis runtime 架构: ${arch}`)
  }

  return `${platform}-${arch}`
}

/** 返回当前平台对应的 Copis 文件名。 */
export function resolveCompiledRuntimeBinaryName(platform: string = process.platform): string {
  return platform === 'win32' ? 'copis.exe' : 'copis'
}

/** 返回架构目录内产物和旧版根目录产物的查找顺序。 */
export function resolveCompiledRuntimeBinaryCandidates(
  platform: string = process.platform,
  arch: string = process.arch,
): string[] {
  const targetPath = join(
    resolveCompiledRuntimeDirectoryName(platform, arch),
    resolveCompiledRuntimeBinaryName(platform),
  )
  return [targetPath, resolveCompiledRuntimeBinaryName(platform)]
}

/** 返回所有受支持的架构目录名，供构建时清理旧目标。 */
export function resolveCompiledRuntimeDirectoryNames(): string[] {
  return [
    resolveCompiledRuntimeDirectoryName('win32', 'x64'),
    resolveCompiledRuntimeDirectoryName('win32', 'arm64'),
    resolveCompiledRuntimeDirectoryName('darwin', 'arm64'),
    resolveCompiledRuntimeDirectoryName('darwin', 'x64'),
    resolveCompiledRuntimeDirectoryName('linux', 'arm64'),
    resolveCompiledRuntimeDirectoryName('linux', 'x64'),
  ]
}

/** 在 Electron resources 目录中定位当前平台架构的 Copis runtime。 */
export function resolveBundledCliPath(options: ResolveBundledCliPathOptions): string | undefined {
  const exists = options.exists ?? existsSync
  for (const name of resolveCompiledRuntimeBinaryCandidates(options.platform, options.arch)) {
    const candidate = join(options.resourcesPath, 'bin', name)
    if (exists(candidate)) return candidate
  }
  return undefined
}
