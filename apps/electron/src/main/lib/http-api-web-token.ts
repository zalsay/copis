import { randomBytes } from 'node:crypto'

export const HTTP_API_WEB_TOKEN_ARGUMENT_PREFIX = '--copis-http-api-web-token='

let cachedWebToken: string | null = null

/** 每次启动生成一次随机会话令牌，Rust HTTP API 用它校验浏览器来源请求。 */
export function getOrCreateHttpApiWebToken(): string {
  if (!cachedWebToken) cachedWebToken = randomBytes(32).toString('hex')
  return cachedWebToken
}

/** 注入到渲染窗口 webPreferences.additionalArguments，preload 从中读取令牌。 */
export function httpApiWebTokenArgument(): string {
  return `${HTTP_API_WEB_TOKEN_ARGUMENT_PREFIX}${getOrCreateHttpApiWebToken()}`
}
