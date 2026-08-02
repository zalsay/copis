import { describe, expect, test } from 'bun:test'
import { WorkingApiClient, WorkingApiError } from './working-api-client'

interface FakeStore {
  token: string | null
  user: import('@proma/shared').WorkingUser | null
}

function createStore(initialToken: string | null = null): FakeStore & import('./working-auth-store').WorkingTokenStore {
  const state: FakeStore = { token: initialToken, user: null }
  return {
    getToken: () => state.token,
    getUser: () => state.user,
    save: (token, user = null) => { state.token = token; state.user = user },
    clear: () => { state.token = null; state.user = null },
    get token() { return state.token },
    get user() { return state.user },
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
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
          return jsonResponse({ token: 'secret-token', user_id: 7 })
        }
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer secret-token')
        return jsonResponse({ data: { id: 7, email: 'user@example.com', nickname: 'Copis 用户' } })
      },
    })

    const result = await client.login({ email: ' user@example.com ', password: 'password' })

    expect(client.baseUrl).toBe('http://localhost:9000/module/edu-api')
    expect(result.token).toBe('secret-token')
    expect(result.user?.email).toBe('user@example.com')
    expect(store.token).toBe('secret-token')
    expect(calls.map((call) => call.url)).toEqual([
      'http://localhost:9000/module/edu-api/api/auth/login',
      'http://localhost:9000/module/edu-api/api/users/me',
    ])
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
})
