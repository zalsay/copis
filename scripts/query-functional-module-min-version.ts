#!/usr/bin/env bun

import type {
  FunctionalModuleArchitecture,
  FunctionalModulePlatform,
} from '@copis/shared'

export function getPlatformMinClientVersion(
  value: unknown,
  platform: FunctionalModulePlatform,
  arch: FunctionalModuleArchitecture,
): string | undefined {
  if (!isRecord(value) || !isRecord(value.platforms)) {
    throw new Error('功能模块 manifest 缺少 platforms')
  }

  const platformKey = `${platform}-${arch}`
  const target = value.platforms[platformKey]
  if (!isRecord(target) || !isRecord(target.modules)) {
    throw new Error(`功能模块 manifest 没有当前平台: ${platformKey}`)
  }

  const platformMinVersion = readVersion(target.minClientVersion, `平台最低客户端版本: ${platformKey}`)
  const client = isRecord(value.client) ? value.client : undefined
  const globalMinVersion = readVersion(client?.minVersion, '全局最低客户端版本')
  return platformMinVersion ?? globalMinVersion
}

export function compareClientVersions(left: string, right: string): number {
  const leftParts = parseVersion(left)
  const rightParts = parseVersion(right)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

export async function fetchPlatformMinClientVersion(
  manifestUrl: string,
  platform: FunctionalModulePlatform,
  arch: FunctionalModuleArchitecture,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const response = await fetchImpl(manifestUrl, {
    redirect: 'follow',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Copis-Build-Script',
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    throw new Error(`获取功能模块 manifest 失败: HTTP ${response.status}（${manifestUrl}）`)
  }

  let value: unknown
  try {
    value = await response.json() as unknown
  } catch (error) {
    throw new Error(`功能模块 manifest 不是有效 JSON（${manifestUrl}）`, { cause: error })
  }
  return getPlatformMinClientVersion(value, platform, arch)
}

function parseVersion(value: string): number[] {
  const [stable] = value.trim().split('-', 1)
  return stable.split('.').map(Number)
}

function readVersion(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.trim())) {
    throw new Error(`${label}不合法`)
  }
  return value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value?.trim() || undefined
}

function parsePlatform(value: string | undefined): FunctionalModulePlatform {
  if (value === 'darwin' || value === 'linux' || value === 'win32') return value
  throw new Error(`当前平台不支持功能模块查询: ${value ?? '<empty>'}`)
}

function parseArchitecture(value: string | undefined): FunctionalModuleArchitecture {
  if (value === 'arm64' || value === 'x64') return value
  throw new Error(`当前架构不支持功能模块查询: ${value ?? '<empty>'}`)
}

if (import.meta.main) {
  const manifestUrl = option('--url') ?? process.env.COPIS_FUNCTIONAL_MODULE_MANIFEST_URL?.trim()
  if (!manifestUrl) throw new Error('缺少 --url 或 COPIS_FUNCTIONAL_MODULE_MANIFEST_URL')
  const platform = parsePlatform(option('--platform'))
  const arch = parseArchitecture(option('--arch'))
  const minVersion = await fetchPlatformMinClientVersion(manifestUrl, platform, arch)
  if (minVersion) console.log(minVersion)
}
