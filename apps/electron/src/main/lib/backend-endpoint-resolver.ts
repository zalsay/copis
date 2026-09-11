export const DEFAULT_COPIS_BACKEND_URL = 'https://pie.meetlife.com.cn/pi-api'
export const DEFAULT_MODEL_REQUEST_URL = 'https://pie.meetlife.com.cn/model-request'
export const MODEL_BASE_URL_ENV = 'WORKING_AGENT_MODEL_BASE_URL'
export const MODEL_REQUEST_BASE_URL_ENV = 'COPIS_MODEL_REQUEST_BASE_URL'
export const MODEL_ENDPOINTS_URL_ENV = 'COPIS_MODEL_ENDPOINTS_URL'

const MODEL_ENDPOINT_PATH = '/api/internal/working-model'
const MODEL_ENDPOINTS_PATH = '/api/client/model-request-endpoints'
const DEFAULT_RESOLUTION_TIMEOUT_MS = 2_000

export interface CopisBackendEndpointResolution {
  /** Copis 后端根地址，供 Electron Working API 和 Rust skill market 使用。 */
  backendUrl: string
  /** 选中的 model-request 基地址，保留候选路径供 Rust/Pi runtime 使用。 */
  modelBaseUrl: string
  source: 'configured' | 'remote'
}

export interface ResolveCopisBackendEndpointsOptions {
  configuredBackendUrl?: string
  configuredModelBaseUrl?: string
  endpointConfigUrl?: string
  fetchImpl?: unknown
  timeoutMs?: number
}

type EndpointFetch = (input: string, init?: RequestInit) => Promise<Response>

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
  const configured = configuredModelOverride(value, configuredBackendOverride)
  return trimTrailingSlashes(
    configured
      || (backendUrl === DEFAULT_COPIS_BACKEND_URL
        ? DEFAULT_MODEL_REQUEST_URL
        : `${backendUrl}${MODEL_ENDPOINT_PATH}`),
  )
}

function configuredModelOverride(
  value: string | undefined,
  configuredBackendOverride?: string,
): string | undefined {
  const environmentBackendUrl = trimTrailingSlashes(process.env.COPIS_BACKEND_URL?.trim() ?? '')
  const backendOverride = trimTrailingSlashes(configuredBackendOverride?.trim() ?? '')
  const canReuseEnvironmentModel = !backendOverride || backendOverride === environmentBackendUrl
  return value?.trim()
    || (canReuseEnvironmentModel ? process.env[MODEL_REQUEST_BASE_URL_ENV]?.trim() : undefined)
    || (canReuseEnvironmentModel ? process.env[MODEL_BASE_URL_ENV]?.trim() : undefined)
}

export function healthProbeUrl(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.host) return undefined
    // edu-api 的 working-model 兼容入口使用根路径；公网 model-request
    // 则挂在 /model-request 下，健康检查与业务入口保持同一前缀。
    url.pathname = url.pathname.endsWith('/model-request')
      ? `${url.pathname}/health`
      : '/health'
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
  const configuredModel = configuredModelOverride(
    options.configuredModelBaseUrl,
    options.configuredBackendUrl,
  )
  const fallbackModelBaseUrl = configuredModelBaseUrl(
    options.configuredModelBaseUrl,
    backendUrl,
    options.configuredBackendUrl,
  )

  const configUrl = options.endpointConfigUrl?.trim()
    || process.env[MODEL_ENDPOINTS_URL_ENV]?.trim()
    || `${backendUrl}${MODEL_ENDPOINTS_PATH}`
  const fetchImpl = (options.fetchImpl as EndpointFetch | undefined) ?? fetch
  const resolutionTimeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_RESOLUTION_TIMEOUT_MS)
  const deadline = Date.now() + resolutionTimeoutMs
  const candidates = configuredModel ? [configuredModel] : []
  try {
    const config = await fetchEndpointConfig(fetchImpl, configUrl, remainingTimeout(deadline))
    candidates.push(...config)
  } catch {
    // 配置服务不可用时继续使用现有固定地址，保证客户端仍能启动。
  }

  const seen = new Set<string>()
  for (const candidate of candidates) {
    const normalized = normalizeModelEndpoint(candidate)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    if (await isHealthyModelEndpoint(fetchImpl, normalized, remainingTimeout(deadline))) {
      return {
        backendUrl,
        modelBaseUrl: normalized,
        source: configuredModel === normalized ? 'configured' : 'remote',
      }
    }
  }

  return {
    backendUrl,
    modelBaseUrl: fallbackModelBaseUrl,
    source: 'configured',
  }
}

function remainingTimeout(deadline: number): number {
  return Math.max(1, deadline - Date.now())
}

async function fetchEndpointConfig(
  fetchImpl: EndpointFetch,
  configUrl: string,
  timeoutMs: number,
): Promise<string[]> {
  const response = await fetchWithTimeout(fetchImpl, configUrl, timeoutMs)
  if (!response.ok) throw new Error(`endpoint config HTTP ${response.status}`)
  const payload = await response.json() as unknown
  if (!isRecord(payload) || !Array.isArray(payload.base_urls)) return []
  return payload.base_urls.filter((value): value is string => typeof value === 'string')
}

async function isHealthyModelEndpoint(
  fetchImpl: EndpointFetch,
  baseUrl: string,
  timeoutMs: number,
): Promise<boolean> {
  const healthUrl = healthProbeUrl(baseUrl)
  if (!healthUrl) return false
  try {
    const response = await fetchWithTimeout(fetchImpl, healthUrl, timeoutMs)
    return response.ok
  } catch {
    return false
  }
}

async function fetchWithTimeout(
  fetchImpl: EndpointFetch,
  input: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timeout = Math.max(1, timeoutMs)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<Response>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('endpoint request timeout'))
    }, timeout)
  })
  try {
    return await Promise.race([
      fetchImpl(input, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      }),
      timeoutPromise,
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function normalizeModelEndpoint(value: string): string | undefined {
  try {
    const url = new URL(value.trim())
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) {
      return undefined
    }
    if (url.pathname.split('/').some((segment) => segment === '..')) return undefined
    url.search = ''
    url.hash = ''
    url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/'
    return trimTrailingSlashes(url.toString())
  } catch {
    return undefined
  }
}
