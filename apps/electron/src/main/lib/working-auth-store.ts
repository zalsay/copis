import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { safeStorage } from 'electron'
import type { WorkingUser } from '@proma/shared'
import { getWorkingAuthPath } from './config-paths'
import { writeJsonFileAtomic } from './safe-file'

interface PersistedWorkingAuth {
  token?: string
  tokenEncoding?: 'safe-storage' | 'plain'
  refreshToken?: string
  refreshTokenEncoding?: 'safe-storage' | 'plain'
  user?: WorkingUser | null
  updatedAt?: number
}

export interface WorkingTokenStore {
  getToken(): string | null
  getRefreshToken(): string | null
  getUser(): WorkingUser | null
  save(token: string, user?: WorkingUser | null, refreshToken?: string | null): void
  clear(): void
}

function encryptToken(token: string): { value: string; encoding: 'safe-storage' | 'plain' } {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[Copis Working] safeStorage 不可用，将以兼容格式保存认证信息')
    return { value: token, encoding: 'plain' }
  }
  return {
    value: safeStorage.encryptString(token).toString('base64'),
    encoding: 'safe-storage',
  }
}

function decryptToken(value: string, encoding: PersistedWorkingAuth['tokenEncoding']): string | null {
  if (!value) return null
  if (encoding !== 'safe-storage' || !safeStorage.isEncryptionAvailable()) return value
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  } catch (error) {
    console.error('[Copis Working] 解密认证信息失败:', error)
    return null
  }
}

function readPersistedAuth(): PersistedWorkingAuth {
  const filePath = getWorkingAuthPath()
  if (!existsSync(filePath)) return {}
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf-8')) as PersistedWorkingAuth
    return value && typeof value === 'object' ? value : {}
  } catch (error) {
    console.error('[Copis Working] 读取认证信息失败:', error)
    return {}
  }
}

export function createWorkingTokenStore(): WorkingTokenStore {
  return {
    getToken: () => {
      const persisted = readPersistedAuth()
      return decryptToken(persisted.token ?? '', persisted.tokenEncoding)
    },
    getRefreshToken: () => {
      const persisted = readPersistedAuth()
      return decryptToken(persisted.refreshToken ?? '', persisted.refreshTokenEncoding)
    },
    getUser: () => readPersistedAuth().user ?? null,
    save: (token, user = null, refreshToken) => {
      const persisted = readPersistedAuth()
      const previousRefreshToken = decryptToken(persisted.refreshToken ?? '', persisted.refreshTokenEncoding)
      const nextRefreshToken = refreshToken === undefined ? previousRefreshToken : refreshToken
      const encrypted = encryptToken(token)
      const refreshEncrypted = nextRefreshToken ? encryptToken(nextRefreshToken) : null
      writeJsonFileAtomic(getWorkingAuthPath(), {
        token: encrypted.value,
        tokenEncoding: encrypted.encoding,
        ...(refreshEncrypted && {
          refreshToken: refreshEncrypted.value,
          refreshTokenEncoding: refreshEncrypted.encoding,
        }),
        user,
        updatedAt: Date.now(),
      })
    },
    clear: () => {
      const filePath = getWorkingAuthPath()
      if (existsSync(filePath)) unlinkSync(filePath)
    },
  }
}

const workingTokenStore = createWorkingTokenStore()

export function getWorkingTokenStore(): WorkingTokenStore {
  return workingTokenStore
}
