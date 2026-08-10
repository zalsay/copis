import { describe, expect, test } from 'bun:test'
import { WorkingApiClient, WorkingApiError } from './working-api-client'

interface FakeStore {
  token: string | null
  refreshToken: string | null
  user: import('@copis/shared').WorkingUser | null
}

function createStore(initialToken: string | null = null, initialRefreshToken: string | null = null): FakeStore & import('./working-auth-store').WorkingTokenStore {
  const state: FakeStore = { token: initialToken, refreshToken: initialRefreshToken, user: null }
  return {
    getToken: () => state.token,
    getRefreshToken: () => state.refreshToken,
    getUser: () => state.user,
    save: (token, user = null, refreshToken) => {
      state.token = token
      state.user = user
      if (refreshToken !== undefined) state.refreshToken = refreshToken
    },
    clear: () => { state.token = null; state.refreshToken = null; state.user = null },
    get token() { return state.token },
    get refreshToken() { return state.refreshToken },
    get user() { return state.user },
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

  test('creates and checks an HTTPS Alipay page-pay order through edu-api with the main-process token', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const previousRustApiBaseUrl = process.env.COPIS_HTTP_API_BASE_URL
    process.env.COPIS_HTTP_API_BASE_URL = 'http://127.0.0.1:51730'
    const client = new WorkingApiClient({
      baseUrl: 'https://backend.example.test/module/edu-api',
      tokenStore: createStore('working-token'),
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        const paid = url.endsWith('/check')
        return jsonResponse({ data: {
          payment_id: 71,
          out_trade_no: 'PAGE-DIAMOND-7-1',
          cashier_url: 'https://cashier.example.test/pay?order=71',
          status: paid ? 'paid' : 'pending',
          trade_status: paid ? 'TRADE_SUCCESS' : 'WAIT_BUYER_PAY',
          credit_tokens: 1050,
          ...(paid ? { credited: true } : {}),
          package: { id: 3, amount: '9.90', amount_cents: 990, currency: 'CNY', diamonds: 1050 },
        } })
      },
    })

    try {
      await expect(client.createAlipayPagePayOrder(3)).resolves.toMatchObject({
        paymentId: '71',
        cashierUrl: 'https://cashier.example.test/pay?order=71',
        status: 'pending',
      })
      await expect(client.checkAlipayPagePayOrder(71)).resolves.toMatchObject({ status: 'paid', credited: true })

      expect(calls.map((call) => call.url)).toEqual([
        'http://127.0.0.1:51730/api/working/alipay/page-orders',
        'http://127.0.0.1:51730/api/working/alipay/page-orders/71/check',
      ])
      expect(new Headers(calls[0]?.init?.headers).get('Authorization')).toBeNull()
      expect(calls[0]?.init?.body).toBe(JSON.stringify({ package_id: 3 }))
      expect(calls[1]?.init?.body).toBe(JSON.stringify({}))
    } finally {
      if (previousRustApiBaseUrl === undefined) delete process.env.COPIS_HTTP_API_BASE_URL
      else process.env.COPIS_HTTP_API_BASE_URL = previousRustApiBaseUrl
    }
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
        if (url.endsWith('/api/family/wallet')) return jsonResponse({ data: { members: [{ user_id: 7, role: 'owner', display_name: '设置用户', tokens: 123.5 }], ledger: [] } })
        if (url.endsWith('/api/users/billing-ledger')) return jsonResponse({ data: [{ id: 1, payer_user_id: 7, amount_tokens: 3, type: 'charge', source_type: 'pi_office_model', alias: 'fast', created_at: '2026-01-01T08:00:00Z' }] })
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
      ledger: [expect.objectContaining({ sourceType: 'pi_office_model', modelAlias: 'fast', amountTokens: 3 })],
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
