/** Rust HTTP API 浏览器会话令牌的请求头名称。 */
export const HTTP_API_WEB_TOKEN_HEADER = 'x-copis-web-token'

let cachedToken: string | undefined

/** 读取 preload 注入的随机会话令牌；普通浏览器（无 preload）返回空字符串。 */
export function getHttpApiWebToken(): string {
  if (cachedToken === undefined) {
    const api = (globalThis as { window?: Window }).window?.electronAPI
    cachedToken = typeof api?.getHttpApiWebToken === 'function' ? api.getHttpApiWebToken() : ''
  }
  return cachedToken
}

/** 为直连 Rust HTTP API 的请求附加 web 令牌请求头。 */
export function withHttpApiWebToken(init: RequestInit): RequestInit {
  const token = getHttpApiWebToken()
  if (!token) return init
  const headers = new Headers(init.headers)
  headers.set(HTTP_API_WEB_TOKEN_HEADER, token)
  return { ...init, headers }
}
