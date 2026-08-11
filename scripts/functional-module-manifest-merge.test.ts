import { describe, expect, test } from 'bun:test'
import type { FunctionalModuleManifest } from '@copis/shared'
import { mergeFunctionalModuleManifests } from './functional-module-manifest-merge'

function artifact(version: string) {
  return {
    version,
    url: `https://download.example.com/${version}`,
    sha256: 'a'.repeat(64),
    size: 1,
    format: 'binary' as const,
    entrypoint: 'bin/officecli',
    required: false,
  }
}

describe('功能模块 manifest 合并', () => {
  test('保留已有平台，并采用更高的最低客户端版本', () => {
    const existing: FunctionalModuleManifest = {
      schema: 1,
      channel: 'stable',
      client: { minVersion: '0.0.4' },
      platforms: {
        'darwin-arm64': { modules: { officecli: artifact('1.0.143') } },
      },
    }
    const incoming: FunctionalModuleManifest = {
      schema: 1,
      channel: 'stable',
      client: { minVersion: '0.16.13' },
      platforms: {
        'win32-x64': { modules: { officecli: artifact('1.0.143') } },
      },
    }

    const merged = mergeFunctionalModuleManifests(existing, incoming)

    expect(Object.keys(merged.platforms)).toEqual(['darwin-arm64', 'win32-x64'])
    expect(merged.platforms['darwin-arm64']?.modules.officecli.version).toBe('1.0.143')
    expect(merged.platforms['win32-x64']?.modules.officecli.version).toBe('1.0.143')
    expect(merged.client?.minVersion).toBe('0.16.13')
  })

  test('新 manifest 未提高版本门槛时保留已有最低客户端版本', () => {
    const existing: FunctionalModuleManifest = {
      schema: 1,
      channel: 'stable',
      client: { minVersion: '0.0.52' },
      platforms: {},
    }
    const incoming: FunctionalModuleManifest = {
      schema: 1,
      channel: 'stable',
      client: { minVersion: '0.0.4' },
      platforms: {},
    }

    const merged = mergeFunctionalModuleManifests(existing, incoming)

    expect(merged.client?.minVersion).toBe('0.0.52')
  })
})
