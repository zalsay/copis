import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import type { FunctionalModuleObjectClient, FunctionalModuleObjectUpload } from './functional-module-publisher'
import {
  DEFAULT_MACOS_ARM64_INSTALLER_OBJECT_KEY,
  DEFAULT_MACOS_X64_INSTALLER_OBJECT_KEY,
  buildMacosInstallerUpload,
  publishMacosInstaller,
} from './publish-macos-installer'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createInstallerFile(filename: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'copis-macos-installer-test-'))
  temporaryDirectories.push(directory)
  const filePath = join(directory, filename)
  writeFileSync(filePath, Buffer.from('installer'))
  return filePath
}

describe('macOS 固定安装程序发布', () => {
  test('arm64 生成不带版本号的稳定下载地址并计算校验值', () => {
    const upload = buildMacosInstallerUpload({
      filePath: createInstallerFile('Copis-arm64.dmg'),
      arch: 'arm64',
      objectKey: DEFAULT_MACOS_ARM64_INSTALLER_OBJECT_KEY,
      publicBaseUrl: 'https://download.example.com/',
      version: '0.0.19',
    })

    expect(upload.url).toBe('https://download.example.com/copis/downloads/stable/darwin-arm64/Copis-arm64.dmg')
    expect(upload.filename).toBe('Copis-arm64.dmg')
    expect(upload.size).toBe(9)
    expect(upload.sha256).toBe('9c0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c')
    expect(upload.version).toBe('0.0.19')
  })

  test('x64 默认使用 darwin-x64 固定对象路径', () => {
    const upload = buildMacosInstallerUpload({
      filePath: createInstallerFile('Copis-x64.dmg'),
      arch: 'x64',
      publicBaseUrl: 'https://download.example.com',
    })

    expect(upload.url).toBe('https://download.example.com/copis/downloads/stable/darwin-x64/Copis-x64.dmg')
  })

  test('固定对象显式允许覆盖并在上传后校验 COS 内容', async () => {
    const upload = buildMacosInstallerUpload({
      filePath: createInstallerFile('Copis-arm64.dmg'),
      arch: 'arm64',
      objectKey: DEFAULT_MACOS_ARM64_INSTALLER_OBJECT_KEY,
      publicBaseUrl: 'https://download.example.com',
    })
    let uploaded: FunctionalModuleObjectUpload | undefined
    const client: FunctionalModuleObjectClient = {
      async putObject(input) {
        uploaded = input
      },
      async headObject() {
        return { size: upload.size, sha256: upload.sha256 }
      },
    }

    await publishMacosInstaller(upload, client)

    expect(uploaded).toMatchObject({
      key: upload.key,
      allowOverwrite: true,
      cacheControl: 'no-cache, max-age=0, must-revalidate',
      contentType: 'application/x-apple-diskimage',
      contentDisposition: 'attachment; filename="Copis-arm64.dmg"',
      metadata: { sha256: upload.sha256 },
    })
  })

  test('拒绝带目录穿越或查询字符的 COS key', () => {
    expect(() => buildMacosInstallerUpload({
      filePath: createInstallerFile('Copis-arm64.dmg'),
      arch: 'arm64',
      objectKey: '../Copis-arm64.dmg',
      publicBaseUrl: 'https://download.example.com',
    })).toThrow('COS 对象 key 不合法')
  })
})
