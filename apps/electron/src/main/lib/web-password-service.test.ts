import { describe, expect, test } from 'bun:test'
import type { WebPasswordSavePrompt } from '@copis/shared'
import { WebPasswordService } from './web-password-service'
import {
  WebPasswordDatabase,
  type PasswordCipher,
} from './web-password-database'

const mockCipher: PasswordCipher = {
  encrypt: (plain: string) => `test_${plain}`,
  decrypt: (cipher: string) => cipher.replace(/^test_/, ''),
}

function createTestService() {
  const db = new WebPasswordDatabase(':memory:', mockCipher)
  const notifications: Array<{ tabId: string; prompt: WebPasswordSavePrompt | null }> = []
  const service = new WebPasswordService(db, (tabId, prompt) => {
    notifications.push({ tabId, prompt })
  })
  return { db, service, notifications }
}

describe('WebPasswordService', () => {
  test('triggers save prompt on new login submit', () => {
    const { service, notifications } = createTestService()

    service.onLoginSubmitDetected('tab-1', {} as any, {
      origin: 'https://login.example.com/auth',
      username: 'user1',
      password: 'pwd1',
    })

    expect(notifications.length).toBe(1)
    expect(notifications[0]!.tabId).toBe('tab-1')
    expect(notifications[0]!.prompt?.username).toBe('user1')
    expect(notifications[0]!.prompt?.isUpdate).toBe(false)
    expect(notifications[0]!.prompt?.originUrl).toBe('https://login.example.com')

    const active = service.getActivePrompt('tab-1')
    expect(active?.username).toBe('user1')

    service.dispose()
  })

  test('does not prompt if password is unchanged', () => {
    const { db, service, notifications } = createTestService()

    db.saveOrUpdateLogin({
      originUrl: 'https://login.example.com',
      username: 'user1',
      passwordPlain: 'pwd1',
    })

    service.onLoginSubmitDetected('tab-1', {} as any, {
      origin: 'https://login.example.com',
      username: 'user1',
      password: 'pwd1',
    })

    expect(notifications.length).toBe(0)
    expect(service.getActivePrompt('tab-1')).toBeNull()

    const entry = db.getLoginsByOrigin('https://login.example.com')[0]!
    expect(entry.useCount).toBe(1)

    service.dispose()
  })

  test('triggers update prompt if password has changed', () => {
    const { db, service, notifications } = createTestService()

    const initial = db.saveOrUpdateLogin({
      originUrl: 'https://login.example.com',
      username: 'user1',
      passwordPlain: 'old_pwd',
    })

    service.onLoginSubmitDetected('tab-1', {} as any, {
      origin: 'https://login.example.com',
      username: 'user1',
      password: 'new_pwd',
    })

    expect(notifications.length).toBe(1)
    expect(notifications[0]!.prompt?.isUpdate).toBe(true)
    expect(notifications[0]!.prompt?.existingEntryId).toBe(initial.id)
    expect(notifications[0]!.prompt?.passwordPlain).toBe('new_pwd')

    service.dispose()
  })

  test('respects disabled origin and disabled offer settings', () => {
    const { db, service, notifications } = createTestService()

    db.addDisabledOrigin('https://disabled.com')

    service.onLoginSubmitDetected('tab-1', {} as any, {
      origin: 'https://disabled.com/login',
      username: 'u',
      password: 'p',
    })
    expect(notifications.length).toBe(0)

    // 禁用 offerToSavePasswords 设置
    db.updateSettings({ offerToSavePasswords: false })
    service.onLoginSubmitDetected('tab-2', {} as any, {
      origin: 'https://allowed.com/login',
      username: 'u',
      password: 'p',
    })
    expect(notifications.length).toBe(0)

    service.dispose()
  })

  test('resolving prompt: save, never, dismiss', async () => {
    const { db, service, notifications } = createTestService()

    // 1. 测试 Save
    service.onLoginSubmitDetected('tab-1', {} as any, {
      origin: 'https://saveme.com/login',
      username: 'john',
      password: 'secret',
    })
    const prompt1 = service.getActivePrompt('tab-1')!

    await service.resolvePrompt({
      promptId: prompt1.id,
      action: 'save',
      username: 'john_custom',
    })

    expect(service.getActivePrompt('tab-1')).toBeNull()
    const saved = db.getLoginsByOrigin('https://saveme.com')[0]!
    expect(saved.username).toBe('john_custom')
    expect(saved.passwordPlain).toBe('secret')

    // 2. 测试 Never
    service.onLoginSubmitDetected('tab-2', {} as any, {
      origin: 'https://neverever.com',
      username: 'u',
      password: 'p',
    })
    const prompt2 = service.getActivePrompt('tab-2')!

    await service.resolvePrompt({
      promptId: prompt2.id,
      action: 'never',
    })

    expect(service.getActivePrompt('tab-2')).toBeNull()
    expect(db.isOriginDisabled('https://neverever.com')).toBe(true)

    // 3. 测试 Dismiss
    service.onLoginSubmitDetected('tab-3', {} as any, {
      origin: 'https://dismissme.com',
      username: 'u',
      password: 'p',
    })
    const prompt3 = service.getActivePrompt('tab-3')!

    await service.resolvePrompt({
      promptId: prompt3.id,
      action: 'dismiss',
    })

    expect(service.getActivePrompt('tab-3')).toBeNull()
    expect(db.getLoginsByOrigin('https://dismissme.com').length).toBe(0)

    service.dispose()
  })

  test('handlePageDomReady injects watcher script when multiple accounts exist', async () => {
    const { db, service } = createTestService()

    // 保存同一站点的两个账号（例如手误注册与正确账号）
    db.saveOrUpdateLogin({
      originUrl: 'https://multi.com',
      username: 'acc1',
      passwordPlain: 'pwd1',
    })
    db.saveOrUpdateLogin({
      originUrl: 'https://multi.com',
      username: 'acc2',
      passwordPlain: 'pwd2',
    })

    const executedScripts: string[] = []
    const mockWebContents = {
      isDestroyed: () => false,
      getURL: () => 'https://multi.com/login',
      executeJavaScript: async (script: string) => {
        executedScripts.push(script)
        return true
      },
    } as any

    await service.handlePageDomReady('tab-multi', mockWebContents)

    // 应注入检测脚本与常驻待选下拉监听脚本
    expect(executedScripts.length).toBe(2)
    expect(executedScripts[0]).toContain('__copisAutofillDetectionInstalled')
    expect(executedScripts[1]).toContain('MutationObserver')
    expect(executedScripts[1]).toContain('acc1')
    expect(executedScripts[1]).toContain('acc2')
    expect(executedScripts[1]).toContain('showDropdown')
    expect(executedScripts[1]).toContain('copis-dropdown')
    expect(executedScripts[1]).not.toContain('tryFill()') // 不在页面加载时直接默认填入

    service.dispose()
  })

  test('handleConsoleMessage handles autofill-applied to record login usage', () => {
    const { db, service } = createTestService()

    const saved = db.saveOrUpdateLogin({
      originUrl: 'https://usage.com',
      username: 'user_u',
      passwordPlain: 'pwd',
    })
    expect(saved.useCount).toBe(0)

    service.handleConsoleMessage('tab-usage', {} as any, `__COPIS_AUTOFILL_MSG__:${JSON.stringify({
      type: 'autofill-applied',
      payload: { loginId: saved.id },
    })}`)

    const refreshed = db.getLoginById(saved.id)!
    expect(refreshed.useCount).toBe(1)
    expect(refreshed.lastUsedAt).toBeDefined()

    service.dispose()
  })
})

