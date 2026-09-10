import { expect, mock, test } from 'bun:test'
import { FUNCTIONAL_MODULE_IPC_CHANNELS as C, ENVIRONMENT_IPC_CHANNELS as E } from '@copis/shared'
import { createIpcHarness } from './t2-harness'

const h = createIpcHarness()
const send = mock(() => undefined)
let destroyed = false
const updateSettings = mock(() => undefined)
const install = mock(async (_input: unknown, options: { onProgress: (payload: unknown) => void }) => {
  options.onProgress({ progress: 10 })
  destroyed = true
  options.onProgress({ progress: 20 })
  return { status: 'installed' }
})
mock.module('electron', () => ({ ipcMain: h.ipcMain, app: {}, BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => destroyed, webContents: { send } }) } }))
mock.module('../lib/runtime-init', () => ({ getRuntimeStatus: () => null, reinitializeRuntime: () => null }))
mock.module('../lib/settings-service', () => ({ updateSettings }))
mock.module('../lib/environment-checker', () => ({ checkEnvironment: async () => ({ ready: true }) }))
mock.module('../lib/functional-module-manager', () => ({ checkFunctionalModule: () => null, getFunctionalModuleStatuses: () => [], installFunctionalModule: install }))
mock.module('../lib/functional-module-startup', () => ({ ensureRequiredFunctionalModules: () => [] }))
mock.module('../lib/proxy-settings-service', () => ({ getProxySettings: () => ({}), saveProxySettings: () => {} }))
mock.module('../lib/system-proxy-detector', () => ({ detectSystemProxy: () => ({}) }))

test('Given 功能模块安装 When 名称无效或窗口销毁 Then 拒绝无效输入并停止进度推送', async () => {
  const { registerRuntimeServicesIpcHandlers } = await import('../ipc/runtime.ipc')
  registerRuntimeServicesIpcHandlers()
  await expect(h.invoke(C.INSTALL, { sender: {} }, { name: ' ' })).rejects.toThrow('功能模块安装参数不正确')
  expect(install).not.toHaveBeenCalled()
  expect(await h.invoke(C.INSTALL, { sender: {} }, { name: 'node-runtime' })).toEqual({ status: 'installed' })
  expect(send).toHaveBeenCalledTimes(1)
  expect(send).toHaveBeenCalledWith(C.PROGRESS, { progress: 10 })
  expect(await h.invoke(E.CHECK)).toEqual({ ready: true })
  expect(updateSettings).toHaveBeenCalledWith({ lastEnvironmentCheck: { ready: true } })
})
