import { describe, expect, test } from 'bun:test'
import { WorkingApiClient, WorkingApiError } from './working-api-client'

interface FakeStore {
  token: string | null
  refreshToken: string | null
  user: import('@copis/shared').WorkingUser | null
  provider: 'legacy' | 'oidc' | null
}

function createStore(initialToken: string | null = null, initialRefreshToken: string | null = null, initialProvider: FakeStore['provider'] = null): FakeStore & import('./working-auth-store').WorkingTokenStore {
  const state: FakeStore = { token: initialToken, refreshToken: initialRefreshToken, user: null, provider: initialProvider }
  return {
    getToken: () => state.token,
    getRefreshToken: () => state.refreshToken,
    getUser: () => state.user,
    getProvider: () => state.provider,
    save: (token, user = null, refreshToken, provider) => {
      state.token = token
      state.user = user
      if (refreshToken !== undefined) state.refreshToken = refreshToken
      if (provider !== undefined) state.provider = provider
    },
    clear: () => { state.token = null; state.refreshToken = null; state.user = null; state.provider = null },
    get token() { return state.token },
    get refreshToken() { return state.refreshToken },
    get user() { return state.user },
    get provider() { return state.provider },
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function jwtWithExpiry(expiresInMs: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor((Date.now() + expiresInMs) / 1000) })).toString('base64url')
  return `header.${payload}.signature`
}

