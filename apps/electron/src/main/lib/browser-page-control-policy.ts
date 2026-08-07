import type { BrowserPageControlMode } from '@copis/shared'

export interface BrowserPageControlState {
  mode: BrowserPageControlMode
  pageOrigin: string
  authorizedOrigin?: string
}

interface BrowserPageActionConfirmationInput {
  elementRequiresConfirmation?: boolean
  key?: string
  value?: string
}

const HIGH_RISK_ACTION_PATTERN = /(?:delete|remove|erase|submit|send|publish|purchase|buy|pay|checkout|order|confirm|transfer|unsubscribe|删除|移除|清除|提交|发送|发布|购买|支付|结算|下单|确认|转账|退订)/i

export function normalizeBrowserPageOrigin(pageUrl: string): string {
  try {
    const url = new URL(pageUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.origin
  } catch {
    return ''
  }
}

export function authorizeBrowserPageOrigin(pageUrl: string): string {
  const origin = normalizeBrowserPageOrigin(pageUrl)
  if (!origin) throw new Error('只有 HTTP(S) 页面可以授权 AI浏览器操作')
  return origin
}

export function requiresBrowserPageActionConfirmation(
  input: BrowserPageActionConfirmationInput,
): boolean {
  if (input.elementRequiresConfirmation) return true
  if (input.key === 'Enter' || input.key === 'Delete') return true
  return typeof input.value === 'string' && HIGH_RISK_ACTION_PATTERN.test(input.value)
}

export function resolveBrowserPageControlState(
  pageUrl: string,
  authorizedOrigin?: string,
): BrowserPageControlState {
  const pageOrigin = normalizeBrowserPageOrigin(pageUrl)
  const normalizedAuthorizedOrigin = authorizedOrigin ? normalizeBrowserPageOrigin(authorizedOrigin) : ''
  if (pageOrigin && pageOrigin === normalizedAuthorizedOrigin) {
    return { mode: 'authorized', pageOrigin, authorizedOrigin: pageOrigin }
  }
  return { mode: 'ask', pageOrigin }
}
