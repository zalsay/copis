import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import type { FunctionalModuleObjectClient, FunctionalModuleObjectUpload } from './functional-module-publisher'
import { buildAppUpdateUploads, publishAppUpdates } from './publish-app-updates'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function createUpdateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'copis-app-updates-'))
  directories.push(directory)
  writeFileSync(join(directory, 'Copis Setup 0.0.61.exe'), 'installer')
  writeFileSync(join(directory, 'Copis Setup 0.0.61.exe.blockmap'), 'blockmap')
  writeFileSync(join(directory, 'latest.yml'), [
    'version: 0.0.61',
    'files:',
    '  - url: Copis Setup 0.0.61.exe',
    '    sha512: abc',
    'path: Copis Setup 0.0.61.exe',
    'sha512: abc',
  ].join('\n'))
  return directory
}

describe('Electron 自动更新 COS 发布', () => {
  test('Given electron-builder 产物 When 构建上传列表 Then 先上传版本文件并最后覆盖 latest.yml', () => {
    const uploads = buildAppUpdateUploads(createUpdateDirectory())

    expect(uploads.map((upload) => upload.key)).toEqual([
      'copis/updates/stable/Copis Setup 0.0.61.exe',
      'copis/updates/stable/Copis Setup 0.0.61.exe.blockmap',
      'copis/updates/stable/latest.yml',
    ])
    expect(uploads[0]).toMatchObject({ allowOverwrite: false, cacheControl: 'public, max-age=31536000, immutable' })
    expect(uploads[2]).toMatchObject({ allowOverwrite: true, cacheControl: 'no-cache, max-age=0, must-revalidate' })
  })

  test('Given 清单引用不存在的安装包 When 构建上传列表 Then 拒绝发布', () => {
    const directory = createUpdateDirectory()
    writeFileSync(join(directory, 'latest.yml'), 'path: missing.exe\n')
    expect(() => buildAppUpdateUploads(directory)).toThrow('更新清单引用的文件不存在')
  })

  test('Given 上传列表 When 发布 Then 每个对象写入 SHA-256 并回读校验', async () => {
    const uploads = buildAppUpdateUploads(createUpdateDirectory())
    const written: FunctionalModuleObjectUpload[] = []
    const client: FunctionalModuleObjectClient = {
      async putObject(input) { written.push(input) },
      async headObject({ key }) {
        const upload = uploads.find((item) => item.key === key)!
        return { size: upload.size, sha256: upload.sha256 }
      },
    }

    await publishAppUpdates(uploads, client)
    expect(written.map((upload) => upload.key)).toEqual(uploads.map((upload) => upload.key))
    expect(written.every((upload) => /^[a-f0-9]{64}$/.test(upload.metadata.sha256 ?? ''))).toBe(true)
  })
})
