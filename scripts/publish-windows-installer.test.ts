import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import type { FunctionalModuleObjectClient, FunctionalModuleObjectUpload } from './functional-module-publisher'
import {
  buildWindowsInstallerUpload,
  publishWindowsInstaller,
} from './publish-windows-installer'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Windows 固定安装程序发布', () => {
  test('生成不带版本号的稳定下载地址并计算校验值', () => {
    const directory = mkdtempSync(join(tmpdir(), 'copis-installer-test-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'Copis-Setup.exe')
    writeFileSync(filePath, Buffer.from('installer'))

    const upload = buildWindowsInstallerUpload({
      filePath,
      objectKey: 'copis/downloads/stable/win32-x64/Copis-Setup.exe',
      publicBaseUrl: 'https://download.example.com/',
      version: '0.0.19',
    })

    expect(upload.url).toBe('https://download.example.com/copis/downloads/stable/win32-x64/Copis-Setup.exe')
    expect(upload.size).toBe(9)
    expect(upload.sha256).toBe('9c0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c')
    expect(upload.version).toBe('0.0.19')
  })

  test('固定对象显式允许覆盖并在上传后校验 COS 内容', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'copis-installer-test-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'Copis-Setup.exe')
    writeFileSync(filePath, Buffer.from('installer'))
    const upload = buildWindowsInstallerUpload({
      filePath,
      objectKey: 'copis/downloads/stable/win32-x64/Copis-Setup.exe',
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

    await publishWindowsInstaller(upload, client)

    expect(uploaded).toMatchObject({
      key: upload.key,
      allowOverwrite: true,
      cacheControl: 'no-cache, max-age=0, must-revalidate',
      contentDisposition: 'attachment; filename="Copis-Setup.exe"',
      metadata: { sha256: upload.sha256 },
    })
  })

  test('拒绝带目录穿越或查询字符的 COS key', () => {
    const directory = mkdtempSync(join(tmpdir(), 'copis-installer-test-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'Copis-Setup.exe')
    writeFileSync(filePath, Buffer.from('installer'))

    expect(() => buildWindowsInstallerUpload({
      filePath,
      objectKey: '../Copis-Setup.exe',
      publicBaseUrl: 'https://download.example.com',
    })).toThrow('COS 对象 key 不合法')
  })
})
