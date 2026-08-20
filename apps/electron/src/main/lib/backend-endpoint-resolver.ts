export const DEFAULT_COPIS_BACKEND_URL = 'https://pie.meetlife.com.cn/pi-api'
export const MODEL_BASE_URL_ENV = 'WORKING_AGENT_MODEL_BASE_URL'

const MODEL_ENDPOINT_PATH = '/api/internal/working-model'
const DEFAULT_RESOLUTION_TIMEOUT_MS = 2_000

export interface CopisBackendEndpointResolution {
  /** Copis 后端根地址，供 Electron Working API 和 Rust skill market 使用。 */
  backendUrl: string
  /** 远端 working-model 地址，保留完整候选路径供 Rust/Pi runtime 使用。 */
  modelBaseUrl: string
  source: 'configured'
}

export interface ResolveCopisBackendEndpointsOptions {
  configuredBackendUrl?: string
  configuredModelBaseUrl?: string
  endpointConfigUrl?: string
  fetchImpl?: unknown
  timeoutMs?: number
}

interface ModelEndpointsConfig {
  base_urls?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function trimTrailingSlashes(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function configuredBackendUrl(value?: string): string {
  return trimTrailingSlashes(value?.trim() || process.env.COPIS_BACKEND_URL?.trim() || DEFAULT_COPIS_BACKEND_URL)
}

function configuredModelBaseUrl(
  value: string | undefined,
  backendUrl: string,
  configuredBackendOverride?: string,
): string {
  const environmentBackendUrl = trimTrailingSlashes(process.env.COPIS_BACKEND_URL?.trim() ?? '')
  const backendOverride = trimTrailingSlashes(configuredBackendOverride?.trim() ?? '')
  const canReuseEnvironmentModel = !backendOverride || backendOverride === environmentBackendUrl
  return trimTrailingSlashes(
    value?.trim()
      || (canReuseEnvironmentModel ? process.env[MODEL_BASE_URL_ENV]?.trim() : undefined)
      || `${backendUrl}${MODEL_ENDPOINT_PATH}`,
  )
}

export function healthProbeUrl(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.host) return undefined
    // 与 ai-education working-agent 保持一致：健康检查固定使用远端根路径。
    url.pathname = '/health'
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}

/**
 * 将 working-model 候选转换为 Copis 业务 API 根地址。
 * 远端列表通常带有 /api/internal/working-model，Rust skill market 不能直接拼接在其后。
 */
export function deriveCopisBackendUrl(modelUrl: string, fallback: string): string {
  try {
    const url = new URL(modelUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback
    const suffix = url.pathname.endsWith(MODEL_ENDPOINT_PATH)
      ? url.pathname.slice(0, -MODEL_ENDPOINT_PATH.length)
      : ''
    url.pathname = suffix || '/'
    url.search = ''
    url.hash = ''
    return trimTrailingSlashes(url.toString())
  } catch {
    return fallback
  }
}

export async function resolveCopisBackendEndpoints(
  options: ResolveCopisBackendEndpointsOptions = {},
): Promise<CopisBackendEndpointResolution> {
  const backendUrl = configuredBackendUrl(options.configuredBackendUrl)
  const modelBaseUrl = configuredModelBaseUrl(
    options.configuredModelBaseUrl,
    backendUrl,
    options.configuredBackendUrl,
  )

  // 远端 endpoint 发现和健康探测由 Rust EduApiClient 统一负责；Electron 只向 Rust
  // 注入配置，避免主进程直接连接 edu-api。
  return {
    backendUrl,
    modelBaseUrl,
    source: 'configured',
  }
}
