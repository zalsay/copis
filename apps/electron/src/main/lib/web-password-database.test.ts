import { describe, expect, test } from 'bun:test'
import {
  WebPasswordDatabase,
  normalizeOrigin,
  PASSWORD_MASK,
  type PasswordCipher,
} from './web-password-database'

const mockCipher: PasswordCipher = {
  encrypt: (plain: string) => `enc_${plain}`,
  decrypt: (cipher: string) => cipher.replace(/^enc_/, ''),
}

describe('WebPasswordDatabase', () => {
  test('normalizeOrigin parses protocol and host correctly', () => {
    expect(normalizeOrigin('https://github.com/login?return_to=%2F')).toBe('https://github.com')
    expect(normalizeOrigin('http://localhost:3000/auth')).toBe('http://localhost:3000')
    expect(normalizeOrigin('https://sub.example.com:8080/path')).toBe('https://sub.example.com:8080')
  })

  test('CRUD operations and password masking', () => {
    const db = new WebPasswordDatabase(':memory:', mockCipher)

    // 默认设置
    const defaultSettings = db.getSettings()
    expect(defaultSettings.offerToSavePasswords).toBe(true)
    expect(defaultSettings.autoFillPasswords).toBe(true)

    // 保存密码
    const saved = db.saveOrUpdateLogin({
      originUrl: 'https://example.com/login',
      username: 'alice',
      passwordPlain: 'superSecret123',
    })

    expect(saved.id).toBeDefined()
    expect(saved.originUrl).toBe('https://example.com')
    expect(saved.username).toBe('alice')
    expect(saved.passwordMasked).toBe(PASSWORD_MASK)
    expect((saved as any).passwordPlain).toBeUndefined()

    // 列表查询（脱敏）
    const list = db.listLogins()
    expect(list.length).toBe(1)
    expect(list[0]!.username).toBe('alice')
    expect(list[0]!.passwordMasked).toBe(PASSWORD_MASK)

    // 搜索
    const searchMatch = db.listLogins('ali')
    expect(searchMatch.length).toBe(1)
    const searchMiss = db.listLogins('bob')
    expect(searchMiss.length).toBe(0)

    // 获取明文
    const revealed = db.revealPassword(saved.id)
    expect(revealed).toBe('superSecret123')

    // 按 Origin 查询（供自动填充使用）
    const originLogins = db.getLoginsByOrigin('https://example.com/other-page')
    expect(originLogins.length).toBe(1)
    expect(originLogins[0]!.passwordPlain).toBe('superSecret123')

    // 更新密码
    const updated = db.saveOrUpdateLogin({
      originUrl: 'https://example.com/login',
      username: 'alice',
      passwordPlain: 'newPassword456',
    })
    expect(updated.id).toBe(saved.id)
    expect(db.revealPassword(saved.id)).toBe('newPassword456')

    // 记录使用
    db.recordLoginUsed(saved.id)
    const afterUsed = db.getLoginById(saved.id)
    expect(afterUsed?.useCount).toBe(1)
    expect(afterUsed?.lastUsedAt).toBeDefined()

    // 删除
    const removed = db.removeLogin(saved.id)
    expect(removed).toBe(true)
    expect(db.listLogins().length).toBe(0)

    db.close()
  })

  test('disabled origins (never save for this site)', () => {
    const db = new WebPasswordDatabase(':memory:', mockCipher)

    expect(db.isOriginDisabled('https://never.com/login')).toBe(false)

    const disabled = db.addDisabledOrigin('https://never.com/login')
    expect(disabled.originUrl).toBe('https://never.com')
    expect(db.isOriginDisabled('https://never.com/profile')).toBe(true)

    const list = db.listDisabledOrigins()
    expect(list.length).toBe(1)
    expect(list[0]!.originUrl).toBe('https://never.com')

    const removed = db.removeDisabledOrigin(disabled.id)
    expect(removed).toBe(true)
    expect(db.isOriginDisabled('https://never.com')).toBe(false)

    db.close()
  })

  test('settings update', () => {
    const db = new WebPasswordDatabase(':memory:', mockCipher)

    const updated = db.updateSettings({
      offerToSavePasswords: false,
    })
    expect(updated.offerToSavePasswords).toBe(false)
    expect(updated.autoFillPasswords).toBe(true)

    const reloaded = db.getSettings()
    expect(reloaded.offerToSavePasswords).toBe(false)
    expect(reloaded.autoFillPasswords).toBe(true)

    db.close()
  })
})
