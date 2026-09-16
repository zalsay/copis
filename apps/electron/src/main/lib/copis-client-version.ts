import { readFileSync } from 'node:fs'

interface CopisVersionMetadata {
  copis?: {
    platformVersions?: Record<string, unknown>
  }
}

const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/

/**
 * 返回当前操作系统与架构对应的 Copis 客户端版本。
 *
 * 该版本仅用于需要主程序兼容门槛的核心模块。创造模式 DSH 有独立版本，
 * 不使用此值进行安装或更新判断。
 */
export function resolveCopisClientVersion(
  metadata: CopisVersionMetadata,
  fallbackVersion: string,
  platform = process.platform,
  arch = process.arch,
): string {
  const platformVersion = metadata.copis?.platformVersions?.[`${platform}-${arch}`]
  if (typeof platformVersion === 'string' && SEMVER_PATTERN.test(platformVersion)) {
    return platformVersion
  }

  return fallbackVersion
}

export function readCopisClientVersion(
  packagePath: string,
  fallbackVersion: string,
  platform = process.platform,
  arch = process.arch,
): string {
  try {
    const metadata = JSON.parse(readFileSync(packagePath, 'utf-8')) as CopisVersionMetadata
    return resolveCopisClientVersion(metadata, fallbackVersion, platform, arch)
  } catch (error) {
    console.warn('[版本] 读取系统客户端版本失败，回退到应用版本:', error)
    return fallbackVersion
  }
}
