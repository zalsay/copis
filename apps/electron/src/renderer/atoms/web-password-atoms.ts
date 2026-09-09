/**
 * 网页密码安全存储与自动填充状态管理 (Jotai)
 */

import { atom } from 'jotai'
import type {
  WebPasswordDisabledOrigin,
  WebPasswordEntry,
  WebPasswordPromptAction,
  WebPasswordSavePrompt,
  WebPasswordSettings,
} from '@copis/shared'

/** 当前激活页签关联的密码保存/更新提示 */
export const activeTabPasswordPromptAtom = atom<WebPasswordSavePrompt | null>(null)

/** 当前激活页签域名下已保存的账号列表 */
export const activeTabSavedLoginsAtom = atom<WebPasswordEntry[]>([])

/** 设置面板中展示的全部已保存密码凭据列表 */
export const allWebPasswordsAtom = atom<WebPasswordEntry[]>([])

/** 设置面板中从不保存密码的网站列表 */
export const disabledOriginsAtom = atom<WebPasswordDisabledOrigin[]>([])

/** 密码管理器通用设置 */
export const webPasswordSettingsAtom = atom<WebPasswordSettings>({
  offerToSavePasswords: true,
  autoFillPasswords: true,
})

/** 凭据搜索关键词 */
export const passwordSearchQueryAtom = atom<string>('')

/** 密码管理数据加载状态 */
export const passwordManagerLoadingAtom = atom<boolean>(false)

/**
 * 加载全部已保存密码
 */
export const loadAllPasswordsAtom = atom(null, async (get, set, query?: string) => {
  if (!window.electronAPI?.webPasswords) return
  set(passwordManagerLoadingAtom, true)
  try {
    const q = query ?? get(passwordSearchQueryAtom)
    const list = await window.electronAPI.webPasswords.list(q)
    set(allWebPasswordsAtom, list)
  } finally {
    set(passwordManagerLoadingAtom, false)
  }
})

/**
 * 加载密码设置与黑名单
 */
export const loadPasswordSettingsAtom = atom(null, async (_get, set) => {
  if (!window.electronAPI?.webPasswords) return
  try {
    const [settings, disabled] = await Promise.all([
      window.electronAPI.webPasswords.getSettings(),
      window.electronAPI.webPasswords.listDisabledOrigins(),
    ])
    set(webPasswordSettingsAtom, settings)
    set(disabledOriginsAtom, disabled)
  } catch (err) {
    console.error('[密码管理] 加载设置或黑名单失败:', err)
  }
})

/**
 * 更新密码设置
 */
export const updatePasswordSettingsAtom = atom(
  null,
  async (_get, set, partial: Partial<WebPasswordSettings>) => {
    if (!window.electronAPI?.webPasswords) return
    const updated = await window.electronAPI.webPasswords.updateSettings(partial)
    set(webPasswordSettingsAtom, updated)
  },
)

/**
 * 响应密码提示（保存 / 永不保存 / 忽略）
 */
export const resolvePasswordPromptAtom = atom(
  null,
  async (_get, set, input: { promptId: string; action: WebPasswordPromptAction; username?: string; passwordPlain?: string }) => {
    if (!window.electronAPI?.webPasswords) return
    await window.electronAPI.webPasswords.resolvePrompt(input)
    set(activeTabPasswordPromptAtom, null)
  },
)

/**
 * 删除单个已保存凭据
 */
export const removePasswordAtom = atom(null, async (_get, set, id: string) => {
  if (!window.electronAPI?.webPasswords) return
  const ok = await window.electronAPI.webPasswords.remove(id)
  if (ok) {
    set(allWebPasswordsAtom, (prev) => prev.filter((item) => item.id !== id))
    set(activeTabSavedLoginsAtom, (prev) => prev.filter((item) => item.id !== id))
  }
  return ok
})

/**
 * 移除黑名单域名
 */
export const removeDisabledOriginAtom = atom(null, async (_get, set, id: string) => {
  if (!window.electronAPI?.webPasswords) return
  const ok = await window.electronAPI.webPasswords.removeDisabledOrigin(id)
  if (ok) {
    set(disabledOriginsAtom, (prev) => prev.filter((item) => item.id !== id))
  }
  return ok
})

/**
 * 刷新当前激活标签页站点的已保存凭据
 */
export const refreshActiveTabLoginsAtom = atom(null, async (_get, set, originUrl: string) => {
  if (!window.electronAPI?.webPasswords || !originUrl || originUrl === 'about:blank') {
    set(activeTabSavedLoginsAtom, [])
    return
  }
  try {
    const logins = await window.electronAPI.webPasswords.getByOrigin(originUrl)
    set(activeTabSavedLoginsAtom, logins)
  } catch {
    set(activeTabSavedLoginsAtom, [])
  }
})
