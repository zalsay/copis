import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

let tempHome = ''

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(tempHome, 'Library', 'Application Support'),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

mock.module('./safe-file', () => ({
  writeJsonFileAtomic: () => {
    throw new Error('模拟认证文件不可写')
  },
}))

beforeAll(() => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'copis-working-auth-persistence-'))
})

afterAll(() => {
  rmSync(tempHome, { recursive: true, force: true })
})

const { createWorkingTokenStore } = await import('./working-auth-store')

describe('Copis Working 认证存储持久化降级', () => {
  test('认证文件写入失败时保留当前进程凭据，不阻断登录', () => {
    const store = createWorkingTokenStore()

    expect(() => store.save(
      'access-token',
      { id: 7, email: 'user@example.com' },
      'refresh-token',
      'oidc',
    )).not.toThrow()

    expect(store.getToken()).toBe('access-token')
    expect(store.getRefreshToken()).toBe('refresh-token')
    expect(existsSync(join(tempHome, '.copis', 'working-auth.json'))).toBe(false)
  })
})
