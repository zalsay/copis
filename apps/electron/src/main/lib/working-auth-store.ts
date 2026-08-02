import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { safeStorage } from 'electron'
import type { WorkingUser } from '@proma/shared'
import { getWorkingAuthPath } from './config-paths'
import { writeJsonFileAtomic } from './safe-file'

interface PersistedWorkingAuth {
  token?: string
  tokenEncoding?: 'safe-storage' | 'plain'
  user?: WorkingUser | null
  updatedAt?: number
}

export interface WorkingTokenStore {
  getToken(): string | null
  getUser(): WorkingUser | null
  save(token: string, user?: WorkingUser | null): void
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
    getUser: () => readPersistedAuth().user ?? null,
    save: (token, user = null) => {
      const encrypted = encryptToken(token)
      writeJsonFileAtomic(getWorkingAuthPath(), {
        token: encrypted.value,
        tokenEncoding: encrypted.encoding,
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
