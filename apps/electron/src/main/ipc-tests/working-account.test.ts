import { expect, mock, test } from 'bun:test'
import { WORKING_IPC_CHANNELS } from '@copis/shared'

const handle = mock(() => {})
const login = mock(async () => undefined)
const getAuthState = mock(async () => ({ authenticated: true }))
const client = { baseUrl: 'https://working.example', login, getAuthState }
const getWorkingApiClient = mock(() => client)
const reloadDshCordisPlugins = mock(async () => undefined)

mock.module('electron', () => ({ ipcMain: { handle }, shell: { openExternal: mock(() => undefined) } }))
mock.module('../lib/working-api-service', () => ({ getWorkingApiClient }))
mock.module('../lib/dsh-cordis-service', () => ({
  getDshCordisStatus: () => ({ running: true }),
  reloadDshCordisPlugins,
}))
mock.module('../lib/working-model-catalog', () => ({ getWorkingModelCatalogOwnerId: () => undefined }))

type IpcHandler = (...args: unknown[]) => unknown

function registeredHandler(channel: string): IpcHandler {
  const registrations = handle.mock.calls as unknown as Array<[unknown, unknown]>
  const registration = registrations.find(([registeredChannel]) => registeredChannel === channel)
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
  await expect(registeredHandler(WORKING_IPC_CHANNELS.LOGIN)({}, { email: 'user@example.com' })).rejects.toThrow('登录参数不正确')
})
