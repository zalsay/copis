/**
 * 网页密码与自动填充主进程核心调度服务
 */

import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import {
  type WebPasswordDisabledOrigin,
  type WebPasswordEntry,
  type WebPasswordPromptAction,
  type WebPasswordPromptResolveInput,
  type WebPasswordSavePrompt,
  type WebPasswordSettings,
  WEB_PASSWORD_IPC_CHANNELS,
} from '@copis/shared'
import { getWebPasswordsDatabasePath } from './config-paths'
import {
  buildAutofillDetectionScript,
  buildAutofillExecutionScript,
  buildAutofillWatcherScript,
  COPIS_AUTOFILL_MSG_PREFIX,
  type AutofillSubmitPayload,
} from './web-password-autofill-script'
import {
  normalizeOrigin,
  WebPasswordDatabase,
  type SaveLoginInput,
} from './web-password-database'

export interface PromptNotifier {
  (tabId: string, prompt: WebPasswordSavePrompt | null): void
}

export class WebPasswordService {
  private dbInstance: WebPasswordDatabase | null = null
  private activePrompts = new Map<string, WebPasswordSavePrompt>()
  private promptNotifier?: PromptNotifier

  constructor(customDb?: WebPasswordDatabase, promptNotifier?: PromptNotifier) {
    if (customDb) {
      this.dbInstance = customDb
    }
    this.promptNotifier = promptNotifier
  }

  public get db(): WebPasswordDatabase {
    if (!this.dbInstance) {
      this.dbInstance = new WebPasswordDatabase(getWebPasswordsDatabasePath())
    }
    return this.dbInstance
  }

  public setPromptNotifier(notifier: PromptNotifier): void {
    this.promptNotifier = notifier
  }

  // ==================== 凭据与设置 CRUD ====================

  public listLogins(searchQuery?: string): WebPasswordEntry[] {
    return this.db.listLogins(searchQuery)
  }

  public getLoginsByOrigin(rawUrl: string): WebPasswordEntry[] {
    // 供渲染进程查询（返回脱敏数据）
    const all = this.db.getLoginsByOrigin(rawUrl)
    return all.map(({ passwordPlain, ...rest }) => rest)
  }

  public revealPassword(id: string): string | null {
    return this.db.revealPassword(id)
  }

  public saveOrUpdateLogin(input: SaveLoginInput): WebPasswordEntry {
    return this.db.saveOrUpdateLogin(input)
  }

  public removeLogin(id: string): boolean {
    return this.db.removeLogin(id)
  }

  public getSettings(): WebPasswordSettings {
    return this.db.getSettings()
  }

  public updateSettings(partial: Partial<WebPasswordSettings>): WebPasswordSettings {
    return this.db.updateSettings(partial)
  }

  public listDisabledOrigins(): WebPasswordDisabledOrigin[] {
    return this.db.listDisabledOrigins()
  }

  public addDisabledOrigin(rawUrl: string): WebPasswordDisabledOrigin {
    const res = this.db.addDisabledOrigin(rawUrl)
    // 清除该域名正在展示的提示
    const origin = normalizeOrigin(rawUrl)
    for (const [tabId, prompt] of this.activePrompts.entries()) {
      if (prompt.originUrl === origin) {
        this.activePrompts.delete(tabId)
        this.promptNotifier?.(tabId, null)
      }
    }
    return res
  }

  public removeDisabledOrigin(id: string): boolean {
    return this.db.removeDisabledOrigin(id)
  }

  // ==================== 提示管理 ====================

  public getActivePrompt(tabId: string): WebPasswordSavePrompt | null {
    return this.activePrompts.get(tabId) ?? null
  }

  public clearPrompt(tabId: string): void {
    if (this.activePrompts.delete(tabId)) {
      this.promptNotifier?.(tabId, null)
    }
  }

  public async resolvePrompt(input: WebPasswordPromptResolveInput): Promise<void> {
    // 找到对应的 prompt
    let targetTabId: string | null = null
    let targetPrompt: WebPasswordSavePrompt | null = null

    for (const [tabId, prompt] of this.activePrompts.entries()) {
      if (prompt.id === input.promptId) {
        targetTabId = tabId
        targetPrompt = prompt
        break
      }
    }

    if (!targetPrompt || !targetTabId) return

    if (input.action === 'save') {
      const username = input.username?.trim() || targetPrompt.username
      const passwordPlain = input.passwordPlain || targetPrompt.passwordPlain

      this.db.saveOrUpdateLogin({
        originUrl: targetPrompt.originUrl,
        username,
        passwordPlain,
        actionUrl: targetPrompt.actionUrl,
        usernameElement: targetPrompt.usernameElement,
        passwordElement: targetPrompt.passwordElement,
      })
    } else if (input.action === 'never') {
      this.db.addDisabledOrigin(targetPrompt.originUrl)
    }

    // 无论是 save、never 还是 dismiss，都清理当前提示
    this.activePrompts.delete(targetTabId)
    this.promptNotifier?.(targetTabId, null)
  }

  // ==================== 页面事件与自动填充 ====================

