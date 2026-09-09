import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const electronPackagePath = fileURLToPath(new URL('../apps/electron/package.json', import.meta.url))

export interface ElectronVersionMetadata {
  version: string
  copis?: { platformVersions?: Record<string, string>; [key: string]: unknown }
  [key: string]: unknown
}

export function validateElectronVersion(version: string): string {
  const normalized = version.trim()
  if (!/^\d+\.\d+\.\d+$/.test(normalized) || normalized.split('.').some(part => !Number.isSafeInteger(Number(part)))) {
    throw new Error(`Electron 应用版本必须是三段式 semver：${version}`)
  }
  return normalized
}

export function electronPlatformKey(platform: string, arch: string): string {
  if (!['darwin', 'win32', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
    throw new Error(`不支持的 Electron 构建平台：${platform}-${arch}`)
  }
  return `${platform}-${arch}`
}

export function resolveElectronVersion(metadata: ElectronVersionMetadata, platform: string, arch: string): string {
  const key = electronPlatformKey(platform, arch)
  return validateElectronVersion(metadata.copis?.platformVersions?.[key] ?? metadata.version)
}

export function readElectronVersion(platform: string, arch: string, packagePath = electronPackagePath): string {
  return resolveElectronVersion(JSON.parse(readFileSync(packagePath, 'utf8')), platform, arch)
}
