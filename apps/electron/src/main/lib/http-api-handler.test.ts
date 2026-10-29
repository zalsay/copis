import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import * as nodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHttpStreamClient } from '../../renderer/lib/agent-http-stream'
import type { HttpApiDependencies } from './http-api-handler'
import type { AppSettings } from '../../types'

const fixtureRoot = mkdtempSync(join(tmpdir(), 'copis-http-api-handler-test-'))
const fixturePathCalls: string[] = []
let electronGetPathCalls = 0
mock.module('node:os', () => ({ ...nodeOs, homedir: () => fixtureRoot }))

function fixturePath(...segments: string[]): string {
  const path = join(fixtureRoot, ...segments)
  fixturePathCalls.push(path)
  return path
}

mock.module('electron', () => ({
  app: { isPackaged: true, getPath: () => { electronGetPathCalls++; throw new Error('HTTP handler test must not read Electron user paths') } },
  BrowserWindow: class {},
  WebContentsView: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: { openExternal: async () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}))

const actualConfigPaths = await import('./config-paths')
mock.module('./config-paths', () => ({
  ...actualConfigPaths,
  getConfigDir: () => fixturePath('config'),
}))
const { handleHttpApiRequest } = await import('./http-api-handler')

afterAll(() => {
  try {
    const configRoot = actualConfigPaths.getConfigDir()
    expect(configRoot.startsWith(fixtureRoot)).toBe(true)
    expect(fixturePathCalls.length).toBeGreaterThan(0)
    expect(fixturePathCalls.every((path) => path.startsWith(fixtureRoot))).toBe(true)
    expect(electronGetPathCalls).toBe(0)
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})
test('Given prepare body 明示携带 malformed trustedRunId When Main 解析 Then fail closed 不退化为普通运行', async () => {
  for (const trustedRunId of [0, '', null, false]) {
    const response = await handleHttpApiRequest({
      method: 'POST',
      path: '/api/internal/agent/prepare',
      body: JSON.stringify({ sessionId: 'session-1', userMessage: 'prepare', _copisTrustedRunId: trustedRunId }),
    }, createDependencies())
    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ code: 'invalid_agent_rpc_run_id' })
  }
})

