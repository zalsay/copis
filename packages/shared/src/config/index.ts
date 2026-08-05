/**
 * Shared configuration for copis
 */

export const APP_NAME = 'Copis'

/** 本地 Rust HTTP API 只监听回环地址。 */
export const COPIS_HTTP_API_HOST = '127.0.0.1'

/** 正式 App 使用的本地 Rust HTTP API 端口。 */
export const COPIS_HTTP_API_PRODUCTION_PORT = 51730

/** 未打包开发环境使用的本地 Rust HTTP API 端口。 */
export const COPIS_HTTP_API_DEVELOPMENT_PORT = 51740

export interface CopisHttpApiPortOptions {
  configuredPort?: string
  isPackaged: boolean
}

/** 解析主进程和 Rust server 共用的 HTTP API 端口。 */
export function resolveCopisHttpApiPort(options: CopisHttpApiPortOptions): number {
  if (options.isPackaged) return COPIS_HTTP_API_PRODUCTION_PORT

  const parsed = Number(options.configuredPort?.trim())
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) return parsed
  return COPIS_HTTP_API_DEVELOPMENT_PORT
}
