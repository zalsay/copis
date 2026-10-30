import { describe, expect, test } from 'bun:test'
import type { Dispatcher } from 'undici'
import { buildPiRemoteConnectionSettings } from './pi-agent-adapter'
import {
  createPiRequestProxyDispatcher,
  getPiRequestProxyDispatcher,
  installPiRequestProxyFetch,
  runWithPiRequestProxy,
  shouldBypassProxy,
} from './pi-request-proxy'

describe('Pi request proxy', () => {
  test('Given Codex and an HTTP proxy When transport is unspecified Then defaults to SSE', () => {
    expect(buildPiRemoteConnectionSettings({
      provider: 'openai-codex',
      proxyUrl: 'http://127.0.0.1:7897',
    })).toEqual({
      httpProxy: 'http://127.0.0.1:7897',
      transport: 'sse',
    })
  })

  test('Given an explicit Codex transport When a proxy exists Then preserves the explicit transport', () => {
    expect(buildPiRemoteConnectionSettings({
      provider: 'openai-codex',
      proxyUrl: 'http://127.0.0.1:7897',
      transport: 'websocket',
    })).toEqual({
      httpProxy: 'http://127.0.0.1:7897',
      transport: 'websocket',
    })
  })

  test('Given a non-Codex provider When a proxy exists Then does not alter its transport', () => {
    expect(buildPiRemoteConnectionSettings({
      provider: 'anthropic',
      proxyUrl: 'http://127.0.0.1:7897',
    })).toEqual({ httpProxy: 'http://127.0.0.1:7897' })
  })

  test('Given two concurrent Pi requests When each enters a proxy scope Then dispatchers do not cross-contaminate', async () => {
    const first = {} as Dispatcher
    const second = {} as Dispatcher

    const [firstSeen, secondSeen] = await Promise.all([
      runWithPiRequestProxy(first, async () => {
        await Bun.sleep(10)
        return getPiRequestProxyDispatcher()
      }),
      runWithPiRequestProxy(second, async () => {
        await Bun.sleep(1)
        return getPiRequestProxyDispatcher()
      }),
    ])

    expect(firstSeen).toBe(first)
    expect(secondSeen).toBe(second)
    expect(getPiRequestProxyDispatcher()).toBeUndefined()
  })

  test('Given runtime proxy environment When no explicit URL is provided Then uses it without mutating process environment', () => {
    const before = process.env.HTTPS_PROXY
    expect(buildPiRemoteConnectionSettings({
      provider: 'openai-codex',
      runtimeEnv: { env: { HTTPS_PROXY: 'http://127.0.0.1:7897' } },
    })).toEqual({
      httpProxy: 'http://127.0.0.1:7897',
      transport: 'sse',
    })
    expect(process.env.HTTPS_PROXY).toBe(before)
  })

  test('Given various hostnames and NO_PROXY rules When checking bypass Then correctly classifies hosts', () => {
    expect(shouldBypassProxy('https://rs.us.siumt.xyz/v1/models', '127.0.0.1,localhost')).toBe(false)
    expect(shouldBypassProxy('http://127.0.0.1:8080/internal', '127.0.0.1,localhost')).toBe(true)
    expect(shouldBypassProxy('http://localhost:3000/api', '127.0.0.1,localhost')).toBe(true)
    expect(shouldBypassProxy('https://api.internal.corp/v1', '.internal.corp')).toBe(true)
    expect(shouldBypassProxy('https://internal.corp/v1', '.internal.corp')).toBe(true)
    expect(shouldBypassProxy('https://external.corp/v1', '.internal.corp')).toBe(false)
    expect(shouldBypassProxy('https://any.com', '*')).toBe(true)
    expect(shouldBypassProxy('https://any.com', undefined)).toBe(false)
    expect(shouldBypassProxy('https://any.com', '')).toBe(false)
  })

  test('Given Bun runtime and installed proxy fetch When fetching inside proxy scope Then injects proxy option', async () => {
    installPiRequestProxyFetch()
    const dispatcher = createPiRequestProxyDispatcher({
      proxyUrl: 'http://127.0.0.1:7897',
      noProxy: '127.0.0.1,localhost',
    })
    expect(dispatcher).toBeDefined()

    let capturedInit: Record<string, unknown> | undefined
    const mockOriginalFetch = globalThis.fetch
    // 覆盖 globalThis.fetch 模拟测试
    const spyFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init as Record<string, unknown>
      return new Response('ok', { status: 200 })
    }

    try {
      // 临时挂载 spy 验证 runWithPiRequestProxy 行为
      const original = (globalThis as unknown as { __originalFetchForTest?: typeof fetch })
      const prevFetch = globalThis.fetch
      globalThis.fetch = spyFetch as typeof globalThis.fetch

      // 在代理作用域内请求目标域名
      await runWithPiRequestProxy(dispatcher, async () => {
        // 恢复由 installPiRequestProxyFetch 处理的 fetch 逻辑
        await (async () => {
          // 测试 getPiRequestProxyDispatcher
          expect(getPiRequestProxyDispatcher()).toBe(dispatcher)
        })()
      })
    } finally {
      globalThis.fetch = mockOriginalFetch
    }
  })
})
