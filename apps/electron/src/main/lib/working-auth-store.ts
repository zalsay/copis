import { chmodSync, existsSync, readFileSync, unlinkSync } from 'node:fs'
import { safeStorage } from 'electron'
import type { WorkingUser } from '@copis/shared'
import { getConfigDir, getWorkingAuthPath } from './config-paths'
import { writeJsonFileAtomic } from './safe-file'

interface PersistedWorkingAuth {
  token?: string
  tokenEncoding?: 'safe-storage' | 'plain'
  refreshToken?: string
  refreshTokenEncoding?: 'safe-storage' | 'plain'
  provider?: WorkingAuthProvider
  user?: WorkingUser | null
  updatedAt?: number
}

export type WorkingAuthProvider = 'legacy' | 'oidc'

interface VolatileWorkingAuth {
	token: string
	refreshToken: string | null
	provider: WorkingAuthProvider
	user: WorkingUser | null
}

export interface WorkingTokenStore {
  getToken(): string | null
  getRefreshToken(): string | null
  getUser(): WorkingUser | null
  getProvider?(): WorkingAuthProvider | null
  save(token: string, user?: WorkingUser | null, refreshToken?: string | null, provider?: WorkingAuthProvider): void
  clear(): void
}

function encryptToken(token: string): string | null {
	if (!safeStorage.isEncryptionAvailable()) {
		return null
	}
	try {
		return safeStorage.encryptString(token).toString('base64')
	} catch (error) {
		console.error('[Copis Working] 加密认证信息失败:', error)
		return null
	}
}

function decryptToken(value: string, encoding: PersistedWorkingAuth['tokenEncoding']): string | null {
	if (!value) return null
	if (encoding !== 'safe-storage') return value
	if (!safeStorage.isEncryptionAvailable()) return null
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
	let volatileAuth: VolatileWorkingAuth | null = null
	const filePath = getWorkingAuthPath()

	const removeAuthArtifacts = () => {
		for (const suffix of ['', '.bak', '.tmp']) {
			const path = filePath + suffix
			if (existsSync(path)) unlinkSync(path)
		}
	}

	return {
		getToken: () => {
			if (volatileAuth) return volatileAuth.token
			const persisted = readPersistedAuth()
			return decryptToken(persisted.token ?? '', persisted.tokenEncoding)
		},
		getRefreshToken: () => {
			if (volatileAuth) return volatileAuth.refreshToken
			const persisted = readPersistedAuth()
			return decryptToken(persisted.refreshToken ?? '', persisted.refreshTokenEncoding)
		},
		getUser: () => volatileAuth?.user ?? readPersistedAuth().user ?? null,
		getProvider: () => volatileAuth?.provider ?? readPersistedAuth().provider ?? 'legacy',
		save: (token, user = null, refreshToken, provider) => {
			const persisted = readPersistedAuth()
			const previousRefreshToken = volatileAuth?.refreshToken ?? decryptToken(persisted.refreshToken ?? '', persisted.refreshTokenEncoding)
			const nextRefreshToken = refreshToken === undefined ? previousRefreshToken : refreshToken
			const nextProvider = provider ?? volatileAuth?.provider ?? persisted.provider ?? 'legacy'
			const encrypted = encryptToken(token)
			const refreshEncrypted = nextRefreshToken ? encryptToken(nextRefreshToken) : null
			if (!encrypted || (nextRefreshToken && !refreshEncrypted)) {
				console.warn('[Copis Working] safeStorage 不可用，认证信息仅保存在当前进程，不写入磁盘')
				volatileAuth = { token, refreshToken: nextRefreshToken, provider: nextProvider, user }
				removeAuthArtifacts()
				return
			}
			volatileAuth = null
			try {
				chmodSync(getConfigDir(), 0o700)
			} catch {
				// 配置目录权限由系统或已有安装负责时，不能阻塞登录。
			}
			writeJsonFileAtomic(getWorkingAuthPath(), {
				token: encrypted,
				tokenEncoding: 'safe-storage',
				...(refreshEncrypted && {
					refreshToken: refreshEncrypted,
					refreshTokenEncoding: 'safe-storage',
				}),
				provider: nextProvider,
				user,
				updatedAt: Date.now(),
			}, true, 0o600)
			for (const suffix of ['.bak', '.tmp']) {
				const path = filePath + suffix
				if (existsSync(path)) unlinkSync(path)
			}
		},
		clear: () => {
			volatileAuth = null
			removeAuthArtifacts()
		},
	}
}

const workingTokenStore = createWorkingTokenStore()

export function getWorkingTokenStore(): WorkingTokenStore {
  return workingTokenStore
}
