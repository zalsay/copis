import { expect, mock, test } from 'bun:test'
import { WORKING_IPC_CHANNELS } from '@copis/shared'

const handle = mock(() => {})
const login = mock(async () => undefined)
const loginWithOAuth = mock(async () => ({ user: { id: 'oidc-user' } }))
const getAuthState = mock(async () => ({ authenticated: true }))
const logout = mock(() => undefined)
const client = { baseUrl: 'https://working.example', login, loginWithOAuth, logout, getAuthState, getCachedUser: () => ({ id: 'oidc-user' }) }
const getWorkingApiClient = mock(() => client)
const reloadDshCordisPlugins = mock(async () => undefined)
const setAuthState = mock((_state?: unknown) => {})
let authGeneration = 0
const getAuthGeneration = mock(() => authGeneration)
const setAuthStateIfCurrent = mock((state: unknown, expectedGeneration: number) => {
  if (expectedGeneration !== authGeneration) return false
  setAuthState(state)
  return true
})

mock.module('electron', () => ({ ipcMain: { handle }, shell: { openExternal: mock(() => undefined) } }))
mock.module('../lib/working-api-service', () => ({ getWorkingApiClient }))
mock.module('../lib/web-sync-coordinator', () => ({
  getWebSyncCoordinator: () => ({ setAuthState, getAuthGeneration, setAuthStateIfCurrent }),
}))
mock.module('../lib/dsh-cordis-service', () => ({
  getDshCordisStatus: () => ({ running: true }),
  reloadDshCordisPlugins,
}))
mock.module('../lib/working-model-catalog', () => ({ getWorkingModelCatalogOwnerId: () => undefined }))

type IpcHandler = (...args: unknown[]) => unknown

function registeredHandler(channel: string): IpcHandler {
  const registrations = handle.mock.calls as unknown as Array<[unknown, unknown]>
  const registration = registrations.findLast(([registeredChannel]) => registeredChannel === channel)
  expect(registration).toBeDefined()
  return registration?.[1] as IpcHandler
}

test('Working 登录验证参数并刷新 Cordis 插件', async () => {
  const { registerWorkingAccountIpcHandlers } = await import('../ipc/working-account.ipc')
  registerWorkingAccountIpcHandlers()

  await expect(registeredHandler(WORKING_IPC_CHANNELS.LOGIN)({}, { email: 'user@example.com', password: 'secret' })).resolves.toEqual({
    authenticated: true,
    backendUrl: 'https://working.example',
  })
  expect(login).toHaveBeenCalledWith({ email: 'user@example.com', password: 'secret' })
  expect(reloadDshCordisPlugins).toHaveBeenCalledWith({ startIfNeeded: false })
  login.mockImplementationOnce(async () => { throw new Error('login failed') })
  await expect(registeredHandler(WORKING_IPC_CHANNELS.LOGIN)({}, { email: 'user@example.com', password: 'wrong' })).rejects.toThrow('login failed')
  await expect(registeredHandler(WORKING_IPC_CHANNELS.LOGIN)({}, { email: 'user@example.com' })).rejects.toThrow('登录参数不正确')
})

test('Working 登出后清除当前认证', async () => {
  const { registerWorkingAccountIpcHandlers } = await import('../ipc/working-account.ipc')
  const order: string[] = []
  logout.mockImplementation(() => { order.push('logout') })
  registerWorkingAccountIpcHandlers()
  await registeredHandler(WORKING_IPC_CHANNELS.LOGOUT)({})
  expect(order).toEqual(['logout'])
})

test('迟到的 GET_AUTH_STATE 不得覆盖 Rust 已通知的新账号分区', async () => {
  const { registerWorkingAccountIpcHandlers } = await import('../ipc/working-account.ipc')
  registerWorkingAccountIpcHandlers()
  setAuthState.mockClear()
  setAuthStateIfCurrent.mockClear()
  authGeneration = 0

  let resolveState!: (value: { authenticated: boolean; user: { id: string } }) => void
  getAuthState.mockImplementationOnce(() => new Promise((resolve) => { resolveState = resolve }))
  const request = registeredHandler(WORKING_IPC_CHANNELS.GET_AUTH_STATE)({})
  authGeneration = 1
  resolveState({ authenticated: true, user: { id: 'A' } })

  await request
  expect(setAuthStateIfCurrent).toHaveBeenCalledWith(
    { authenticated: true, user: { id: 'A' }, backendUrl: client.baseUrl },
    0,
  )
  expect(setAuthState).not.toHaveBeenCalled()
})
