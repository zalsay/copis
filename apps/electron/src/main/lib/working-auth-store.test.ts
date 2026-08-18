import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

let tempHome = ''
let authPath = ''
let safeStorageAvailable = false
let createWorkingTokenStore: typeof import('./working-auth-store').createWorkingTokenStore

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(tempHome, 'Library', 'Application Support'),
  },
  safeStorage: {
    isEncryptionAvailable: () => safeStorageAvailable,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'copis-working-auth-'))
  const configPaths = await import('./config-paths')
  authPath = configPaths.getWorkingAuthPath()
  ;({ createWorkingTokenStore } = await import('./working-auth-store'))
})

beforeEach(() => {
  safeStorageAvailable = false
  rmSync(join(tempHome, '.copis'), { recursive: true, force: true })
  mkdirSync(join(tempHome, '.copis'), { recursive: true })
})

afterAll(() => {
  rmSync(tempHome, { recursive: true, force: true })
})

describe('Copis Working 认证存储', () => {
  test('safeStorage 不可用时只保存在当前进程，不把 token 明文写入磁盘', () => {
    const store = createWorkingTokenStore()
    store.save('access-token', { id: 7, email: 'user@example.com' }, 'refresh-token', 'oidc')

    expect(store.getProvider?.()).toBe('oidc')
    expect(store.getToken()).toBe('access-token')
    expect(store.getRefreshToken()).toBe('refresh-token')
    expect(existsSync(authPath)).toBe(false)
  })

  test('safeStorage 可用时以 0600 写入加密 token 且不保留备份', () => {
    safeStorageAvailable = true
    const store = createWorkingTokenStore()
    store.save('first-token', null, 'first-refresh', 'oidc')
    store.save('second-token', { id: 8, email: 'next@example.com' }, 'second-refresh', 'oidc')

    expect(store.getToken()).toBe('second-token')
    expect(statSync(authPath).mode & 0o777).toBe(0o600)
    expect(existsSync(`${authPath}.bak`)).toBe(false)
    expect(existsSync(`${authPath}.tmp`)).toBe(false)
    expect(JSON.parse(readFileSync(authPath, 'utf-8'))).toEqual(expect.objectContaining({
      provider: 'oidc',
      tokenEncoding: 'safe-storage',
      refreshTokenEncoding: 'safe-storage',
    }))
  })

  test('旧认证文件没有 provider 时按 legacy 兼容', () => {
    writeFileSync(authPath, JSON.stringify({ token: 'legacy-token', tokenEncoding: 'plain', user: null }))
    const store = createWorkingTokenStore()

    expect(store.getProvider?.()).toBe('legacy')
    expect(store.getToken()).toBe('legacy-token')
    expect(existsSync(authPath)).toBe(true)
  })
})
