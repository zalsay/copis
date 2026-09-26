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
  test('Given facade 缓存账号 A When Rust auth storage adopts B Then cached user immediately becomes B', () => {
    const client = new WorkingApiClient({ tokenStore: createStore() })
    client.setAuthenticatedUserFromRust({ id: 'A' })
    expect(client.getCachedUser()).toEqual(expect.objectContaining({ id: 'A' }))

    const accepted = client.setAuthenticatedUserFromRust({ id: 'B', email: 'b@example.com' })

    expect(accepted).toBe(true)
    expect(client.getCachedUser()).toEqual(expect.objectContaining({ id: 'B', email: 'b@example.com' }))
  })

  test('迟到的 auth-state A 响应不能覆盖已切换到的 B', async () => {
    let resolveResponse!: (response: Response) => void
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const client = createClient(async () => new Promise<Response>((resolve) => {
      resolveResponse = resolve
      markStarted()
    }))
    client.setAuthenticatedUserFromRust({ id: 'A' })

    const stateRequest = client.getAuthState()
    await started
    client.setAuthenticatedUserFromRust({ id: 'B' })
    resolveResponse(jsonResponse({ authenticated: true, user: { id: 'A' } }))

    await expect(stateRequest).resolves.toEqual({ authenticated: true, user: expect.objectContaining({ id: 'B' }) })
    expect(client.getCachedUser()).toEqual(expect.objectContaining({ id: 'B' }))
  })

  test('迟到的 logout 完成不能清除并发登录的新账号缓存', async () => {
    let resolveResponse!: (response: Response) => void
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const client = createClient(async () => new Promise<Response>((resolve) => {
      resolveResponse = resolve
      markStarted()
    }))
    client.setAuthenticatedUserFromRust({ id: 'A' })

    const logoutRequest = client.logout()
    await started
    client.setAuthenticatedUserFromRust({ id: 'B' })
    resolveResponse(jsonResponse({ authenticated: false, user: null }))
    await logoutRequest

    expect(client.getCachedUser()).toEqual(expect.objectContaining({ id: 'B' }))
  })

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

  test('浏览器云同步先验证账号隔离能力，旧网关不接收同步 payload', async () => {
    const calls: Array<{ url: string; method: string }> = []
    const client = createClient(async (url, init) => {
      calls.push({ url, method: init?.method ?? 'GET' })
      return jsonResponse({ error: 'not found', code: 'not_found' }, 404)
    })

    await expect(client.syncBrowserData({
      clientDeviceId: 'device',
      clientCursor: 0,
      expectedUserId: 'user-1',
      changes: { groups: [], bookmarks: [], pageProfiles: [] },
    })).rejects.toMatchObject({
      code: 'browser_sync_capability_required',
      message: '请更新浏览器云同步所需的本地服务',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toEndWith('/api/working/browser/sync/capabilities')
  })

  test('Given 本地已声明账号隔离同步能力 When 云端同步接口返回 404 Then 显示云端接口未提供且保留稳定错误码', async () => {
    const calls: Array<{ url: string; method: string }> = []
    const client = createClient(async (url, init) => {
      calls.push({ url, method: init?.method ?? 'GET' })
      if (url.endsWith('/api/working/browser/sync/capabilities')) {
        return jsonResponse({ accountBoundSync: true, protocolVersion: 1 })
      }
      return jsonResponse({ error: 'not found', code: 'not_found' }, 404)
    })

    await expect(client.syncBrowserData({
      clientDeviceId: 'device',
      clientCursor: 0,
      expectedUserId: 'user-1',
      changes: { groups: [], bookmarks: [], pageProfiles: [] },
    })).rejects.toMatchObject({
      status: 404,
      code: 'browser_sync_endpoint_unavailable',
      message: '云端尚未提供浏览器同步接口',
    })
    expect(calls.map(({ method }) => method)).toEqual(['GET', 'POST'])
    expect(calls[1]?.url).toEndWith('/api/working/browser/sync')
  })

  const browserSyncPostFailures = [
    { label: '401 认证失败', status: 401, code: 'unauthorized', message: 'Working 账号认证失败' },
    { label: '409 账号冲突', status: 409, code: 'browser_sync_user_mismatch', message: '浏览器同步账号与当前账号不一致' },
    { label: '500 服务错误', status: 500, code: 'internal_error', message: '云端同步服务暂时不可用' },
  ] as const

  for (const failure of browserSyncPostFailures) {
    test(`Given 本地能力检查通过且云端返回 ${failure.label} When 浏览器数据同步 Then 原样保留错误且不重放请求`, async () => {
      const calls: Array<{ url: string; method: string }> = []
      const client = createClient(async (url, init) => {
        calls.push({ url, method: init?.method ?? 'GET' })
        if (url.endsWith('/api/working/browser/sync/capabilities')) {
          return jsonResponse({ accountBoundSync: true, protocolVersion: 1 })
        }
        return jsonResponse({ error: failure.message, code: failure.code }, failure.status)
      })

      await expect(client.syncBrowserData({
        clientDeviceId: 'device',
        clientCursor: 0,
        expectedUserId: 'user-1',
        changes: { groups: [], bookmarks: [], pageProfiles: [] },
      })).rejects.toMatchObject({
        status: failure.status,
        code: failure.code,
        message: failure.message,
      })
      expect(calls.map(({ method }) => method)).toEqual(['GET', 'POST'])
      expect(calls[1]?.url).toEndWith('/api/working/browser/sync')
    })
  }

  test('浏览器同步能力检查网络错误保留真实错误，且不发送同步 payload', async () => {
    const calls: string[] = []
    const client = createClient(async (url) => {
      calls.push(url)
      throw new Error('network down')
    })

    await expect(client.syncBrowserData({
      clientDeviceId: 'device',
      clientCursor: 0,
      expectedUserId: 'user-1',
      changes: { groups: [], bookmarks: [], pageProfiles: [] },
    })).rejects.toMatchObject({ code: 'network_error' })
    expect(calls).toHaveLength(1)
  })

  test('浏览器同步携带预期用户并在网关确认能力后才 POST', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = []
    const client = createClient(async (url, init) => {
      calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined })
      if (url.endsWith('/api/working/browser/sync/capabilities')) {
        return jsonResponse({ accountBoundSync: true, protocolVersion: 1 })
      }
      return jsonResponse({ serverCursor: 12, serverChanges: { groups: [], bookmarks: [], pageProfiles: [] } })
    })

    const response = await client.syncBrowserData({
      clientDeviceId: 'device',
      clientCursor: 11,
      expectedUserId: 'user-1',
      changes: { groups: [], bookmarks: [], pageProfiles: [] },
    })

    expect(response.serverCursor).toBe(12)
    expect(calls.map(({ method }) => method)).toEqual(['GET', 'POST'])
    expect(JSON.parse(calls[1]!.body!).expectedUserId).toBe('user-1')
  })

  test('远端 URL 只能作为显式测试注入，默认 facade 始终指向本机 Rust', () => {
    const client = new WorkingApiClient({ tokenStore: createStore() })
    expect(new URL(client.baseUrl).hostname).toBe('127.0.0.1')
  })

  test('Given 正式 App 继承开发端口变量 When 创建 Working facade Then 使用 51730', () => {
    const previousPort = process.env.COPIS_HTTP_API_PORT
    process.env.COPIS_HTTP_API_PORT = '51740'
    try {
      const client = new WorkingApiClient({
        tokenStore: createStore(),
        isPackaged: true,
      })
      expect(client.baseUrl).toBe('http://127.0.0.1:51730')
    } finally {
      if (previousPort === undefined) delete process.env.COPIS_HTTP_API_PORT
      else process.env.COPIS_HTTP_API_PORT = previousPort
    }
  })

  test('Given 后端返回带有 discount 字段的流水 When 读取设置快照 Then 正确解析 discount 与 deductionMultiplier', async () => {
    const client = createClient(async (url) => {
      if (url.endsWith('/api/working/settings')) {
        return jsonResponse({
          user: { id: 7, email: 'user@example.com', tokens: 100 },
          ledger: [
            {
              id: 'ledger-80',
              payer_user_id: 7,
              amount_tokens: 1.5,
              type: 'charge',
              source_type: 'working_model',
              alias: 'fast',
              discount: 80,
            },
            {
              id: 'ledger-60',
              payer_user_id: 7,
              amount_tokens: 2.0,
              type: 'charge',
              source_type: 'copis-agent-model',
              alias: 'export',
              discount_percent: 60,
            },
          ],
        })
      }
      throw new Error(`unexpected url: ${url}`)
    })

    const snapshot = await client.getSettingsSnapshot()
    expect(snapshot.ledger).toHaveLength(2)
    expect(snapshot.ledger[0]?.discount).toBe(80)
    expect(snapshot.ledger[0]?.deductionMultiplier).toBe(80)
    expect(snapshot.ledger[1]?.discount).toBe(60)
    expect(snapshot.ledger[1]?.deductionMultiplier).toBe(60)
  })
})
