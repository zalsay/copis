import { describe, expect, test, mock } from 'bun:test'
import { createProxyFetch, getFetchFn, isLocalAddress } from './proxy-fetch'

describe('代理 Fetch 工具 proxy-fetch', () => {
  test('Given 本地回环地址 When 判断 isLocalAddress Then 正确识别为本地地址', () => {
    expect(isLocalAddress('http://127.0.0.1:51740/health')).toBe(true)
    expect(isLocalAddress('http://localhost:5173/')).toBe(true)
    expect(isLocalAddress('http://localhost:8080/api')).toBe(true)
    expect(isLocalAddress('http://[::1]:3000')).toBe(true)
    expect(isLocalAddress('http://sub.localhost:8080')).toBe(true)
    expect(isLocalAddress(new URL('http://127.0.0.1:11434'))).toBe(true)
  })

  test('Given 远程服务地址 When 判断 isLocalAddress Then 识别为非本地地址', () => {
    expect(isLocalAddress('https://pie.meetlife.com.cn/pi-api')).toBe(false)
    expect(isLocalAddress('https://api.openai.com/v1/chat/completions')).toBe(false)
    expect(isLocalAddress('https://api.deepseek.com/v1')).toBe(false)
    expect(isLocalAddress('https://chatgpt.com/backend-api/wham/usage')).toBe(false)
  })

  test('Given 未配置代理 URL When 获取 fetch 函数 Then 返回全局原生 fetch', () => {
    expect(getFetchFn(undefined)).toBe(fetch)
    expect(getFetchFn('')).toBe(fetch)
    expect(getFetchFn('   ')).toBe(fetch)
  })

  test('Given 配置了代理 URL When 请求本地地址 Then 自动旁路代理直连', async () => {
    const proxyFetch = createProxyFetch('http://127.0.0.1:7890')
    const originalFetch = globalThis.fetch
    let globalFetchCalled = false

    try {
      globalThis.fetch = (async (input: any) => {
        globalFetchCalled = true
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }) as any

      const response = await proxyFetch('http://127.0.0.1:51740/health')
      expect(globalFetchCalled).toBe(true)
      expect(response.status).toBe(200)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
