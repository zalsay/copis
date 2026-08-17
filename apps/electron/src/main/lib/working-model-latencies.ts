/**
 * 通过本地 Rust HTTP API 获取 working model 的首 token 延迟。
 *
 * Rust API 负责用 Working token 请求 edu-api，Renderer 不直接持有 token。
 */

import { app } from 'electron'
import { COPIS_HTTP_API_HOST, resolveCopisHttpApiPort } from '@copis/shared/config'
import type { WorkingModelLatencyMap } from '@copis/shared'
import { getHttpApiInternalToken } from './http-api-server'

interface LatencyResponse {
  data?: WorkingModelLatencyMap
}

export async function getWorkingModelLatencies(): Promise<WorkingModelLatencyMap> {
  const internalToken = getHttpApiInternalToken()
  if (!internalToken) {
    throw new Error('Rust HTTP API 尚未就绪，请稍后重试')
  }

  const port = resolveCopisHttpApiPort({
    configuredPort: process.env.COPIS_HTTP_API_PORT,
    isPackaged: app.isPackaged,
  })
  const url = `http://${COPIS_HTTP_API_HOST}:${port}/api/internal/working-model/first-token-latencies`
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'X-Copis-Internal-Token': internalToken,
    },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    throw new Error(`模型延迟查询失败（HTTP ${response.status}）`)
  }

  const payload = await response.json() as LatencyResponse
  return payload.data ?? {}
}
