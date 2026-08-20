import { describe, expect, test } from 'bun:test'
import { WorkingApiClient, WorkingApiError } from './working-api-client'
import type { WorkingTokenStore } from './working-auth-store'
import type { WorkingUser } from '@copis/shared'

interface FakeStoreState {
  token: string | null
  refreshToken: string | null
  user: WorkingUser | null
  provider: 'legacy' | 'oidc' | null
}

function createStore(): WorkingTokenStore {
  const state: FakeStoreState = {
    token: null,
    refreshToken: null,
    user: null,
    provider: null,
  }
  return {
    getToken: () => state.token,
    getRefreshToken: () => state.refreshToken,
    getUser: () => state.user,
    getProvider: () => state.provider,
    save: (token, user = null, refreshToken, provider) => {
      state.token = token
      state.user = user
      state.refreshToken = refreshToken ?? null
      state.provider = provider ?? null
    },
    clear: () => {
      state.token = null
      state.refreshToken = null
      state.user = null
      state.provider = null
    },
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function createClient(fetchImpl: (input: string, init?: RequestInit) => Promise<Response>): WorkingApiClient {
  return new WorkingApiClient({
    baseUrl: 'http://127.0.0.1:51888',
    fetchImpl,
    tokenStore: createStore(),
  })
}

describe('Copis Rust Working facade', () => {
  test('登录只请求本机 Rust，并且不把 access token 写入 Electron facade', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const client = createClient(async (url, init) => {
      calls.push({ url, init })
      expect(new Headers(init?.headers).get('Authorization')).toBeNull()
      expect(url).toBe('http://127.0.0.1:51888/api/working/login')
      return jsonResponse({
        authenticated: true,
        user: { id: 7, email: 'user@example.com' },
        expiresAt: 1_900_000_000,
      })
    })

    const result = await client.login({ email: ' user@example.com ', password: 'password' })

    expect(result.token).toBe('')
    expect(result.user).toEqual(expect.objectContaining({ id: 7, email: 'user@example.com' }))
    expect(client.getToken()).toBeNull()
    expect(calls).toHaveLength(1)
  })

  test('OIDC 只打开 Rust 返回的授权地址，并通过本机 auth-state 轮询完成', async () => {
    const calls: string[] = []
    let stateReads = 0
    const client = createClient(async (url) => {
      calls.push(url)
      if (url.endsWith('/api/working/login-oidc')) {
        return jsonResponse({ authorizationUrl: 'https://auth.example.test/authorize?state=opaque' })
      }
      if (url.endsWith('/api/working/auth-state')) {
        stateReads += 1
        return jsonResponse(stateReads === 1
          ? { authenticated: false, user: null }
          : { authenticated: true, user: { id: 7, email: 'oidc@example.com' } })
      }
      throw new Error(`unexpected local request: ${url}`)
    })
    let openedUrl = ''

    const result = await client.loginWithOAuth(async (url) => {
      openedUrl = url
    })

    expect(openedUrl).toBe('https://auth.example.test/authorize?state=opaque')
    expect(result.token).toBe('')
    expect(result.user).toEqual(expect.objectContaining({ id: 7, email: 'oidc@example.com' }))
    expect(calls[0]?.endsWith('/api/working/login-oidc')).toBe(true)
    expect(calls.slice(1).every((url) => url.endsWith('/api/working/auth-state'))).toBe(true)
  })

  test('Rust API 尚未 ready 时，OIDC 登录等待后只重试本机请求', async () => {
    let startCalls = 0
    let authStateCalls = 0
    const client = createClient(async (url) => {
      if (url.endsWith('/api/working/login-oidc')) {
        startCalls += 1
        if (startCalls === 1) throw new Error('fetch failed')
        return jsonResponse({ authorizationUrl: 'https://auth.example.test/authorize?state=ready' })
      }
      if (url.endsWith('/api/working/auth-state')) {
        authStateCalls += 1
        return jsonResponse({ authenticated: true, user: { id: 8, email: 'ready@example.com' } })
      }
      throw new Error(`unexpected local request: ${url}`)
    })

    let openedUrl = ''
    await expect(client.loginWithOAuth(async (url) => {
      openedUrl = url
    })).resolves.toEqual(expect.objectContaining({
      user: expect.objectContaining({ id: 8 }),
    }))

    expect(startCalls).toBe(2)
    expect(authStateCalls).toBe(1)
    expect(openedUrl).toContain('state=ready')
  })

  test('旧 Rust 模块拒绝 Working 业务时，OIDC 登录不重复请求', async () => {
    let calls = 0
    const client = createClient(async () => {
      calls += 1
      return jsonResponse({ error: 'Working 业务桥已禁用', code: 'working_bridge_disabled' }, 410)
    })

    await expect(client.loginWithOAuth(async () => {})).rejects.toMatchObject({
      status: 410,
      code: 'working_bridge_disabled',
    })
    expect(calls).toBe(1)
  })

  test('启动竞态下认证状态读取会等待本机 Rust API ready', async () => {
    let calls = 0
    const client = createClient(async (url) => {
      calls += 1
      if (calls === 1) throw new Error('fetch failed')
      expect(url).toBe('http://127.0.0.1:51888/api/working/auth-state')
      return jsonResponse({ authenticated: true, user: { id: 7, email: 'ready@example.com' } })
    })

    await expect(client.getAuthState()).resolves.toEqual(expect.objectContaining({
      authenticated: true,
      user: expect.objectContaining({ id: 7, email: 'ready@example.com' }),
    }))
    expect(calls).toBe(2)
  })

  test('Rust 业务 503 只发送一次，不由 Electron facade 重试', async () => {
    let calls = 0
    const client = createClient(async () => {
      calls += 1
      return jsonResponse({ error: '暂时不可用', code: 'upstream_unavailable' }, 503)
    })

    await expect(client.listSessions()).rejects.toMatchObject({
      status: 503,
      code: 'upstream_unavailable',
    })
    expect(calls).toBe(1)
  })

  test('Rust 401 直接返回，不在 Electron 重放或刷新 token', async () => {
    let calls = 0
    const client = createClient(async () => {
      calls += 1
      return jsonResponse({ error: '未登录', code: 'unauthorized' }, 401)
    })

    await expect(client.listSessions()).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    })
    expect(calls).toBe(1)
    await expect(client.refreshAccessToken()).rejects.toMatchObject({
      status: 410,
      code: 'rust_auth_session_owned',
    })
  })

  test('远端 URL 只能作为显式测试注入，默认 facade 始终指向本机 Rust', () => {
    const client = new WorkingApiClient({ tokenStore: createStore() })
    expect(new URL(client.baseUrl).hostname).toBe('127.0.0.1')
  })
})