test('Given 普通 Renderer send 经 Rust prepare 转发且没有 trusted run ID When Main routes request Then 保留普通 prepare 兼容', async () => {
  let rendererBody = ''
  const originalFetch = globalThis.fetch
  globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
    rendererBody = String(init?.body)
    return new Response('data: {"type":"complete","sessionId":"session-1","stoppedByUser":false}\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }, { preconnect: originalFetch.preconnect })

  const prepareAgentRpcRun = mock(async (input: { sessionId: string; userMessage: string }, trustedRunId?: string) => ({
    sessionId: input.sessionId,
    userMessage: input.userMessage,
    trustedRunId: trustedRunId ?? null,
  }))
  try {
    const rendererInput = { sessionId: 'session-1', userMessage: '普通 Agent 消息', channelId: 'channel-1' }
    await new AgentHttpStreamClient().send(rendererInput)
    expect(JSON.parse(rendererBody)).toEqual(rendererInput)

    const response = await handleHttpApiRequest({
      method: 'POST',
      path: '/api/internal/agent/prepare',
      body: rendererBody,
    }, createDependencies({ prepareAgentRpcRun } as unknown as Partial<HttpApiDependencies>))
    expect(response).toEqual({ status: 200, body: { sessionId: 'session-1', userMessage: '普通 Agent 消息', trustedRunId: null } })
    expect(prepareAgentRpcRun).toHaveBeenCalledWith({ ...rendererInput, agentRuntime: 'pi' }, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

function createDependencies(overrides: Partial<HttpApiDependencies> = {}): HttpApiDependencies {
  return {
    getWorkingClient: (() => ({ baseUrl: 'https://backend.example.test' })) as unknown as HttpApiDependencies['getWorkingClient'],
    getAppSettings: () => ({ themeMode: 'system' }) as AppSettings,
    updateAppSettings: () => ({ themeMode: 'system' }) as AppSettings,
    ...overrides,
  }
}

test('Given Rust auth notification carries an authenticated user When Main handles it Then it broadcasts the supplied identity without changing cached auth', async () => {
  const clearAuth = mock(() => undefined)
  const order: string[] = []
  const client = { baseUrl: 'https://backend.example.test', clearAuth, getCachedUser: () => null }
  const response = await handleHttpApiRequest({
    method: 'POST',
    path: '/api/internal/auth-state/changed',
    body: JSON.stringify({ authenticated: true, user: { id: 'rust-user' } }),
  }, createDependencies({
    getWorkingClient: () => client as never,
    syncWebSyncAuthState: (state) => { expect(state.user?.id).toBe('rust-user'); order.push('webSync') },
    notifyWorkingAuthUpdated: () => { order.push('broadcast') },
  }))
  expect(response).toEqual({ status: 204 })
  expect(clearAuth).not.toHaveBeenCalled()
  expect(order).toEqual(['webSync', 'broadcast'])
})

test('Given Rust reports an unauthenticated state When auth changes Then it isolates WebSync before clearing and broadcasting', async () => {
  let cachedUser: { id: string } | null = { id: 'stale-user' }
  const order: string[] = []
  const client = {
    baseUrl: 'https://backend.example.test',
    getCachedUser: () => cachedUser,
    clearAuth: () => { order.push('clearAuth'); cachedUser = null },
  }
  const response = await handleHttpApiRequest({
    method: 'POST',
    path: '/api/internal/auth-state/changed',
    body: JSON.stringify({ authenticated: false, user: { id: 'old-account' } }),
  }, createDependencies({
    getWorkingClient: () => client as never,
    syncWebSyncAuthState: (state) => {
      expect(state.authenticated).toBe(false)
      expect(state.user).toBeNull()
      order.push('webSync')
    },
    notifyWorkingAuthUpdated: () => { order.push('broadcast') },
  }))
  expect(response).toEqual({ status: 204 })
  expect(order).toEqual(['webSync', 'clearAuth', 'broadcast'])
  expect(cachedUser).toBeNull()
})

test('Given Rust clears auth storage When clear bridge runs Then it clears local identity', async () => {
  const order: string[] = []
  const client = {
    baseUrl: 'https://backend.example.test',
    clearAuth: () => { order.push('clearAuth') },
  }
  const response = await handleHttpApiRequest({
    method: 'POST',
    path: '/api/internal/auth-storage/clear',
  }, createDependencies({ getWorkingClient: () => client as never }))
  expect(response).toEqual({ status: 204 })
  expect(order).toEqual(['clearAuth'])
})

test('Given cached account A When Rust saves account B Then the cached identity is cleared before adopting B', async () => {
  const order: string[] = []
  let currentUser: { id: string } | null = { id: 'A' }
  const client = {
    baseUrl: 'https://backend.example.test',
    getCachedUser: () => currentUser,
    clearAuth: () => { order.push('clearAuth'); currentUser = null },
    setAuthenticatedUserFromRust: (user: unknown) => { order.push('setUser'); currentUser = user as { id: string }; return true },
  }
  const response = await handleHttpApiRequest({
    method: 'POST',
    path: '/api/internal/auth-storage/save',
    body: JSON.stringify({ accessToken: 'token-b', provider: 'legacy', user: { id: 'B' } }),
  }, createDependencies({ getWorkingClient: () => client as never }))
  expect(response).toEqual({ status: 204 })
  expect(order).toEqual(['clearAuth', 'setUser'])
  expect(currentUser).toEqual({ id: 'B' })
})

test('Given Rust temporarily saves auth without user When auth storage is updated Then the facade becomes unauthenticated', async () => {
  const order: string[] = []
  let currentUser: { id: string } | null = { id: 'A' }
  const client = {
    baseUrl: 'https://backend.example.test',
    getCachedUser: () => currentUser,
    clearAuth: () => { order.push('clearAuth'); currentUser = null },
    setAuthenticatedUserFromRust: (user: unknown) => {
      order.push('setUser')
      currentUser = user && typeof user === 'object' ? user as { id: string } : null
      return currentUser !== null
    },
  }
  const response = await handleHttpApiRequest({
    method: 'POST',
    path: '/api/internal/auth-storage/save',
    body: JSON.stringify({ accessToken: 'oidc-transition', provider: 'oidc' }),
  }, createDependencies({ getWorkingClient: () => client as never }))
  expect(response).toEqual({ status: 204 })
  expect(order).toEqual(['clearAuth', 'setUser'])
  expect(currentUser).toBeNull()
})
test('Given auth save carries malformed user When Rust bridge handles it Then it fails closed and clears facade identity', async () => {
  let currentUser: { id: string } | null = { id: 'A' }
  let cleared = 0
  const client = {
    baseUrl: 'https://backend.example.test',
    getCachedUser: () => currentUser,
    clearAuth: () => { cleared++; currentUser = null },
    setAuthenticatedUserFromRust: () => false,
  }
  const response = await handleHttpApiRequest({
    method: 'POST',
    path: '/api/internal/auth-storage/save',
    body: JSON.stringify({ accessToken: 'bad-user', provider: 'legacy', user: 'not-an-object' }),
  }, createDependencies({ getWorkingClient: () => client as never }))
  expect(response.status).toBe(400)
  expect(response.body).toEqual({ error: '认证存储记录缺少用户身份', code: 'invalid_auth_storage' })
  expect(cleared).toBe(1)
  expect(currentUser).toBeNull()
})
