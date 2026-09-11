import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_COPIS_BACKEND_URL,
  deriveCopisBackendUrl,
  healthProbeUrl,
  resolveCopisBackendEndpoints,
} from './backend-endpoint-resolver'

describe('edu-api endpoint configuration', () => {
  test('默认 backend 指向新的公共入口', () => {
    expect(DEFAULT_COPIS_BACKEND_URL).toBe('https://pie.meetlife.com.cn/pi-api')
  })

  test('按 edu-api 返回顺序探测 model-request，并选择首个健康地址', async () => {
    const calls: string[] = []
    const result = await resolveCopisBackendEndpoints({
      configuredBackendUrl: 'https://edu-api.example.test/pi-api',
      endpointConfigUrl: 'https://edu-api.example.test/pi-api/api/client/model-request-endpoints',
      fetchImpl: async (input: string) => {
        const url = String(input)
        calls.push(url)
        if (url.includes('/model-request-endpoints')) {
          return new Response(JSON.stringify({ base_urls: [
            'https://first.example.test/model-request',
            'https://second.example.test/model-request',
          ] }))
        }
        if (url === 'https://first.example.test/model-request/health') return new Response('unavailable', { status: 503 })
        if (url === 'https://second.example.test/model-request/health') return new Response('ok', { status: 200 })
        return new Response('not found', { status: 404 })
      },
    })

    expect(result).toEqual({
      backendUrl: 'https://edu-api.example.test/pi-api',
      modelBaseUrl: 'https://second.example.test/model-request',
      source: 'remote',
    })
    expect(calls).toEqual([
      'https://edu-api.example.test/pi-api/api/client/model-request-endpoints',
      'https://first.example.test/model-request/health',
      'https://second.example.test/model-request/health',
    ])
  })

  test('远端列表失败时保留已配置模型地址', async () => {
    const result = await resolveCopisBackendEndpoints({
      configuredBackendUrl: 'https://edu-api.example.test',
      configuredModelBaseUrl: 'https://configured.example.test/model-request',
      endpointConfigUrl: 'https://edu-api.example.test/api/client/model-request-endpoints',
      fetchImpl: async () => { throw new Error('offline') },
    })

    expect(result).toEqual({
      backendUrl: 'https://edu-api.example.test',
      modelBaseUrl: 'https://configured.example.test/model-request',
      source: 'configured',
    })
  })

  test('远端列表失败且没有显式模型地址时回退公网 model-request', async () => {
    const result = await resolveCopisBackendEndpoints({
      configuredBackendUrl: DEFAULT_COPIS_BACKEND_URL,
      endpointConfigUrl: 'https://edu-api.example.test/api/client/model-request-endpoints',
      fetchImpl: async () => { throw new Error('offline') },
    })

    expect(result.modelBaseUrl).toBe('https://pie.meetlife.com.cn/model-request')
  })

  test('没有显式模型地址时从配置根地址派生模型地址', async () => {
    const result = await resolveCopisBackendEndpoints({
      configuredBackendUrl: 'http://127.0.0.1:9000/module/edu-api/',
    })

    expect(result).toEqual({
      backendUrl: 'http://127.0.0.1:9000/module/edu-api',
      modelBaseUrl: 'http://127.0.0.1:9000/module/edu-api/api/internal/working-model',
      source: 'configured',
    })
  })

  test('健康检查和路径派生工具只做纯字符串转换', () => {
    expect(healthProbeUrl('https://edu-api.example.test/api/internal/working-model?x=1#fragment'))
      .toBe('https://edu-api.example.test/health')
    expect(healthProbeUrl('https://pie.meetlife.com.cn/model-request'))
      .toBe('https://pie.meetlife.com.cn/model-request/health')
    expect(deriveCopisBackendUrl(
      'https://edu-api.example.test/module/edu-api/api/internal/working-model',
      'https://fallback.example.test',
    )).toBe('https://edu-api.example.test/module/edu-api')
  })
})