describe('Copis Working API client', () => {
  test('normalizes backend URL and keeps the bearer token in the main-process store', async () => {
    const store = createStore()
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const client = new WorkingApiClient({
      baseUrl: 'http://localhost:9000/module/edu-api/',
      tokenStore: store,
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        if (url.endsWith('/api/auth/login')) {
          expect(new Headers(init?.headers).get('Authorization')).toBeNull()
          return jsonResponse({ token: 'secret-token', refresh_token: 'refresh-secret', user_id: 7, is_admin: true, account_type: 'normal', role: 'parent' })
        }
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer secret-token')
        return jsonResponse({ data: { ID: 7, Email: 'user@example.com', Nickname: 'Copis 用户', IsAdmin: true, AccountType: 'normal', Tokens: 123.5, IsVIP: true, VIPExpiresAt: '2026-12-31T00:00:00Z', Password: 'must-not-persist' } })
      },
    })

    const result = await client.login({ email: ' user@example.com ', password: 'password' })

    expect(client.baseUrl).toBe('http://localhost:9000/module/edu-api')
    expect(result.token).toBe('secret-token')
    expect(result.refreshToken).toBe('refresh-secret')
    expect(result.user?.email).toBe('user@example.com')
    expect(result.user?.id).toBe(7)
    expect(result.user?.isAdmin).toBe(true)
    expect(result.user?.accountType).toBe('normal')
    expect(result.user?.tokens).toBe(123.5)
    expect(result.user?.isVip).toBe(true)
    expect(result.user).not.toHaveProperty('Password')
    expect(store.token).toBe('secret-token')
    expect(store.refreshToken).toBe('refresh-secret')
    expect(store.user).toEqual(expect.objectContaining({ id: 7, nickname: 'Copis 用户', role: 'parent' }))
    expect(store.user).not.toHaveProperty('Password')
    expect(calls.map((call) => call.url)).toEqual([
      'http://localhost:9000/module/edu-api/api/auth/login',
      'http://localhost:9000/module/edu-api/api/users/me',
    ])
  })

  test('refreshes an expiring access token in the main process and persists the rotated credentials', async () => {
    const store = createStore(jwtWithExpiry(60_000), 'refresh-secret')
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const client = new WorkingApiClient({
      baseUrl: 'https://backend.example.test',
      tokenStore: store,
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        expect(url).toBe('https://backend.example.test/api/auth/refresh')
        expect(new Headers(init?.headers).get('Authorization')).toBeNull()
        expect(init?.body).toBe(JSON.stringify({ refresh_token: 'refresh-secret' }))
        return jsonResponse({ token: 'new-access-token', refresh_token: 'new-refresh-token' })
      },
    })

    await expect(client.getValidToken()).resolves.toBe('new-access-token')
    expect(calls).toHaveLength(1)
    expect(store.token).toBe('new-access-token')
    expect(store.refreshToken).toBe('new-refresh-token')
  })

  test('通过 OIDC 授权登录并以 oidc provider 保存凭据', async () => {
    const store = createStore()
    let openedUrl = ''
    const client = new WorkingApiClient({
      baseUrl: 'https://backend.example.test',
      tokenStore: store,
      oidcClientFactory: (openExternal) => ({
        authorize: async () => {
          await openExternal('https://auth.example.test/oauth/authorize?state=test')
          return {
            accessToken: 'oidc-access-token',
            refreshToken: 'oidc-refresh-token',
            tokenType: 'Bearer',
            expiresIn: 900,
          }
        },
      }),
      fetchImpl: async (url, init) => {
        expect(url).toBe('https://backend.example.test/api/users/me')
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer oidc-access-token')
        return jsonResponse({ data: { ID: 7, Email: 'oidc@example.com', Nickname: 'OIDC 用户' } })
      },
    })

    const result = await client.loginWithOAuth(async (url) => { openedUrl = url })

    expect(openedUrl).toContain('https://auth.example.test/oauth/authorize')
    expect(result.token).toBe('oidc-access-token')
    expect(result.refreshToken).toBe('oidc-refresh-token')
    expect(store.token).toBe('oidc-access-token')
    expect(store.refreshToken).toBe('oidc-refresh-token')
    expect(store.provider).toBe('oidc')
    expect(store.user).toEqual(expect.objectContaining({ id: 7, email: 'oidc@example.com' }))
  })

  test('OIDC access token 刷新调用 Auth token endpoint 并保存轮换后的 refresh token', async () => {
    const store = createStore('oidc-access-token', 'oidc-refresh-token', 'oidc')
    let requestUrl = ''
    let requestInit: RequestInit | undefined
    const client = new WorkingApiClient({
      baseUrl: 'https://backend.example.test',
      authIssuer: 'https://auth.example.test/module/auth',
      tokenStore: store,
      fetchImpl: async (url, init) => {
        requestUrl = url
        requestInit = init
        if (url === 'https://auth.example.test/module/auth/.well-known/openid-configuration') {
          return jsonResponse({
            issuer: 'https://auth.example.test/module/auth',
            authorization_endpoint: 'https://auth.example.test/module/auth/oauth/authorize',
            token_endpoint: 'https://auth.example.test/module/auth/oauth/token',
          })
        }
        expect(url).toBe('https://auth.example.test/module/auth/oauth/token')
        return jsonResponse({ access_token: 'rotated-access-token', refresh_token: 'rotated-refresh-token', token_type: 'Bearer', expires_in: 900 })
      },
    })

    await expect(client.refreshAccessToken()).resolves.toBe('rotated-access-token')
    expect(requestUrl).toBe('https://auth.example.test/module/auth/oauth/token')
    expect(requestInit?.method).toBe('POST')
    expect(new Headers(requestInit?.headers).get('Authorization')).toBeNull()
    expect(new Headers(requestInit?.headers).get('Content-Type')).toBe('application/x-www-form-urlencoded')
    const body = new URLSearchParams(String(requestInit?.body))
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('client_id')).toBe('copis-desktop')
    expect(body.get('refresh_token')).toBe('oidc-refresh-token')
    expect(store.token).toBe('rotated-access-token')
    expect(store.refreshToken).toBe('rotated-refresh-token')
    expect(store.provider).toBe('oidc')
  })

  test('OIDC refresh 先读取 discovery 的 token endpoint，并保留未轮换的 refresh token', async () => {
    const store = createStore('oidc-access-token', 'oidc-refresh-token', 'oidc')
    const calls: string[] = []
    const client = new WorkingApiClient({
      baseUrl: 'https://backend.example.test',
      authIssuer: 'https://auth.example.test/module/auth',
      tokenStore: store,
      fetchImpl: async (url, init) => {
        calls.push(url)
        if (url === 'https://auth.example.test/module/auth/.well-known/openid-configuration') {
          expect(init?.method).toBeUndefined()
          return jsonResponse({
            issuer: 'https://auth.example.test/module/auth',
            authorization_endpoint: 'https://auth.example.test/module/auth/oauth/authorize',
            token_endpoint: 'https://auth.example.test/module/auth/oauth2/token',
          })
        }
        expect(url).toBe('https://auth.example.test/module/auth/oauth2/token')
        return jsonResponse({ access_token: 'rotated-access-token', token_type: 'Bearer', expires_in: 900 })
      },
    })

    await expect(client.refreshAccessToken()).resolves.toBe('rotated-access-token')
    expect(calls).toEqual([
      'https://auth.example.test/module/auth/.well-known/openid-configuration',
      'https://auth.example.test/module/auth/oauth2/token',
    ])
    expect(store.token).toBe('rotated-access-token')
    expect(store.refreshToken).toBe('oidc-refresh-token')
    expect(store.provider).toBe('oidc')
  })

  test('OIDC invalid_grant refresh 失败时清理本地认证状态', async () => {
    const store = createStore('oidc-access-token', 'revoked-refresh-token', 'oidc')
    const client = new WorkingApiClient({
      baseUrl: 'https://backend.example.test',
      authIssuer: 'https://auth.example.test/module/auth',
      tokenStore: store,
      fetchImpl: async (url) => {
        if (url.endsWith('/.well-known/openid-configuration')) {
          return jsonResponse({
            issuer: 'https://auth.example.test/module/auth',
            authorization_endpoint: 'https://auth.example.test/module/auth/oauth/authorize',
            token_endpoint: 'https://auth.example.test/module/auth/oauth/token',
          })
        }
        return jsonResponse({ error: 'invalid_grant', error_description: 'refresh token 已失效' }, 400)
      },
    })

    await expect(client.refreshAccessToken()).rejects.toMatchObject({ status: 400, code: 'invalid_grant' })
    expect(store.token).toBeNull()
    expect(store.refreshToken).toBeNull()
    expect(store.provider).toBeNull()
  })

  test('refreshes credentials and user level immediately after VIP payment is fulfilled', async () => {
    const store = createStore('old-access-token', 'refresh-secret')
    const client = new WorkingApiClient({
      baseUrl: 'https://backend.example.test',
      tokenStore: store,
      fetchImpl: async (url, init) => {
        if (url.endsWith('/api/auth/refresh')) {
          expect(init?.body).toBe(JSON.stringify({ refresh_token: 'refresh-secret' }))
          return jsonResponse({ token: 'vip-access-token', refresh_token: 'vip-refresh-token' })
        }
        if (url.endsWith('/api/users/me')) {
          expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer vip-access-token')
          return jsonResponse({ data: { ID: 7, Email: 'user@example.com', Nickname: 'Copis 用户', IsVIP: true } })
        }
        throw new Error(`unexpected request: ${url}`)
      },
    })

    await expect(client.refreshAfterVipPayment()).resolves.toEqual({
      userId: '7',
      isVip: true,
    })
    expect(store.token).toBe('vip-access-token')
    expect(store.refreshToken).toBe('vip-refresh-token')
    expect(store.user).toEqual(expect.objectContaining({ id: 7, isVip: true }))
  })

  test('maps snake_case Working responses and encodes history identifiers', async () => {
    const store = createStore('token')
    const calls: string[] = []
    const client = new WorkingApiClient({
      baseUrl: 'https://backend.example.test',
      tokenStore: store,
      fetchImpl: async (url) => {
        calls.push(url)
        if (url.endsWith('/api/working/workspaces')) {
          return jsonResponse({ data: [{ id: 3, workspace_path: '/Users/me/project', pc_id: 'pc-1', workspace_type: 'local', is_default: false }] })
        }
        if (url.includes('/history')) {
          return jsonResponse({ data: { run_id: 'run/1', session_id: 'session-1', jsonl: '{"type":"thread.started"}' } })
        }
        return jsonResponse({ data: [{ run_id: 'run-1', title: '整理周报', final_text: '完成', status: 'completed' }] })
      },
    })

    await expect(client.listWorkspaces()).resolves.toEqual([
      expect.objectContaining({ workspacePath: '/Users/me/project', pcId: 'pc-1', workspaceType: 'local' }),
    ])
    await expect(client.listSessions()).resolves.toEqual([
      expect.objectContaining({ runId: 'run-1', finalText: '完成', title: '整理周报' }),
    ])
    await expect(client.getSessionHistory('run/1', 'session with space')).resolves.toEqual(
      expect.objectContaining({ runId: 'run/1', sessionId: 'session-1' }),
    )
    expect(calls.at(-1)).toBe('https://backend.example.test/api/working/sessions/run%2F1/history?session_id=session%20with%20space')
  })

  test('uses read-only workspace writes by default when saving a Working workspace', async () => {
    let requestBody = ''
    const client = new WorkingApiClient({
      baseUrl: 'https://backend.example.test',
      tokenStore: createStore('workspace-token'),
      fetchImpl: async (_url, init) => {
        requestBody = String(init?.body ?? '')
        return jsonResponse({ id: 1, workspace_path: '/Users/me/project', allow_workspace_write: false })
      },
    })

    await client.saveWorkspace({ workspacePath: '/Users/me/project' })

    expect(JSON.parse(requestBody)).toEqual(expect.objectContaining({ allow_workspace_write: false }))
  })

  test('generates a Working image through the edu-api endpoint and normalizes the response', async () => {
    let requestUrl = ''
    let requestBody = ''
    const client = new WorkingApiClient({
      baseUrl: 'https://backend.example.test',
      tokenStore: createStore('image-token'),
      fetchImpl: async (url, init) => {
        requestUrl = String(url)
        requestBody = String(init?.body ?? '')
        return jsonResponse({
          data: {
            image_url: 'https://cos.example/generated.png?token=short',
            data_url: 'data:image/png;base64,iVBORw0KGgo=',
            content_type: 'image/png',
            output_hint: '',
            deducted_tokens: 2,
            balance_after: 98,
          },
        })
      },
    })

    const result = await client.generateWorkingImage({ prompt: '一只戴帽子的猫', size: '1024x1024', runId: 'session-1' })

    expect(requestUrl).toBe('https://backend.example.test/api/working/images/generate')
    expect(JSON.parse(requestBody)).toEqual({ prompt: '一只戴帽子的猫', size: '1024x1024', run_id: 'session-1' })
    expect(result).toEqual({
      imageUrl: 'https://cos.example/generated.png?token=short',
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      contentType: 'image/png',
      deductedTokens: 2,
      balanceAfter: 98,
    })
  })

  test('supports the ai-education auth flow without exposing credentials to the renderer contract', async () => {
    const client = new WorkingApiClient({
      baseUrl: 'https://backend.example.test',
      tokenStore: createStore(),
      fetchImpl: async (url) => {
        if (url.endsWith('/api/auth/register')) return jsonResponse({ data: { ID: 8, Email: 'new@example.com', Nickname: '新用户' } })
        if (url.endsWith('/api/auth/send-code')) return jsonResponse({ message: 'ok' })
        if (url.endsWith('/api/auth/verify-code')) return jsonResponse({ reset_token: 'reset-token' })
        if (url.endsWith('/api/auth/password/reset')) return jsonResponse({ message: 'ok' })
        throw new Error(`unexpected request: ${url}`)
      },
    })

    await expect(client.register({ email: 'new@example.com', password: 'password', verificationCode: '1234' })).resolves.toEqual(
      expect.objectContaining({ id: 8, email: 'new@example.com', nickname: '新用户' }),
    )
    await expect(client.sendVerificationCode({ email: 'new@example.com', purpose: 'register' })).resolves.toBeUndefined()
    await expect(client.verifyPasswordResetCode({ email: 'new@example.com', code: '1234' })).resolves.toEqual({ resetToken: 'reset-token' })
    await expect(client.resetPassword({ email: 'new@example.com', resetToken: 'reset-token', password: 'new-password' })).resolves.toBeUndefined()
  })

  test('loads the ai-education Working settings content in one renderer-safe snapshot', async () => {
    const client = new WorkingApiClient({
      baseUrl: 'https://backend.example.test',
      tokenStore: createStore('settings-token'),
      fetchImpl: async (url) => {
        if (url.endsWith('/api/users/me')) {
          return jsonResponse({
            data: { ID: 7, Email: 'user@example.com', Nickname: '设置用户', Tokens: 123.5, IsVIP: false },
            has_checked_in: true,
            vip: { is_vip: false, diamonds: 123.5, quota_label: '500M', upgrade_days: 30 },
          })
        }
        if (url.endsWith('/api/users/invited')) return jsonResponse({ data: [{ id: 8, email: 'child@example.com', nickname: '孩子', tokens: 20 }] })
        if (url.endsWith('/api/family/wallet')) {
          return jsonResponse({ data: {
            members: [{ user_id: 7, role: 'owner', display_name: '设置用户', tokens: 123.5 }],
            ledger: [{ id: 1, payer_user_id: 7, beneficiary_user_id: 7, amount_tokens: 100, type: 'purchase', source_type: 'alipay_diamond', memo: '支付宝获取钻石', created_at: '2026-01-02T08:00:00Z' }],
          } })
        }
        if (url.endsWith('/api/users/billing-ledger')) return jsonResponse({ data: [{ id: 1, payer_user_id: 7, amount_tokens: 3, type: 'charge', source_type: 'pi_office_model', alias: 'fast', created_at: '2026-01-01T08:00:00Z' }] })
        if (url.endsWith('/api/users/orders?page=1&page_size=50')) {
          return jsonResponse({ data: {
            items: [{ id: 2, out_trade_no: 'PAID-2', order_type: 'diamond_recharge', title: '钻石充值', amount: '9.90', currency: 'CNY', diamonds: 100, method: 'alipay', status: 'paid', paid_at: '2026-01-03T08:00:00Z' }],
            pagination: { page: 1, page_size: 50, total: 1, total_pages: 1 },
          } })
        }
        if (url.endsWith('/api/users/invite-code')) return jsonResponse({ data: { Code: 'invite-7' }, invite_link: 'https://example.test/auth?invite=invite-7' })
        if (url.endsWith('/api/working/receive-channel')) return jsonResponse({ data: { channel: 'weixin', weixin_bound: true, feishu_bound: false } })
        throw new Error(`unexpected request: ${url}`)
      },
    })

    await expect(client.getSettingsSnapshot()).resolves.toEqual(expect.objectContaining({
      hasCheckedIn: true,
      invitedUsers: [expect.objectContaining({ nickname: '孩子' })],
      inviteCode: 'invite-7',
      inviteLink: 'https://example.test/auth?invite=invite-7',
      receiveChannel: { channel: 'weixin', weixinBound: true, feishuBound: false },
      ledger: [
        expect.objectContaining({ id: 'order:2', type: 'purchase', sourceType: 'alipay_diamond', amountTokens: 100 }),
        expect.objectContaining({ sourceType: 'pi_office_model', modelAlias: 'fast', amountTokens: 3 }),
      ],
    }))
  })

  test('loads and hides Working orders with ai-education pagination semantics', async () => {
    const calls: Array<{ url: string; method: string }> = []
    const client = new WorkingApiClient({
      baseUrl: 'https://backend.example.test',
      tokenStore: createStore('orders-token'),
      fetchImpl: async (url, init) => {
        calls.push({ url, method: init?.method || 'GET' })
        if (url.endsWith('/api/users/orders?page=2&page_size=20')) {
          return jsonResponse({ data: {
            items: [{
              id: 12,
              out_trade_no: '202608010001',
              order_type: 'vip_upgrade',
              title: 'VIP 升级',
              amount: '29.90',
              currency: 'CNY',
              diamonds: 500,
              vip_days: 30,
              method: 'alipay',
              status: 'paid',
              created_at: '2026-08-01T08:00:00Z',
            }],
            pagination: { page: 2, page_size: 20, total: 21, total_pages: 2 },
          } })
        }
        if (url.endsWith('/api/users/orders/12')) return new Response(null, { status: 204 })
        throw new Error(`unexpected request: ${url}`)
      },
    })

    await expect(client.listOrders(2)).resolves.toEqual({
      items: [expect.objectContaining({ outTradeNo: '202608010001', orderType: 'vip_upgrade', vipDays: 30 })],
      pagination: { page: 2, pageSize: 20, total: 21, totalPages: 2 },
    })
    await expect(client.deleteOrder(12)).resolves.toBeUndefined()
    expect(calls).toEqual([
      { url: 'https://backend.example.test/api/users/orders?page=2&page_size=20', method: 'GET' },
      { url: 'https://backend.example.test/api/users/orders/12', method: 'DELETE' },
    ])
  })

  test('normalizes diamond packages, VIP pending payments, QR data URLs, and payment checks', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = []
    const previousRustApiBaseUrl = process.env.COPIS_HTTP_API_BASE_URL
    process.env.COPIS_HTTP_API_BASE_URL = 'http://127.0.0.1:51730'
    const client = new WorkingApiClient({
      baseUrl: 'https://backend.example.test',
      tokenStore: createStore('payment-token'),
      fetchImpl: async (url, init) => {
        calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined })
        if (url.endsWith('/api/working/diamond-packages')) {
          expect(new Headers(init?.headers).get('Authorization')).toBeNull()
          return jsonResponse({ data: [
            { id: 1, service_id: 'diamond', amount: '9.90', amount_cents: 990, currency: 'CNY', diamonds: 100 },
            { id: 2, service_id: 'pi-vip', amount: '29.90', amount_cents: 2990, currency: 'CNY', diamonds: 500 },
          ] })
        }
        if (url.endsWith('/api/working/vip/upgrade')) {
          expect(new Headers(init?.headers).get('Authorization')).toBeNull()
          return jsonResponse({ data: {
            out_trade_no: 'VIP-1',
            package: { id: 2, service_id: 'pi-vip', amount: '29.90', amount_cents: 2990, currency: 'CNY', diamonds: 500 },
            is_vip: true,
            pending_existing: true,
            payment: { payment_id: 'vip-payment', status: 'pending_user_pay', qrcode_image: 'vip-qr', qrcode_mime_type: 'image/png' },
            vip: { service_id: 'pi-vip', days: 30, amount: '29.90', amount_cents: 2990, bonus_diamonds: 500 },
          } })
        }
        if (url.includes('/api/working/diamond-purchases/pay%2F1/check')) {
          expect(new Headers(init?.headers).get('Authorization')).toBeNull()
          return jsonResponse({ skill: 'alipay.payment.check', ok: true, message: 'ok', data: {
            status: 'resource_ready',
            payment: { payment_id: 'pay/1', status: 'resource_ready', qrcode_image: 'data:image/png;base64,ready' },
          } })
        }
        throw new Error(`unexpected request: ${url}`)
      },
    })

    try {
      await expect(client.listDiamondPackages()).resolves.toEqual([
        expect.objectContaining({ id: 1, amount: '9.90', amountCents: 990, diamonds: 100 }),
      ])
      await expect(client.createVipUpgrade()).resolves.toEqual(expect.objectContaining({
        isVip: true,
        pendingExisting: true,
        payment: expect.objectContaining({ qrCodeImage: 'data:image/png;base64,vip-qr' }),
        vip: expect.objectContaining({ days: 30, bonusDiamonds: 500 }),
      }))
      await expect(client.checkPayment('pay/1')).resolves.toEqual({
        status: 'resource_ready',
        payment: expect.objectContaining({ paymentId: 'pay/1', qrCodeImage: 'data:image/png;base64,ready' }),
      })
      expect(calls).toEqual([
        { url: 'http://127.0.0.1:51730/api/working/diamond-packages', method: 'GET', body: undefined },
        { url: 'http://127.0.0.1:51730/api/working/vip/upgrade', method: 'POST', body: '{}' },
        { url: 'http://127.0.0.1:51730/api/working/diamond-purchases/pay%2F1/check', method: 'POST', body: '{}' },
      ])
    } finally {
      if (previousRustApiBaseUrl === undefined) delete process.env.COPIS_HTTP_API_BASE_URL
      else process.env.COPIS_HTTP_API_BASE_URL = previousRustApiBaseUrl
    }
  })

  test('refreshes once and retries a payment request after Rust returns HTTP 401', async () => {
    const store = createStore('stale-payment-token', 'refresh-secret')
    const calls: string[] = []
    let paymentRequestCount = 0
    const previousRustApiBaseUrl = process.env.COPIS_HTTP_API_BASE_URL
    process.env.COPIS_HTTP_API_BASE_URL = 'http://127.0.0.1:51730'
    const client = new WorkingApiClient({
      baseUrl: 'https://backend.example.test',
      tokenStore: store,
      fetchImpl: async (url) => {
        calls.push(url)
        if (url.endsWith('/api/working/diamond-packages')) {
          paymentRequestCount += 1
          if (paymentRequestCount === 1) return jsonResponse({ error: 'token expired' }, 401)
          return jsonResponse([{ id: 1, amount: '9.90', diamonds: 100 }])
        }
        if (url.endsWith('/api/auth/refresh')) return jsonResponse({ token: 'new-payment-token', refresh_token: 'refresh-secret' })
        throw new Error(`unexpected request: ${url}`)
      },
    })

    try {
      await expect(client.listDiamondPackages()).resolves.toEqual([
        expect.objectContaining({ id: 1, amount: '9.90', diamonds: 100 }),
      ])
      expect(calls).toEqual([
        'http://127.0.0.1:51730/api/working/diamond-packages',
        'https://backend.example.test/api/auth/refresh',
        'http://127.0.0.1:51730/api/working/diamond-packages',
      ])
      expect(store.token).toBe('new-payment-token')
    } finally {
      if (previousRustApiBaseUrl === undefined) delete process.env.COPIS_HTTP_API_BASE_URL
      else process.env.COPIS_HTTP_API_BASE_URL = previousRustApiBaseUrl
    }
  })

  test('submits Working feedback through the authenticated ai-education endpoint', async () => {
    const client = new WorkingApiClient({
      baseUrl: 'https://backend.example.test',
      tokenStore: createStore('feedback-token'),
      fetchImpl: async (url, init) => {
        expect(url).toBe('https://backend.example.test/api/feedback/')
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer feedback-token')
        expect(JSON.parse(String(init?.body))).toEqual(expect.objectContaining({
          page_key: 'copis_working_desktop',
          feedback_type: 'bug',
          severity: 'medium',
          title: '无法打开文件',
          description: '任务完成后点击文件没有反应。',
          attachments: [],
        }))
        return jsonResponse({ data: { id: 42, status: 'submitted', message: '反馈已提交' } }, 201)
      },
    })

    await expect(client.createFeedback({
      pageKey: 'copis_working_desktop',
      feedbackType: 'bug',
      severity: 'medium',
      title: ' 无法打开文件 ',
      description: '任务完成后点击文件没有反应。',
      route: 'copis://working',
      attachments: [],
    })).resolves.toEqual({ id: 42, status: 'submitted', message: '反馈已提交' })
  })

  test('refreshes once and retries a request after an unexpected HTTP 401', async () => {
    const store = createStore('expired-access-token', 'refresh-secret')
    const calls: string[] = []
    let sessionRequestCount = 0
    const client = new WorkingApiClient({
      baseUrl: 'https://backend.example.test',
      tokenStore: store,
      fetchImpl: async (url) => {
        calls.push(url)
        if (url.endsWith('/api/working/sessions')) {
          sessionRequestCount += 1
          if (sessionRequestCount === 1) return jsonResponse({ error: 'token expired' }, 401)
          return jsonResponse({ data: [{ run_id: 'run-1', title: '已重试' }] })
        }
        if (url.endsWith('/api/auth/refresh')) return jsonResponse({ token: 'new-access-token', refresh_token: 'refresh-secret' })
        throw new Error(`unexpected request: ${url}`)
      },
    })

    await expect(client.listSessions()).resolves.toEqual([expect.objectContaining({ runId: 'run-1', title: '已重试' })])
    expect(calls).toEqual([
      'https://backend.example.test/api/working/sessions',
      'https://backend.example.test/api/auth/refresh',
      'https://backend.example.test/api/working/sessions',
    ])
    expect(store.token).toBe('new-access-token')
  })

  test('clears stale credentials on HTTP 401 and preserves server error details', async () => {
    const store = createStore('stale-token')
    const client = new WorkingApiClient({
      baseUrl: 'https://backend.example.test',
      tokenStore: store,
      fetchImpl: async () => jsonResponse({ error: 'token 已过期', code: 'token_expired' }, 401),
    })

    await expect(client.listSessions()).rejects.toMatchObject({
      name: 'WorkingApiError',
      status: 401,
      code: 'token_expired',
      message: 'token 已过期',
    })
    expect(store.token).toBeNull()
  })

  test('does not treat a successful HTTP response with an invalid business shape as success', async () => {
    const client = new WorkingApiClient({
      baseUrl: 'https://backend.example.test',
      tokenStore: createStore('token'),
      fetchImpl: async () => jsonResponse({ data: { unexpected: true } }),
    })

    await expect(client.listSkills()).rejects.toBeInstanceOf(WorkingApiError)
  })

  test('rejects invalid backend URLs before making a request', () => {
    expect(() => new WorkingApiClient({ baseUrl: 'file:///tmp/backend', tokenStore: createStore() }))
      .toThrow('只支持 http 或 https')
  })

  test('uses the remote Working backend by default', () => {
    const previousBackendUrl = process.env.COPIS_BACKEND_URL
    delete process.env.COPIS_BACKEND_URL

    try {
      const client = new WorkingApiClient({ tokenStore: createStore() })
      expect(client.baseUrl).toBe('https://edu-api.meetlife.com.cn:9001')
    } finally {
      if (previousBackendUrl === undefined) delete process.env.COPIS_BACKEND_URL
      else process.env.COPIS_BACKEND_URL = previousBackendUrl
    }
  })
})
