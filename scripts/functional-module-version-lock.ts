/** 功能模块版本锁：修改此配置才会触发对应模块的新版本发布。 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { FunctionalModuleManifest, FunctionalModuleName, FunctionalModulePlatform, FunctionalModuleArchitecture } from '@copis/shared'
import type { FunctionalModuleBinaryInput } from './functional-module-publisher'

const LOCKED_MODULES = ['node-runtime', 'python-runtime', 'alipay-bot', 'playwright-core', 'agently-cli', 'dsh'] as const
type LockedModuleName = (typeof LOCKED_MODULES)[number]

export interface FunctionalModuleVersionLocks {
  'node-runtime': string
  'python-runtime': string
  'alipay-bot': string
  'playwright-core': string
  'agently-cli': string
  'dsh': string
}

export const DEFAULT_FUNCTIONAL_MODULE_VERSIONS_PATH = resolve(
  import.meta.dir,
  'functional-module-versions.json',
)

export function loadFunctionalModuleVersionLocks(
  path = DEFAULT_FUNCTIONAL_MODULE_VERSIONS_PATH,
): FunctionalModuleVersionLocks {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`无法读取功能模块版本锁配置：${path}`, { cause: error })
  }
  if (!isRecord(value)) throw new Error(`功能模块版本锁配置必须是对象：${path}`)

  return {
    'node-runtime': validateVersion(value['node-runtime'], 'node-runtime', path),
    'python-runtime': validateVersion(value['python-runtime'], 'python-runtime', path),
    'alipay-bot': validateVersion(value['alipay-bot'], 'alipay-bot', path),
    'playwright-core': validateVersion(value['playwright-core'], 'playwright-core', path),
    'agently-cli': validateVersion(value['agently-cli'], 'agently-cli', path),
    'dsh': validateVersion(value['dsh'], 'dsh', path),
  }
}

/** 锁定模块始终以配置文件版本为准，忽略部署参数和环境变量中的临时版本。 */
export function applyFunctionalModuleVersionLocks(
  modules: readonly FunctionalModuleBinaryInput[],
  locks: FunctionalModuleVersionLocks,
): FunctionalModuleBinaryInput[] {
  return modules.map((module) => isLockedModule(module.module)
    ? { ...module, version: locks[module.module] }
    : module,
  )
}

/**
 * 仅当配置的锁定版本高于 COS manifest 当前版本时才发布。
 * 因此 deploy 不会覆盖、回退或自动递增 runtime 归档版本。
 */
export function excludeUnchangedLockedModules(
  modules: readonly FunctionalModuleBinaryInput[],
  manifest: FunctionalModuleManifest | undefined,
  platform: FunctionalModulePlatform,
  arch: FunctionalModuleArchitecture,
  locks: FunctionalModuleVersionLocks,
): FunctionalModuleBinaryInput[] {
  const existingModules = manifest?.platforms[`${platform}-${arch}`]?.modules
  return modules.filter((module) => {
    if (!isLockedModule(module.module)) return true
    const publishedArtifact = existingModules?.[module.module]
    const publishedVersion = publishedArtifact?.version
    if (publishedArtifact && compareModuleContract(module, publishedArtifact) !== 0) return true
    return !publishedVersion || compareStableVersions(locks[module.module], publishedVersion) > 0
  })
}

function compareModuleContract(
  module: FunctionalModuleBinaryInput,
  artifact: FunctionalModuleManifest['platforms'][string]['modules'][string],
): number {
  if (module.format !== undefined && artifact.format !== module.format) return 1
  if (module.entrypoint !== undefined && artifact.entrypoint !== module.entrypoint) return 1
  return 0
}

export function isLockedModule(name: FunctionalModuleName): name is LockedModuleName {
  return (LOCKED_MODULES as readonly string[]).includes(name)
}

export function lockedFunctionalModuleNames(): readonly LockedModuleName[] {
  return LOCKED_MODULES
}

function validateVersion(value: unknown, name: string, path: string): string {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`功能模块版本锁配置缺少合法 ${name} 版本：${path}`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function compareStableVersions(left: string, right: string): number {
  const parse = (value: string): [bigint, bigint, bigint] => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
    if (!match) throw new Error(`锁定模块版本必须是稳定三段式版本：${value}`)
    return [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)]
  }
  const leftParts = parse(left)
  const rightParts = parse(right)
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index]! !== rightParts[index]!) return leftParts[index]! > rightParts[index]! ? 1 : -1
  }
  return 0
}
