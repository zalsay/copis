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
  expiresAt?: number | null
}

export interface RustWorkingAuthRecord {
  accessToken: string
  refreshToken?: string | null
  provider: WorkingAuthProvider
  user?: WorkingUser | null
  expiresAt?: number | null
}

export type WorkingAuthProvider = 'legacy' | 'oidc'

interface VolatileWorkingAuth {
	token: string
	refreshToken: string | null
	provider: WorkingAuthProvider
	user: WorkingUser | null
	expiresAt: number | null
}

export interface WorkingTokenStore {
  getToken(): string | null
  getRefreshToken(): string | null
  getUser(): WorkingUser | null
  getProvider?(): WorkingAuthProvider | null
  getExpiresAt?(): number | null
  save(token: string, user?: WorkingUser | null, refreshToken?: string | null, provider?: WorkingAuthProvider, expiresAt?: number | null): void
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
		getExpiresAt: () => volatileAuth?.expiresAt ?? readPersistedAuth().expiresAt ?? null,
		save: (token, user = null, refreshToken, provider, expiresAt) => {
			const persisted = readPersistedAuth()
			const previousRefreshToken = volatileAuth?.refreshToken ?? decryptToken(persisted.refreshToken ?? '', persisted.refreshTokenEncoding)
			const nextRefreshToken = refreshToken === undefined ? previousRefreshToken : refreshToken
			const nextProvider = provider ?? volatileAuth?.provider ?? persisted.provider ?? 'legacy'
			const nextExpiresAt = expiresAt === undefined ? (volatileAuth?.expiresAt ?? persisted.expiresAt ?? null) : expiresAt
			const saveVolatile = (message: string, error?: unknown) => {
				volatileAuth = { token, refreshToken: nextRefreshToken, provider: nextProvider, user, expiresAt: nextExpiresAt }
				if (existsSync(filePath + '.tmp')) {
					try { unlinkSync(filePath + '.tmp') } catch { /* 临时文件清理失败不影响当前会话 */ }
				}
				if (error === undefined) {
					console.warn(`[Copis Working] ${message}`)
				} else {
					console.warn(`[Copis Working] ${message}`, error instanceof Error ? error.message : error)
				}
			}
			const encrypted = encryptToken(token)
			const refreshEncrypted = nextRefreshToken ? encryptToken(nextRefreshToken) : null
			if (!encrypted || (nextRefreshToken && !refreshEncrypted)) {
				saveVolatile('safeStorage 不可用，认证信息仅保存在当前进程，不写入磁盘')
				removeAuthArtifacts()
				return
			}
			volatileAuth = null
			try {
				chmodSync(getConfigDir(), 0o700)
			} catch {
				// 配置目录权限由系统或已有安装负责时，不能阻塞登录。
			}
			try {
				writeJsonFileAtomic(getWorkingAuthPath(), {
					token: encrypted,
					tokenEncoding: 'safe-storage',
					...(refreshEncrypted && {
						refreshToken: refreshEncrypted,
						refreshTokenEncoding: 'safe-storage',
					}),
					provider: nextProvider,
					user,
					expiresAt: nextExpiresAt,
					updatedAt: Date.now(),
				}, true, 0o600)
				for (const suffix of ['.bak', '.tmp']) {
					const path = filePath + suffix
					if (existsSync(path)) unlinkSync(path)
				}
			} catch (error) {
				saveVolatile('本地认证文件写入失败，认证信息仅保存在当前进程', error)
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

function sanitizeWorkingUserForRust(value: WorkingUser | null): WorkingUser | null {
  if (!value || typeof value !== 'object') return null
  const sanitized: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(value as unknown as Record<string, unknown>)) {
    if (/password|secret|credential|token/i.test(key)) continue
    sanitized[key] = field
  }
  return sanitized as WorkingUser
}

/** 仅供 Rust stdio bridge 使用的 safeStorage 适配器；不执行任何远端请求。 */
export function loadWorkingAuthForRust(): RustWorkingAuthRecord | null {
  const token = workingTokenStore.getToken()
  if (!token) return null
  return {
    accessToken: token,
    refreshToken: workingTokenStore.getRefreshToken(),
    provider: workingTokenStore.getProvider?.() ?? 'legacy',
    user: sanitizeWorkingUserForRust(workingTokenStore.getUser()),
    expiresAt: workingTokenStore.getExpiresAt?.() ?? null,
  }
}

/** 仅供 Rust stdio bridge 使用；认证凭据仍由 safeStorage 加密后落盘。 */
export function saveWorkingAuthFromRust(record: RustWorkingAuthRecord): void {
  if (!record || typeof record.accessToken !== 'string' || !record.accessToken.trim()) {
    throw new Error('Rust 认证记录缺少 access token')
  }
  if (record.provider !== 'legacy' && record.provider !== 'oidc') {
    throw new Error('Rust 认证 provider 不正确')
  }
  workingTokenStore.save(
    record.accessToken,
    sanitizeWorkingUserForRust(record.user ?? null),
    record.refreshToken ?? null,
    record.provider,
    record.expiresAt ?? null,
  )
}

/** 仅供 Rust stdio bridge 使用。 */
export function clearWorkingAuthFromRust(): void {
  workingTokenStore.clear()
}
