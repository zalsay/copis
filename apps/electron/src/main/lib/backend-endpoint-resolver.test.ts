import { describe, expect, test } from 'bun:test'
import {
  deriveCopisBackendUrl,
  healthProbeUrl,
  resolveCopisBackendEndpoints,
} from './backend-endpoint-resolver'

describe('edu-api 远端 endpoint 选择', () => {
  test('按远端列表顺序选择首个健康 endpoint，并拆出 Copis 后端根地址', async () => {
    const requests: string[] = []
    const fetchImpl = async (input: string): Promise<Response> => {
      requests.push(input)
      if (input === 'https://config.example.test/endpoints.json') {
        return new Response(JSON.stringify({
          base_urls: [
            'https://unavailable.example.test/api/internal/working-model',
            'https://healthy.example.test/api/internal/working-model',
          ],
        }), { status: 200 })
      }
      if (input === 'https://unavailable.example.test/health') return new Response('', { status: 503 })
      if (input === 'https://healthy.example.test/health') return new Response('', { status: 204 })
      return new Response('', { status: 404 })
    }

    const result = await resolveCopisBackendEndpoints({
      configuredBackendUrl: 'https://configured.example.test',
      endpointConfigUrl: 'https://config.example.test/endpoints.json',
      fetchImpl,
    })

    expect(result).toEqual({
      backendUrl: 'https://healthy.example.test',
      modelBaseUrl: 'https://healthy.example.test/api/internal/working-model',
      source: 'remote',
    })
    expect(requests).toEqual([
      'https://config.example.test/endpoints.json',
      'https://unavailable.example.test/health',
      'https://healthy.example.test/health',
    ])
  })

  test('列表拉取失败时保留配置地址，不阻断本地启动', async () => {
    const result = await resolveCopisBackendEndpoints({
      configuredBackendUrl: 'http://127.0.0.1:9000/module/edu-api',
      configuredModelBaseUrl: 'http://127.0.0.1:9000/module/edu-api/api/internal/working-model',
      endpointConfigUrl: 'http://127.0.0.1:1/endpoints.json',
      fetchImpl: async () => { throw new Error('offline') },
    })

    expect(result).toEqual({
      backendUrl: 'http://127.0.0.1:9000/module/edu-api',
      modelBaseUrl: 'http://127.0.0.1:9000/module/edu-api/api/internal/working-model',
      source: 'configured',
    })
  })

  test('健康检查固定为 /health 并清理查询参数', () => {
    expect(healthProbeUrl('https://edu-api.example.test/api/internal/working-model?x=1#fragment'))
      .toBe('https://edu-api.example.test/health')
    expect(deriveCopisBackendUrl(
      'https://edu-api.example.test/module/edu-api/api/internal/working-model',
      'https://fallback.example.test',
    )).toBe('https://edu-api.example.test/module/edu-api')
  })

  test('无健康候选时回退配置 endpoint', async () => {
    const result = await resolveCopisBackendEndpoints({
      configuredBackendUrl: 'https://configured.example.test',
      configuredModelBaseUrl: 'https://configured.example.test/api/internal/working-model',
      endpointConfigUrl: 'https://config.example.test/endpoints.json',
      fetchImpl: async (input: string): Promise<Response> => {
        if (input.endsWith('/endpoints.json')) {
          return new Response(JSON.stringify({ base_urls: ['https://down.example.test/model'] }), { status: 200 })
        }
        return new Response('', { status: 503 })
      },
    })

    expect(result.source).toBe('configured')
    expect(result.modelBaseUrl).toBe('https://configured.example.test/api/internal/working-model')
  })

  test('候选探测使用总超时，不会按候选数量线性阻塞启动', async () => {
    const startedAt = Date.now()
    const result = await resolveCopisBackendEndpoints({
      configuredBackendUrl: 'https://configured.example.test',
      endpointConfigUrl: 'https://config.example.test/endpoints.json',
      timeoutMs: 25,
      fetchImpl: async (input, init): Promise<Response> => {
        if (input.endsWith('/endpoints.json')) {
          return new Response(JSON.stringify({ base_urls: ['https://slow.example.test/model'] }), { status: 200 })
        }
        await new Promise<void>((resolve) => {
          init?.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        return new Response('', { status: 503 })
      },
    })

    expect(result.source).toBe('configured')
    expect(Date.now() - startedAt).toBeLessThan(250)
  })

  test('endpoint 列表响应体卡住时仍受总超时约束', async () => {
    const startedAt = Date.now()
    const result = await resolveCopisBackendEndpoints({
      configuredBackendUrl: 'https://configured.example.test',
      endpointConfigUrl: 'https://config.example.test/endpoints.json',
      timeoutMs: 25,
      fetchImpl: async (): Promise<Response> => ({
        ok: true,
        status: 200,
        json: async () => await new Promise<never>(() => {}),
      } as unknown as Response),
    })

    expect(result.source).toBe('configured')
    expect(Date.now() - startedAt).toBeLessThan(250)
  })

  test('显式切换后端根地址时不复用旧的全局 model endpoint', async () => {
    const previousBackend = process.env.COPIS_BACKEND_URL
    const previousModel = process.env.WORKING_AGENT_MODEL_BASE_URL
    process.env.COPIS_BACKEND_URL = 'https://old.example.test'
    process.env.WORKING_AGENT_MODEL_BASE_URL = 'https://old.example.test/api/internal/working-model'
    try {
      const result = await resolveCopisBackendEndpoints({
        configuredBackendUrl: 'https://new.example.test',
        endpointConfigUrl: 'http://127.0.0.1:1/endpoints.json',
        fetchImpl: async () => { throw new Error('offline') },
      })

      expect(result.modelBaseUrl).toBe('https://new.example.test/api/internal/working-model')
    } finally {
      if (previousBackend === undefined) delete process.env.COPIS_BACKEND_URL
      else process.env.COPIS_BACKEND_URL = previousBackend
      if (previousModel === undefined) delete process.env.WORKING_AGENT_MODEL_BASE_URL
      else process.env.WORKING_AGENT_MODEL_BASE_URL = previousModel
    }
  })
})
