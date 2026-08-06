import { describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

mock.module('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/copis-file-service-test',
  },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  shell: {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}))

const { createFileService, FileServiceError } = await import('./file-service')

describe('过渡文件 HTTP 服务', () => {
  test('Given 授权文件 When 读取和写入 Then 返回内容与 revision', () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-file-service-'))
    const filePath = join(root, 'note.md')
    writeFileSync(filePath, '# 初始', 'utf8')
    const service = createFileService({
      resolvePath: (path) => path,
      isAllowed: (path) => path.startsWith(root),
      stat: (path) => statSync(path),
      read: (path) => readFileSync(path, 'utf8'),
      write: (path, content) => writeFileSync(path, content, 'utf8'),
    })

    try {
      const before = service.readText({ path: filePath })
      expect(before.content).toBe('# 初始')
      expect(before.revision).toContain('size:')
      const after = service.writeText({ path: filePath, content: '# 更新', expectedRevision: before.revision })
      expect(after.resolvedPath).toBe(filePath)
      expect(service.readText({ path: filePath }).content).toBe('# 更新')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Given 旧 revision When 写入 Then 拒绝并保留原文件', () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-file-service-conflict-'))
    const filePath = join(root, 'note.md')
    writeFileSync(filePath, '原内容', 'utf8')
    const service = createFileService({
      resolvePath: (path) => path,
      isAllowed: () => true,
      stat: (path) => statSync(path),
      read: (path) => readFileSync(path, 'utf8'),
      write: (path, content) => writeFileSync(path, content, 'utf8'),
    })

    try {
      const revision = service.readText({ path: filePath }).revision
      writeFileSync(filePath, '外部修改', 'utf8')
      expect(() => service.writeText({ path: filePath, content: '覆盖', expectedRevision: revision })).toThrow(FileServiceError)
      expect(readFileSync(filePath, 'utf8')).toBe('外部修改')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Given 越界文件 When 读取 Then 返回 path_not_allowed', () => {
    const service = createFileService({
      resolvePath: (path) => path,
      isAllowed: () => false,
      stat: (path) => statSync(path),
      read: (path) => readFileSync(path, 'utf8'),
      write: (path, content) => writeFileSync(path, content, 'utf8'),
    })

    try {
      service.readText({ path: '/tmp/secret.txt' })
      throw new Error('expected path_not_allowed')
    } catch (error) {
      expect(error).toBeInstanceOf(FileServiceError)
      expect(error).toMatchObject({ code: 'path_not_allowed', status: 403 })
    }
  })
})
