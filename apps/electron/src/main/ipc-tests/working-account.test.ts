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
  const resume = mock(async () => undefined)
  registerWorkingAccountIpcHandlers({ resumeChatRoomAgentsAfterAuthentication: resume })

  await expect(registeredHandler(WORKING_IPC_CHANNELS.LOGIN)({}, { email: 'user@example.com', password: 'secret' })).resolves.toEqual({
    authenticated: true,
    backendUrl: 'https://working.example',
  })
  expect(login).toHaveBeenCalledWith({ email: 'user@example.com', password: 'secret' })
  expect(reloadDshCordisPlugins).toHaveBeenCalledWith({ startIfNeeded: false })
  expect(resume).toHaveBeenCalledTimes(1)
  login.mockImplementationOnce(async () => { throw new Error('login failed') })
  await expect(registeredHandler(WORKING_IPC_CHANNELS.LOGIN)({}, { email: 'user@example.com', password: 'wrong' })).rejects.toThrow('login failed')
  expect(resume).toHaveBeenCalledTimes(1)
  await expect(registeredHandler(WORKING_IPC_CHANNELS.LOGIN)({}, { email: 'user@example.com' })).rejects.toThrow('登录参数不正确')
})

test('Working 登出先等待聊天室清理再清除认证', async () => {
  const { registerWorkingAccountIpcHandlers } = await import('../ipc/working-account.ipc')
  const order: string[] = []
  logout.mockImplementation(() => { order.push('logout') })
  registerWorkingAccountIpcHandlers({ stopChatRoomAgents: async () => { order.push('stopAll') } })
  await registeredHandler(WORKING_IPC_CHANNELS.LOGOUT)({})
  expect(order).toEqual(['stopAll', 'logout'])
})

test('Working OIDC 登录成功触发同一聊天室恢复回调', async () => {
  const { registerWorkingAccountIpcHandlers } = await import('../ipc/working-account.ipc')
  const resume = mock(async () => undefined)
  registerWorkingAccountIpcHandlers({ resumeChatRoomAgentsAfterAuthentication: resume })
  await registeredHandler(WORKING_IPC_CHANNELS.LOGIN_OIDC)()
  expect(loginWithOAuth).toHaveBeenCalledTimes(1)
  expect(resume).toHaveBeenCalledTimes(1)
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

test('迟到的 LOGOUT cleanup 不得中断并发切换到 B 的登录', async () => {
  const { registerWorkingAccountIpcHandlers } = await import('../ipc/working-account.ipc')
  let resolveCleanup!: () => void
  const cleanupFinished = new Promise<void>((resolve) => { resolveCleanup = resolve })
  logout.mockClear()
  registerWorkingAccountIpcHandlers({ stopChatRoomAgents: async () => cleanupFinished })
  authGeneration = 0
  const request = registeredHandler(WORKING_IPC_CHANNELS.LOGOUT)({})
  authGeneration = 1
  resolveCleanup()

  await expect(request).resolves.toEqual({
    authenticated: true,
    user: { id: 'oidc-user' },
    backendUrl: client.baseUrl,
  })
  expect(logout).not.toHaveBeenCalled()
})
