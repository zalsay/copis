import { expect, mock, test } from 'bun:test'
import { WORKING_IPC_CHANNELS } from '@copis/shared'

const handle = mock(() => {})
const getWorkingModelCatalog = mock(() => ({ models: [] }))
const getWorkingApiClient = mock(() => ({ getCachedUser: () => ({ isVip: true, id: 'user-1' }) }))

mock.module('electron', () => ({ ipcMain: { handle } }))
mock.module('../lib/working-api-service', () => ({ getWorkingApiClient }))
mock.module('../lib/working-model-latencies', () => ({ getWorkingModelLatencies: () => ({}) }))
mock.module('../lib/working-model-catalog', () => ({
  assertWorkingModelCatalogVip: mock(() => undefined),
  getWorkingModelCatalog,
  getWorkingModelCatalogOwnerId: () => 'user-1',
  saveWorkingModelCatalog: mock(() => undefined),
  testWorkingCustomModelConnection: mock(() => undefined),
}))
mock.module('../lib/dsh-cordis-service', () => ({ getDshCordisStatus: () => ({ running: false }), reloadDshCordisPlugins: mock(() => undefined) }))

type IpcHandler = (...args: unknown[]) => unknown

test('Working 模型目录按当前 VIP 用户权限查询', async () => {
  const { registerWorkingModelsIpcHandlers } = await import('../ipc/working-models.ipc')
  registerWorkingModelsIpcHandlers()
  const registrations = handle.mock.calls as unknown as Array<[unknown, unknown]>
  const handler = registrations.find(([channel]) => channel === WORKING_IPC_CHANNELS.GET_MODEL_CATALOG)?.[1] as IpcHandler

  await expect(handler({})).resolves.toEqual({ models: [] })
  expect(getWorkingModelCatalog).toHaveBeenCalledWith(true, 'user-1')
})
