import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildFunctionalModuleRelease,
  publishFunctionalModuleRelease,
  type FunctionalModuleObjectClient,
} from './functional-module-publisher'

const tempRoots: string[] = []

function createFixture(content: string, name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'copis-functional-module-publisher-'))
  tempRoots.push(root)
  const path = join(root, name)
  writeFileSync(path, content)
  return path
}

describe('COS 功能模块发布器', () => {
  afterAll(() => {
    while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true })
  })

  test('根据二进制生成不可变 URL、大小、SHA256 和平台 manifest', () => {
    const officePath = createFixture('officecli-binary', 'officecli')
    const rustPath = createFixture('rust-api-binary', 'copis-http-api-server')

    const release = buildFunctionalModuleRelease({
      channel: 'stable',
      clientMinVersion: '0.16.18',
      publicBaseUrl: 'https://download.example.com/copis/modules',
      modules: [
        { module: 'officecli', version: '1.2.3', platform: 'darwin', arch: 'arm64', binaryPath: officePath, required: false },
        { module: 'rust-http-api', version: '0.2.0', platform: 'darwin', arch: 'arm64', binaryPath: rustPath, required: true },
      ],
    })

    const platform = release.manifest.platforms['darwin-arm64']
    expect(platform?.modules.officecli).toMatchObject({
      version: '1.2.3',
      url: 'https://download.example.com/copis/modules/stable/darwin-arm64/officecli-1.2.3',
      size: Buffer.byteLength('officecli-binary'),
      sha256: createHash('sha256').update('officecli-binary').digest('hex'),
      required: false,
    })
    expect(platform?.modules['rust-http-api']?.required).toBe(true)
    expect(release.manifestEntry.key).toBe('stable/manifest.json')
  })

  test('拒绝同一平台重复发布同名模块', () => {
    const binaryPath = createFixture('duplicate', 'module')
    expect(() => buildFunctionalModuleRelease({
      channel: 'stable',
      publicBaseUrl: 'https://download.example.com/copis/modules',
      modules: [
        { module: 'officecli', version: '1.0.0', platform: 'darwin', arch: 'arm64', binaryPath, required: false },
        { module: 'officecli', version: '1.0.1', platform: 'darwin', arch: 'arm64', binaryPath, required: false },
      ],
    })).toThrow('重复')
  })

  test('缺少二进制时返回可诊断错误', () => {
    expect(() => buildFunctionalModuleRelease({
      channel: 'stable',
      publicBaseUrl: 'https://download.example.com/copis/modules',
      modules: [{
        module: 'officecli',
        version: '1.0.0',
        platform: 'darwin',
        arch: 'arm64',
        binaryPath: join(tmpdir(), 'copis-officecli-does-not-exist'),
        required: false,
      }],
    })).toThrow('功能模块二进制不存在')
  })

  test('按先二进制后 manifest 的顺序上传并校验远端 metadata', async () => {
    const binaryPath = createFixture('upload-me', 'officecli')
    const release = buildFunctionalModuleRelease({
      channel: 'stable',
      publicBaseUrl: 'https://download.example.com/copis/modules',
      modules: [{ module: 'officecli', version: '1.0.0', platform: 'darwin', arch: 'arm64', binaryPath, required: false }],
    })
    const calls: string[] = []
    const client: FunctionalModuleObjectClient = {
      async putObject(input) {
        calls.push(`put:${input.key}`)
      },
      async headObject(input) {
        calls.push(`head:${input.key}`)
        const entry = [...release.binaries, release.manifestEntry].find((item) => item.key === input.key)
        return { size: entry?.size ?? 0, sha256: entry?.sha256 }
      },
    }

    await publishFunctionalModuleRelease(release, client)

    expect(calls).toEqual([
      'put:stable/darwin-arm64/officecli-1.0.0',
      'head:stable/darwin-arm64/officecli-1.0.0',
      'put:stable/manifest.json',
      'head:stable/manifest.json',
    ])
  })

  test('为 Windows 发布带 exe 后缀的不可变对象和入口', () => {
    const rustPath = createFixture('windows-rust-api', 'copis-http-api-server.exe')

    const release = buildFunctionalModuleRelease({
      channel: 'stable',
      prefix: 'copis/modules',
      publicBaseUrl: 'https://download.example.com',
      modules: [{
        module: 'rust-http-api',
        version: '0.2.0',
        platform: 'win32',
        arch: 'x64',
        binaryPath: rustPath,
        required: true,
      }],
    })

    const artifact = release.manifest.platforms['win32-x64']?.modules['rust-http-api']
    expect(artifact).toMatchObject({
      url: 'https://download.example.com/copis/modules/stable/win32-x64/rust-http-api-0.2.0.exe',
      entrypoint: 'bin/copis-http-api-server.exe',
    })
    expect(release.binaries[0]?.key).toBe('copis/modules/stable/win32-x64/rust-http-api-0.2.0.exe')
    expect(release.manifestEntry.key).toBe('copis/modules/stable/manifest.json')
  })
})
