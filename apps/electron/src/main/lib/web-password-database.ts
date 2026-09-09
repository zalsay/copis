/**
 * 网页密码 SQLite 本地安全数据库
 *
 * 基于 SQLite (Node 22 / Electron 43 内置 node:sqlite，测试环境回退 bun:sqlite)
 * 密码使用 Electron safeStorage 进行操作系统级加密存储。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import type {
  WebPasswordDisabledOrigin,
  WebPasswordEntry,
  WebPasswordEntryWithSecret,
  WebPasswordSettings,
} from '@copis/shared'

const nodeRequire = typeof require === 'function' ? require : createRequire(typeof __filename !== 'undefined' ? __filename : process.cwd())

export const PASSWORD_MASK = '••••••••'

export interface PasswordCipher {
  encrypt(plain: string): string
  decrypt(cipher: string): string
}

function getSafeStorage(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = nodeRequire('electron')
    return electron?.safeStorage
  } catch {
    return undefined
  }
}

export const defaultSafeStorageCipher: PasswordCipher = {
  encrypt(plain: string): string {
    const storage = getSafeStorage()
    if (storage && typeof storage.isEncryptionAvailable === 'function' && storage.isEncryptionAvailable()) {
      return storage.encryptString(plain).toString('base64')
    }
    return Buffer.from(plain, 'utf-8').toString('base64')
  },
  decrypt(cipher: string): string {
    const storage = getSafeStorage()
    if (storage && typeof storage.isEncryptionAvailable === 'function' && storage.isEncryptionAvailable()) {
      try {
        return storage.decryptString(Buffer.from(cipher, 'base64'))
      } catch {
        try {
          return Buffer.from(cipher, 'base64').toString('utf-8')
        } catch {
          return ''
        }
      }
    }
    try {
      return Buffer.from(cipher, 'base64').toString('utf-8')
    } catch {
      return cipher
    }
  },
}

export function normalizeOrigin(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return rawUrl.trim().toLowerCase()
  }
}

export interface ISqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid?: number | bigint }
    get(...params: unknown[]): Record<string, unknown> | null | undefined
    all(...params: unknown[]): Record<string, unknown>[]
  }
  close(): void
}

export function openSqliteDatabase(dbPath: string): ISqliteDatabase {
  const isBun = typeof process !== 'undefined' && process.versions && Boolean((process.versions as Record<string, unknown>).bun)

  if (isBun) {
    const { Database } = nodeRequire('bun:sqlite')
    const db = new Database(dbPath)
    return {
      exec(sql: string) {
        db.exec(sql)
      },
      prepare(sql: string) {
        const stmt = db.prepare(sql)
        return {
          run(...params: unknown[]) {
            return stmt.run(...params)
          },
          get(...params: unknown[]) {
            return stmt.get(...params)
          },
          all(...params: unknown[]) {
            return stmt.all(...params)
          },
        }
      },
      close() {
        db.close()
      },
    }
  }

  // Node 22 / Electron 43 built-in
  const sqliteModuleName = 'node:sqlite'
  const { DatabaseSync } = nodeRequire(sqliteModuleName)
  const db = new DatabaseSync(dbPath)
  return {
    exec(sql: string) {
      db.exec(sql)
    },
    prepare(sql: string) {
      const stmt = db.prepare(sql)
      return {
        run(...params: unknown[]) {
          return stmt.run(...params)
        },
        get(...params: unknown[]) {
          return stmt.get(...params)
        },
        all(...params: unknown[]) {
          return stmt.all(...params)
        },
      }
    },
    close() {
      db.close()
    },
  }
}

export interface SaveLoginInput {
  originUrl: string
  username: string
  passwordPlain: string
  signonRealm?: string
  actionUrl?: string
  usernameElement?: string
  passwordElement?: string
}

export class WebPasswordDatabase {
  private db: ISqliteDatabase
  private cipher: PasswordCipher

  constructor(dbPath: string, cipher: PasswordCipher = defaultSafeStorageCipher) {
    this.cipher = cipher

    if (dbPath !== ':memory:') {
      const parentDir = dirname(dbPath)
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true })
      }
    }

    this.db = openSqliteDatabase(dbPath)
    this.init()
  }

  private init(): void {
    // 启用 WAL 模式提高并发读写性能
    try {
      this.db.exec('PRAGMA journal_mode = WAL;')
    } catch {
      // 内存库可能不支持 WAL，静默忽略
    }
    this.db.exec('PRAGMA foreign_keys = ON;')

    // 创建表结构
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS logins (
        id TEXT PRIMARY KEY,
        origin_url TEXT NOT NULL,
        username_value TEXT NOT NULL,
        password_value TEXT NOT NULL,
        signon_realm TEXT,
        action_url TEXT,
        username_element TEXT,
        password_element TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER,
        use_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE(origin_url, username_value)
      );

      CREATE INDEX IF NOT EXISTS idx_logins_origin_url ON logins (origin_url);

      CREATE TABLE IF NOT EXISTS disabled_origins (
        id TEXT PRIMARY KEY,
        origin_url TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS password_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
  }

  /** 获取设置 */
  public getSettings(): WebPasswordSettings {
    const rows = this.db.prepare('SELECT key, value FROM password_settings').all()
    const map = new Map<string, string>()
    for (const row of rows) {
      if (typeof row.key === 'string' && typeof row.value === 'string') {
        map.set(row.key, row.value)
      }
    }

    return {
      offerToSavePasswords: map.get('offerToSavePasswords') !== 'false',
      autoFillPasswords: map.get('autoFillPasswords') !== 'false',
    }
  }

  /** 更新设置 */
  public updateSettings(partial: Partial<WebPasswordSettings>): WebPasswordSettings {
    const current = this.getSettings()
    const updated: WebPasswordSettings = {
      ...current,
      ...partial,
    }

    const upsertStmt = this.db.prepare(`
      INSERT INTO password_settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    `)

    upsertStmt.run('offerToSavePasswords', updated.offerToSavePasswords ? 'true' : 'false')
    upsertStmt.run('autoFillPasswords', updated.autoFillPasswords ? 'true' : 'false')

    return updated
  }

  /** 列出已保存账号列表（脱敏） */
  public listLogins(searchQuery?: string): WebPasswordEntry[] {
    let sql = 'SELECT * FROM logins'
    const params: unknown[] = []

    if (searchQuery && searchQuery.trim()) {
      const q = `%${searchQuery.trim().toLowerCase()}%`
      sql += ' WHERE LOWER(origin_url) LIKE ? OR LOWER(username_value) LIKE ?'
      params.push(q, q)
    }

    sql += ' ORDER BY updated_at DESC, created_at DESC, rowid DESC'
    const rows = this.db.prepare(sql).all(...params)

    return rows.map((row) => this.mapRowToEntry(row))
  }

  /** 查询指定域名的所有保存项（包含解密后明文，仅供主进程内部填充使用） */
  public getLoginsByOrigin(rawUrl: string): WebPasswordEntryWithSecret[] {
    const origin = normalizeOrigin(rawUrl)
    const rows = this.db.prepare('SELECT * FROM logins WHERE origin_url = ? ORDER BY last_used_at DESC, updated_at DESC, created_at DESC, rowid DESC').all(origin)
    return rows.map((row) => this.mapRowToEntryWithSecret(row))
  }

  /** 根据 ID 查询单个项（包含解密明文） */
  public getLoginById(id: string): WebPasswordEntryWithSecret | null {
    const row = this.db.prepare('SELECT * FROM logins WHERE id = ?').get(id)
    if (!row) return null
    return this.mapRowToEntryWithSecret(row)
  }

  /** 保存或更新凭据 */
  public saveOrUpdateLogin(input: SaveLoginInput): WebPasswordEntry {
    const origin = normalizeOrigin(input.originUrl)
    const username = input.username.trim()
    const encryptedPassword = this.cipher.encrypt(input.passwordPlain)
    const now = Date.now()

    // 检查是否存在
    const existing = this.db.prepare('SELECT id, use_count, created_at FROM logins WHERE origin_url = ? AND username_value = ?').get(origin, username)

    if (existing && typeof existing.id === 'string') {
      const id = existing.id
      this.db.prepare(`
        UPDATE logins SET
          password_value = ?,
          signon_realm = coalesce(?, signon_realm),
          action_url = coalesce(?, action_url),
          username_element = coalesce(?, username_element),
          password_element = coalesce(?, password_element),
          updated_at = ?
        WHERE id = ?
      `).run(
        encryptedPassword,
        input.signonRealm ?? null,
        input.actionUrl ?? null,
        input.usernameElement ?? null,
        input.passwordElement ?? null,
        now,
        id,
      )

      return {
        id,
        originUrl: origin,
        username,
        passwordMasked: PASSWORD_MASK,
        signonRealm: input.signonRealm,
        actionUrl: input.actionUrl,
        usernameElement: input.usernameElement,
        passwordElement: input.passwordElement,
        createdAt: Number(existing.created_at) || now,
        updatedAt: now,
        lastUsedAt: undefined,
        useCount: Number(existing.use_count) || 0,
      }
    }

    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO logins (
        id, origin_url, username_value, password_value,
        signon_realm, action_url, username_element, password_element,
        created_at, updated_at, use_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      id,
      origin,
      username,
      encryptedPassword,
      input.signonRealm ?? null,
      input.actionUrl ?? null,
      input.usernameElement ?? null,
      input.passwordElement ?? null,
      now,
      now,
    )

    return {
      id,
      originUrl: origin,
      username,
      passwordMasked: PASSWORD_MASK,
      signonRealm: input.signonRealm,
      actionUrl: input.actionUrl,
      usernameElement: input.usernameElement,
      passwordElement: input.passwordElement,
      createdAt: now,
      updatedAt: now,
      useCount: 0,
    }
  }

  /** 记录凭据使用 */
  public recordLoginUsed(id: string): void {
    const now = Date.now()
    this.db.prepare(`
      UPDATE logins SET
        last_used_at = ?,
        use_count = use_count + 1
      WHERE id = ?
    `).run(now, id)
  }

  /** 删除单个凭据 */
  public removeLogin(id: string): boolean {
    const res = this.db.prepare('DELETE FROM logins WHERE id = ?').run(id)
    return (res.changes ?? 0) > 0
  }

  /** 解密明文密码 */
  public revealPassword(id: string): string | null {
    const entry = this.getLoginById(id)
    if (!entry) return null
    return entry.passwordPlain
  }

  /** 检查域名是否在黑名单中 */
  public isOriginDisabled(rawUrl: string): boolean {
    const origin = normalizeOrigin(rawUrl)
    const row = this.db.prepare('SELECT id FROM disabled_origins WHERE origin_url = ?').get(origin)
    return Boolean(row)
  }

  /** 列出从不保存密码的网站 */
  public listDisabledOrigins(): WebPasswordDisabledOrigin[] {
    const rows = this.db.prepare('SELECT id, origin_url, created_at FROM disabled_origins ORDER BY created_at DESC').all()
    return rows.map((row) => ({
      id: String(row.id),
      originUrl: String(row.origin_url),
      createdAt: Number(row.created_at) || 0,
    }))
  }

  /** 添加从不保存密码的网站 */
  public addDisabledOrigin(rawUrl: string): WebPasswordDisabledOrigin {
    const origin = normalizeOrigin(rawUrl)
    const existing = this.db.prepare('SELECT id, created_at FROM disabled_origins WHERE origin_url = ?').get(origin)
    if (existing && typeof existing.id === 'string') {
      return {
        id: existing.id,
        originUrl: origin,
        createdAt: Number(existing.created_at) || 0,
      }
    }

    const id = randomUUID()
    const now = Date.now()
    this.db.prepare('INSERT INTO disabled_origins (id, origin_url, created_at) VALUES (?, ?, ?)').run(id, origin, now)

    return {
      id,
      originUrl: origin,
      createdAt: now,
    }
  }

  /** 从黑名单中移除 */
  public removeDisabledOrigin(id: string): boolean {
    const res = this.db.prepare('DELETE FROM disabled_origins WHERE id = ?').run(id)
    return (res.changes ?? 0) > 0
  }

  /** 关闭数据库 */
  public close(): void {
    try {
      this.db.close()
    } catch {
      // 忽略关闭异常
    }
  }

  private mapRowToEntry(row: Record<string, unknown>): WebPasswordEntry {
    return {
      id: String(row.id),
      originUrl: String(row.origin_url),
      username: String(row.username_value),
      passwordMasked: PASSWORD_MASK,
      signonRealm: row.signon_realm ? String(row.signon_realm) : undefined,
      actionUrl: row.action_url ? String(row.action_url) : undefined,
      usernameElement: row.username_element ? String(row.username_element) : undefined,
      passwordElement: row.password_element ? String(row.password_element) : undefined,
      createdAt: Number(row.created_at) || 0,
      updatedAt: Number(row.updated_at) || 0,
      lastUsedAt: row.last_used_at ? Number(row.last_used_at) : undefined,
      useCount: Number(row.use_count) || 0,
    }
  }

  private mapRowToEntryWithSecret(row: Record<string, unknown>): WebPasswordEntryWithSecret {
    const base = this.mapRowToEntry(row)
    const encrypted = String(row.password_value || '')
    const plain = this.cipher.decrypt(encrypted)
    return {
      ...base,
      passwordPlain: plain,
    }
  }
}
