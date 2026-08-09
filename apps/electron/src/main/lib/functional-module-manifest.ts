import type {
  FunctionalModuleArchitecture,
  FunctionalModuleArtifact,
  FunctionalModuleFormat,
  FunctionalModuleManifest,
  FunctionalModuleManifestArtifact,
  FunctionalModuleName,
  FunctionalModulePlatform,
} from '@copis/shared'

const SUPPORTED_SCHEMA = 1
const MANIFEST_ENV = 'COPIS_FUNCTIONAL_MODULE_MANIFEST_URL'
declare const __COPIS_FUNCTIONAL_MODULE_MANIFEST_URL__: string | undefined

export function parseFunctionalModuleManifest(
  json: string,
  clientVersion: string,
  platform: FunctionalModulePlatform,
  arch: FunctionalModuleArchitecture,
): FunctionalModuleArtifact[] {
  let value: unknown
  try {
    value = JSON.parse(json) as unknown
  } catch (error) {
    throw new Error('功能模块 manifest 不是有效的 JSON', { cause: error })
  }

  const manifest = asManifest(value)
  if (manifest.schema !== SUPPORTED_SCHEMA) {
    throw new Error(`功能模块 manifest 版本不支持: ${String(manifest.schema)}`)
  }
  if (manifest.client?.minVersion && compareSemver(clientVersion, manifest.client.minVersion) < 0) {
    throw new Error(`Copis 版本过低，需要至少 ${manifest.client.minVersion}`)
  }

  const platformKey = `${platform}-${arch}`
  const target = manifest.platforms[platformKey]
  if (!target) throw new Error(`manifest 没有当前平台的功能模块: ${platformKey}`)

  return Object.entries(target.modules).map(([name, artifact]) => {
    validateModuleName(name)
    validateManifestArtifact(name, artifact)
    return {
      name: name as FunctionalModuleName,
      version: artifact.version,
      platform,
      arch,
      url: artifact.url,
      sha256: artifact.sha256.toLowerCase(),
      size: artifact.size,
      format: artifact.format,
      entrypoint: artifact.entrypoint,
      required: artifact.required,
    }
  })
}

export function getFunctionalModuleManifestUrl(): string | undefined {
  const value = process.env[MANIFEST_ENV]?.trim()
  if (value) return value

  if (typeof __COPIS_FUNCTIONAL_MODULE_MANIFEST_URL__ === 'string') {
    const builtValue = __COPIS_FUNCTIONAL_MODULE_MANIFEST_URL__.trim()
    if (builtValue) return builtValue
  }

  return undefined
}

function asManifest(value: unknown): FunctionalModuleManifest {
  if (!isRecord(value)) throw new Error('功能模块 manifest 顶层必须是对象')
  if (typeof value.schema !== 'number' || !Number.isInteger(value.schema)) {
    throw new Error('功能模块 manifest 缺少合法 schema')
  }
  if (typeof value.channel !== 'string' || !value.channel.trim()) {
    throw new Error('功能模块 manifest 缺少 channel')
  }
  if (!isRecord(value.platforms)) throw new Error('功能模块 manifest 缺少 platforms')

  const platforms: Record<string, { modules: Record<string, FunctionalModuleManifestArtifact> }> = {}
  for (const [platformKey, platformValue] of Object.entries(value.platforms)) {
    if (!isRecord(platformValue) || !isRecord(platformValue.modules)) {
      throw new Error(`功能模块平台缺少 modules: ${platformKey}`)
    }
    platforms[platformKey] = {
      modules: platformValue.modules as Record<string, FunctionalModuleManifestArtifact>,
    }
  }

  const client = isRecord(value.client) && typeof value.client.minVersion === 'string'
    ? { minVersion: value.client.minVersion }
    : undefined
  return {
    schema: value.schema,
    channel: value.channel,
    ...(client ? { client } : {}),
    platforms,
  }
}

function validateManifestArtifact(name: string, artifact: FunctionalModuleManifestArtifact): void {
  if (!isRecord(artifact)) throw new Error(`功能模块 ${name} artifact 必须是对象`)
  if (!isSafeModuleValue(artifact.version)) throw new Error(`功能模块 ${name} version 不合法`)
  if (!isSafeUrl(artifact.url)) throw new Error(`功能模块 URL 必须使用 HTTPS: ${name}`)
  if (typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) {
    throw new Error(`功能模块 ${name} sha256 不合法`)
  }
  if (!Number.isSafeInteger(artifact.size) || artifact.size < 0) {
    throw new Error(`模块 size 不合法: ${name}`)
  }
  if (artifact.format !== 'binary' && artifact.format !== 'tar.gz') {
    throw new Error(`功能模块 format 不支持: ${name}`)
  }
  if (typeof artifact.entrypoint !== 'string' || !isSafeRelativePath(artifact.entrypoint)) {
    throw new Error(`功能模块 entrypoint 不安全: ${name}`)
  }
  if (typeof artifact.required !== 'boolean') throw new Error(`功能模块 required 不合法: ${name}`)
}

function validateModuleName(name: string): void {
  if (!isSafeModuleValue(name)) throw new Error(`功能模块名称不合法: ${name}`)
}

function isSafeModuleValue(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.includes('\0') || value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)) return false
  const normalized = value.replaceAll('\\', '/')
  return normalized !== '.'
    && normalized !== '..'
    && !normalized.startsWith('../')
    && !normalized.includes('/../')
}

function isSafeUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    const url = new URL(value)
    if (url.protocol === 'https:') return true
    if (url.protocol !== 'http:') return false
    return url.hostname === 'localhost'
      || url.hostname === '127.0.0.1'
      || url.hostname === '[::1]'
      || url.hostname === '::1'
  } catch {
    return false
  }
}

function compareSemver(left: string, right: string): number {
  const leftParts = parseSemver(left)
  const rightParts = parseSemver(right)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function parseSemver(value: string): number[] {
  const [normalized] = value.trim().replace(/^v/i, '').split('-', 1)
  if (!normalized) throw new Error(`版本号不合法: ${value}`)
  const parts = normalized.split('.')
  if (parts.length === 0 || parts.some((part) => !/^\d+$/.test(part))) {
    throw new Error(`版本号不合法: ${value}`)
  }
  return parts.map((part) => Number(part))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
