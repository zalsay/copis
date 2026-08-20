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

  test('只返回配置的 Rust 远端根地址，不在 Electron 探测远端 endpoint', async () => {
    let fetchCalls = 0
    const result = await resolveCopisBackendEndpoints({
      configuredBackendUrl: 'https://edu-api.example.test',
      configuredModelBaseUrl: 'https://edu-api.example.test/api/internal/working-model',
      fetchImpl: () => {
        fetchCalls += 1
        throw new Error('Electron 不应发起远端 endpoint 请求')
      },
    })

    expect(result).toEqual({
      backendUrl: 'https://edu-api.example.test',
      modelBaseUrl: 'https://edu-api.example.test/api/internal/working-model',
      source: 'configured',
    })
    expect(fetchCalls).toBe(0)
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
    expect(deriveCopisBackendUrl(
      'https://edu-api.example.test/module/edu-api/api/internal/working-model',
      'https://fallback.example.test',
    )).toBe('https://edu-api.example.test/module/edu-api')
  })
})
