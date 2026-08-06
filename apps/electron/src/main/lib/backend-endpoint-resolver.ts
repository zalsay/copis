import type { FunctionalModuleFetch } from './functional-module-manager'

export const DEFAULT_COPIS_BACKEND_URL = 'https://edu-api.meetlife.com.cn:9001'
export const DEFAULT_MODEL_ENDPOINTS_URL =
  'https://download.meetlife.com.cn/working-model-endpoints.json'
export const MODEL_ENDPOINTS_URL_ENV = 'WORKING_AGENT_MODEL_ENDPOINTS_URL'
export const MODEL_BASE_URL_ENV = 'WORKING_AGENT_MODEL_BASE_URL'

const MODEL_ENDPOINT_PATH = '/api/internal/working-model'
const DEFAULT_RESOLUTION_TIMEOUT_MS = 2_000

export interface CopisBackendEndpointResolution {
  /** Copis 后端根地址，供 Electron Working API 和 Rust skill market 使用。 */
  backendUrl: string
  /** 远端 working-model 地址，保留完整候选路径供 Rust/Pi runtime 使用。 */
  modelBaseUrl: string
  source: 'remote' | 'configured'
}

export interface ResolveCopisBackendEndpointsOptions {
  configuredBackendUrl?: string
  configuredModelBaseUrl?: string
  endpointConfigUrl?: string
  fetchImpl?: FunctionalModuleFetch
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

function responseIsSuccessful(response: Response): boolean {
  return response.status >= 200 && response.status < 300
}

function uniqueCandidates(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const normalized = trimTrailingSlashes(value)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

async function fetchWithDeadline(
  fetchImpl: FunctionalModuleFetch,
  input: string,
  deadline: number,
  controller: AbortController,
): Promise<Response> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error('远端 endpoint 探测超时')

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('远端 endpoint 探测超时'))
      }, remaining)
    })
    return await Promise.race([
      fetchImpl(input, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      }),
      timeout,
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function fetchRemoteCandidates(
  fetchImpl: FunctionalModuleFetch,
  configUrl: string,
  deadline: number,
  controller: AbortController,
): Promise<string[]> {
  const response = await fetchWithDeadline(fetchImpl, configUrl, deadline, controller)
  if (!responseIsSuccessful(response)) throw new Error(`endpoint 列表 HTTP ${response.status}`)
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error('远端 endpoint 列表读取超时')
  let timer: ReturnType<typeof setTimeout> | undefined
  const payload: unknown = await Promise.race([
    response.json(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('远端 endpoint 列表读取超时'))
      }, remaining)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
  if (!isRecord(payload)) return []
  const config = payload as ModelEndpointsConfig
  if (!Array.isArray(config.base_urls)) return []
  return config.base_urls.filter((value): value is string => typeof value === 'string')
}

async function isEndpointHealthy(
  fetchImpl: FunctionalModuleFetch,
  candidate: string,
  deadline: number,
  controller: AbortController,
): Promise<boolean> {
  const probeUrl = healthProbeUrl(candidate)
  if (!probeUrl) return false
  try {
    const response = await fetchWithDeadline(fetchImpl, probeUrl, deadline, controller)
    return responseIsSuccessful(response)
  } catch {
    return false
  }
}

export async function resolveCopisBackendEndpoints(
  options: ResolveCopisBackendEndpointsOptions = {},
): Promise<CopisBackendEndpointResolution> {
  const backendUrl = configuredBackendUrl(options.configuredBackendUrl)
  const configuredModelUrl = configuredModelBaseUrl(
    options.configuredModelBaseUrl,
    backendUrl,
    options.configuredBackendUrl,
  )
  const fetchImpl = options.fetchImpl ?? fetch
  const configUrl = trimTrailingSlashes(
    options.endpointConfigUrl?.trim()
      || process.env[MODEL_ENDPOINTS_URL_ENV]?.trim()
      || DEFAULT_MODEL_ENDPOINTS_URL,
  )
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_RESOLUTION_TIMEOUT_MS)
  const controller = new AbortController()
  const deadline = Date.now() + timeoutMs

  try {
    const remoteCandidates = await fetchRemoteCandidates(fetchImpl, configUrl, deadline, controller)
    const candidates = uniqueCandidates([...remoteCandidates, configuredModelUrl])
    for (const candidate of candidates) {
      if (await isEndpointHealthy(fetchImpl, candidate, deadline, controller)) {
        return {
          backendUrl: deriveCopisBackendUrl(candidate, backendUrl),
          modelBaseUrl: candidate,
          source: 'remote',
        }
      }
    }
  } catch {
    // 列表服务不可用时保留本地配置，不能阻断 Copis 本地 Rust API 启动。
  } finally {
    controller.abort()
  }

  return {
    backendUrl,
    modelBaseUrl: configuredModelUrl,
    source: 'configured',
  }
}