  /**
   * 处理 WebContents 产生的控制台消息，截获自动填充和表单捕获
   */
  public handleConsoleMessage(tabId: string, contents: WebContents, message: string): void {
    if (!message.startsWith(COPIS_AUTOFILL_MSG_PREFIX)) return

    try {
      const jsonStr = message.slice(COPIS_AUTOFILL_MSG_PREFIX.length)
      const { type, payload } = JSON.parse(jsonStr) as { type: string; payload: unknown }

      if (type === 'login-submit' && payload) {
        this.onLoginSubmitDetected(tabId, contents, payload as AutofillSubmitPayload)
      } else if (type === 'autofill-applied' && payload) {
        const loginId = (payload as { loginId?: string }).loginId
        if (loginId) {
          this.db.recordLoginUsed(loginId)
        }
      }
    } catch {
      // 忽略无法解析的控制台消息
    }
  }

  /**
   * 当检测到登录凭据提交时触发
   */
  public onLoginSubmitDetected(
    tabId: string,
    contents: WebContents,
    payload: AutofillSubmitPayload,
  ): void {
    const origin = normalizeOrigin(payload.origin || contents.getURL())
    if (!origin || !payload.username || !payload.password) return

    // 检查是否从不保存此网站
    if (this.db.isOriginDisabled(origin)) return

    // 检查设置是否启用了密码保存提示
    const settings = this.db.getSettings()
    if (!settings.offerToSavePasswords) return

    // 查询当前域名已保存的账号
    const existingLogins = this.db.getLoginsByOrigin(origin)
    const matchedAccount = existingLogins.find((acc) => acc.username === payload.username)

    if (matchedAccount) {
      if (matchedAccount.passwordPlain === payload.password) {
        // 密码一致，仅记录使用次数，不重复弹框打扰
        this.db.recordLoginUsed(matchedAccount.id)
        return
      }

      // 密码变更，弹出“更新密码”提示
      const prompt: WebPasswordSavePrompt = {
        id: randomUUID(),
        tabId,
        originUrl: origin,
        username: payload.username,
        passwordPlain: payload.password,
        isUpdate: true,
        existingEntryId: matchedAccount.id,
        title: contents.getTitle?.() || undefined,
        actionUrl: payload.actionUrl,
        usernameElement: payload.usernameElement,
        passwordElement: payload.passwordElement,
      }
      this.activePrompts.set(tabId, prompt)
      this.promptNotifier?.(tabId, prompt)
      return
    }

    // 新账号，弹出“保存密码”提示
    const prompt: WebPasswordSavePrompt = {
      id: randomUUID(),
      tabId,
      originUrl: origin,
      username: payload.username,
      passwordPlain: payload.password,
      isUpdate: false,
      title: contents.getTitle?.() || undefined,
      actionUrl: payload.actionUrl,
      usernameElement: payload.usernameElement,
      passwordElement: payload.passwordElement,
    }
    this.activePrompts.set(tabId, prompt)
    this.promptNotifier?.(tabId, prompt)
  }

  /**
   * 页面完成 DOM 就绪后注入捕获脚本并尝试自动填充
   */
  public async handlePageDomReady(tabId: string, contents: WebContents): Promise<void> {
    if (contents.isDestroyed()) return
    const currentUrl = contents.getURL()
    if (!currentUrl.startsWith('http://') && !currentUrl.startsWith('https://')) return

    // 1. 注入表单监听脚本
    try {
      await contents.executeJavaScript(buildAutofillDetectionScript())
    } catch {
      // 忽略无法注入脚本的页面（如部分 CSP 严格限制页面）
    }

    // 2. 检查自动填充设置
    const settings = this.db.getSettings()
    if (!settings.autoFillPasswords) return

    // 3. 查询当前站点的凭据（按最近使用/更新优先排序）
    const logins = this.db.getLoginsByOrigin(currentUrl)
    const login = logins[0]
    if (logins.length >= 1 && login) {
      // 启动页面常驻智能回填监听（支持 SPA 异步挂载与多轮次重试）
      try {
        await contents.executeJavaScript(
          buildAutofillWatcherScript({
            username: login.username,
            passwordPlain: login.passwordPlain,
            usernameElement: login.usernameElement,
            passwordElement: login.passwordElement,
            loginId: login.id,
          }),
        )
      } catch {
        // 自动填充执行失败静默处理
      }
    }
  }

  /**
   * 用户从 🔑 钥匙图标或下拉菜单中主动触发自动填充
   */
  public async fillCredentials(
    tabId: string,
    entryId: string,
    contents?: WebContents,
  ): Promise<boolean> {
    const login = this.db.getLoginById(entryId)
    if (!login || !contents || contents.isDestroyed()) return false

    try {
      const res = await contents.executeJavaScript(
        buildAutofillExecutionScript({
          username: login.username,
          passwordPlain: login.passwordPlain,
          usernameElement: login.usernameElement,
          passwordElement: login.passwordElement,
        }),
      )
      if (res && res.success) {
        this.db.recordLoginUsed(login.id)
        return true
      }
      return false
    } catch {
      return false
    }
  }

  public dispose(): void {
    this.activePrompts.clear()
    this.dbInstance?.close()
    this.dbInstance = null
  }
}

let globalWebPasswordService: WebPasswordService | null = null

export function getWebPasswordService(): WebPasswordService {
  if (!globalWebPasswordService) {
    globalWebPasswordService = new WebPasswordService()
  }
  return globalWebPasswordService
}
