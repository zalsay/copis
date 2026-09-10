import { expect, mock, test } from 'bun:test'
import { WEB_PASSWORD_IPC_CHANNELS } from '@copis/shared'

const handle = mock(() => {})
const listLogins = mock((searchQuery?: string) => ({ searchQuery }))
const fillCredentials = mock((_tabId: string, _entryId: string, _contents: unknown): boolean | Promise<boolean> => true)
const service = {
  listLogins,
  getLoginsByOrigin: mock(() => []),
  revealPassword: mock(() => null),
  saveOrUpdateLogin: mock(() => undefined),
  removeLogin: mock(() => false),
  getActivePrompt: mock(() => null),
  resolvePrompt: mock(async () => undefined),
  listDisabledOrigins: mock(() => []),
  addDisabledOrigin: mock(() => undefined),
  removeDisabledOrigin: mock(() => false),
  fillCredentials,
  getSettings: mock(() => ({})),
  updateSettings: mock(() => ({})),
}
const getWebPasswordService = mock(() => service)
const contents = { id: 'web-contents' }
const getWebTabContents = mock((tabId: string) => {
  expect(tabId).toBe('tab-1')
  return contents
})

mock.module('electron', () => ({ ipcMain: { handle } }))
mock.module('../lib/web-password-service', () => ({ getWebPasswordService }))
mock.module('../lib/web-tab-manager', () => ({ getWebTabContents }))

type IpcHandler = (...args: unknown[]) => unknown

function registeredHandler(channel: string): IpcHandler {
  const registrations = handle.mock.calls as unknown as Array<[unknown, unknown]>
  const registration = registrations.find(([registeredChannel]) => registeredChannel === channel)
  expect(registration).toBeDefined()
  return registration?.[1] as IpcHandler
}

test('注册密码 IPC 并透传 list 参数', async () => {
  const { registerWebPasswordsIpcHandlers } = await import('../ipc/web-passwords.ipc')
  registerWebPasswordsIpcHandlers()

  expect(handle).toHaveBeenCalledTimes(13)
  expect(await registeredHandler(WEB_PASSWORD_IPC_CHANNELS.LIST)({}, 'github')).toEqual({ searchQuery: 'github' })
  expect(listLogins).toHaveBeenCalledWith('github')
})

test('空 id 保持原有短路返回', async () => {
  const { registerWebPasswordsIpcHandlers } = await import('../ipc/web-passwords.ipc')
  registerWebPasswordsIpcHandlers()

  expect(await registeredHandler(WEB_PASSWORD_IPC_CHANNELS.REVEAL)({}, '')).toBeNull()
  expect(await registeredHandler(WEB_PASSWORD_IPC_CHANNELS.REMOVE)({}, '')).toBe(false)
  expect(await registeredHandler(WEB_PASSWORD_IPC_CHANNELS.GET_ACTIVE_PROMPT)({}, '')).toBeNull()
})

test('fillCredentials 使用 tabId、entryId 和当次获取的 WebContents', async () => {
  const { registerWebPasswordsIpcHandlers } = await import('../ipc/web-passwords.ipc')
  registerWebPasswordsIpcHandlers()

  await expect(registeredHandler(WEB_PASSWORD_IPC_CHANNELS.FILL_CREDENTIALS)({}, { tabId: 'tab-1', entryId: 'entry-9' })).resolves.toBe(true)
  expect(getWebTabContents).toHaveBeenCalledWith('tab-1')
  expect(fillCredentials).toHaveBeenCalledWith('tab-1', 'entry-9', contents)
})

test('服务 rejection 原样透传', async () => {
  const rejection = new Error('密码服务失败')
  service.fillCredentials.mockImplementationOnce(() => Promise.reject(rejection))
  const { registerWebPasswordsIpcHandlers } = await import('../ipc/web-passwords.ipc')
  registerWebPasswordsIpcHandlers()

  await expect(registeredHandler(WEB_PASSWORD_IPC_CHANNELS.FILL_CREDENTIALS)({}, { tabId: 'tab-1', entryId: 'entry-9' })).rejects.toBe(rejection)
})
