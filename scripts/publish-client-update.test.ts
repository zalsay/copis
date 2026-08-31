import { describe, expect, test } from 'bun:test'
import type { FunctionalModuleManifest } from '@copis/shared'
import type { FunctionalModuleObjectClient } from './functional-module-publisher'
import { buildClientUpdateManifest, publishClientUpdate } from './publish-client-update'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function createManifest(): FunctionalModuleManifest {
  return {
    schema: 1,
    channel: 'stable',
    client: {
      minVersion: '0.0.65',
      update: {
        version: '0.0.63',
        url: 'https://download.example.com/copis/downloads/stable/win32-x64/old.exe',
        sha256: 'a'.repeat(64),
        size: 1,
      },
      updates: {
        'darwin-arm64': {
          version: '0.0.64',
          url: 'https://download.example.com/Copis-arm64.dmg',
          sha256: 'e'.repeat(64),
          size: 2,
        },
      },
    },
    platforms: {
      'darwin-arm64': { modules: { officecli: {
        version: '1.0.143',
        url: 'https://download.example.com/officecli',
        sha256: 'b'.repeat(64),
        size: 2,
        format: 'binary',
        entrypoint: 'bin/officecli',
        required: true,
      } } },
      'win32-x64': { modules: { rust: {
        version: '0.0.1',
        url: 'https://download.example.com/rust',
        sha256: 'c'.repeat(64),
        size: 3,
        format: 'binary',
        entrypoint: 'bin/rust',
        required: true,
      } } },
    },
  }
}

describe('主程序更新 manifest 发布', () => {
  test('只更新目标平台的 client.updates 并保留其他平台更新', () => {
    const existing = createManifest()
    const result = buildClientUpdateManifest(existing, {
      version: '0.0.66',
      url: 'https://download.example.com/Copis-x64.AppImage',
      sha256: 'd'.repeat(64),
      size: 4,
    }, 'linux', 'x64')

    expect(result.client?.minVersion).toBe('0.0.65')
    expect(result.client?.update?.version).toBe('0.0.63')
    expect(result.client?.updates?.['darwin-arm64']?.version).toBe('0.0.64')
    expect(result.client?.updates?.['win32-x64']?.version).toBe('0.0.63')
    expect(result.client?.updates?.['linux-x64']?.version).toBe('0.0.66')
    expect(result.platforms).toEqual(existing.platforms)
  })

  test('读取当前 manifest、计算安装包信息并覆盖 COS manifest', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'copis-client-update-'))
    try {
      const installerPath = join(directory, 'Copis-Setup.exe')
      writeFileSync(installerPath, 'installer-0.0.66')
      let uploaded: { key: string; body: Buffer } | undefined
      const client: FunctionalModuleObjectClient = {
        async putObject(input) { uploaded = { key: input.key, body: input.body } },
        async headObject({ key }) {
          const body = uploaded?.body
          if (!body || uploaded?.key !== key) throw new Error('missing upload')
          return { size: body.byteLength, sha256: (await import('node:crypto')).createHash('sha256').update(body).digest('hex') }
        },
      }
      const result = await publishClientUpdate({
        installerPath,
        version: '0.0.66',
        installerUrl: 'https://download.example.com/copis/downloads/stable/win32-x64/Copis-Setup.exe',
        publicBaseUrl: 'https://download.example.com',
        platform: 'win32',
        arch: 'x64',
      }, client, async () => new Response(JSON.stringify(createManifest()), { status: 200 }))

      const manifest = JSON.parse(uploaded!.body.toString('utf8')) as FunctionalModuleManifest
      expect(result.version).toBe('0.0.66')
      expect(result.manifestUrl).toBe('https://download.example.com/copis/client/stable/manifest.json')
      expect(manifest.client?.update?.version).toBe('0.0.63')
      expect(manifest.client?.updates?.['darwin-arm64']?.version).toBe('0.0.64')
      expect(manifest.client?.updates?.['win32-x64']?.version).toBe('0.0.66')
      expect(manifest.platforms['darwin-arm64']).toBeDefined()
      expect(manifest.platforms['win32-x64']).toBeDefined()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('拒绝将线上较新的客户端版本降级', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'copis-client-update-'))
    try {
      const installerPath = join(directory, 'Copis-Setup.exe')
      writeFileSync(installerPath, 'installer-0.0.65')
      const client: FunctionalModuleObjectClient = {
        async putObject() { throw new Error('不应上传降级 manifest') },
        async headObject() { return { size: 0 } },
      }
      const existing = createManifest()
      existing.client!.updates!['win32-x64'] = {
        version: '0.0.66',
        url: 'https://download.example.com/Copis-Setup.exe',
        sha256: 'f'.repeat(64),
        size: 3,
      }

      await expect(publishClientUpdate({
        installerPath,
        version: '0.0.65',
        installerUrl: 'https://download.example.com/Copis-Setup.exe',
        publicBaseUrl: 'https://download.example.com',
        platform: 'win32',
        arch: 'x64',
      }, client, async () => new Response(JSON.stringify(existing), { status: 200 }))).rejects
        .toThrow('拒绝降级')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('迁移旧全局字段时仍拒绝目标平台降级', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'copis-client-update-'))
    try {
      const installerPath = join(directory, 'Copis-Setup.exe')
      writeFileSync(installerPath, 'installer-0.0.62')
      const client: FunctionalModuleObjectClient = {
        async putObject() { throw new Error('不应上传降级 manifest') },
        async headObject() { return { size: 0 } },
      }
      const existing = createManifest()
      existing.client!.updates = { 'darwin-arm64': existing.client!.updates!['darwin-arm64']! }
      existing.client!.update!.version = '0.0.66'

      await expect(publishClientUpdate({
        installerPath,
        version: '0.0.65',
        installerUrl: 'https://download.example.com/copis/downloads/stable/win32-x64/Copis-Setup.exe',
        publicBaseUrl: 'https://download.example.com',
        platform: 'win32',
        arch: 'x64',
      }, client, async () => new Response(JSON.stringify(existing), { status: 200 }))).rejects
        .toThrow('拒绝降级')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('拒绝将 Windows 安装包发布到 macOS 平台', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'copis-client-update-'))
    try {
      const installerPath = join(directory, 'Copis-Setup.exe')
      writeFileSync(installerPath, 'installer')
      const client: FunctionalModuleObjectClient = {
        async putObject() { throw new Error('不应上传平台不匹配的安装包') },
        async headObject() { return { size: 0 } },
      }

      await expect(publishClientUpdate({
        installerPath,
        version: '0.0.66',
        installerUrl: 'https://download.example.com/Copis-Setup.exe',
        publicBaseUrl: 'https://download.example.com',
        platform: 'darwin',
        arch: 'arm64',
      }, client, async () => new Response(JSON.stringify(createManifest()), { status: 200 }))).rejects
        .toThrow('平台不匹配')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
