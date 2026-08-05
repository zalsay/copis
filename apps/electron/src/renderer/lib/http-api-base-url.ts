import {
  COPIS_HTTP_API_DEVELOPMENT_PORT,
  COPIS_HTTP_API_HOST,
  COPIS_HTTP_API_PRODUCTION_PORT,
} from '@copis/shared/config'

/** 根据 Vite 的环境判断选择 Renderer 连接的 Rust API 端口。 */
export function resolveRendererHttpApiPort(isDev: boolean): number {
  return isDev ? COPIS_HTTP_API_DEVELOPMENT_PORT : COPIS_HTTP_API_PRODUCTION_PORT
}

const rendererIsDev = typeof import.meta.env !== 'undefined' && import.meta.env.DEV === true

export const RENDERER_HTTP_API_PORT = resolveRendererHttpApiPort(rendererIsDev)
export const RENDERER_HTTP_API_BASE_URL = `http://${COPIS_HTTP_API_HOST}:${RENDERER_HTTP_API_PORT}`
