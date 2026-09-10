import { expect, mock, test } from 'bun:test'
import { CHANNEL_IPC_CHANNELS as C } from '@copis/shared'
import { createIpcHarness } from './t2-harness'

const h = createIpcHarness()
const cancelCodex = mock(() => undefined)
const cancelXai = mock(() => undefined)
mock.module('electron', () => ({ ipcMain: h.ipcMain }))
mock.module('../lib/channel-manager', () => Object.fromEntries([
  'listChannels', 'createChannel', 'updateChannel', 'deleteChannel', 'decryptApiKey',
  'testChannel', 'testChannelDirect', 'fetchModels', 'getChannelPlanQuota',
].map(name => [name, mock(() => undefined)])))
mock.module('../lib/codex-oauth-service', () => ({
  loginCodexOAuth: async () => { throw new Error('授权已取消') },
  cancelCodexOAuthLogin: cancelCodex,
}))
mock.module('../lib/xai-oauth-service', () => ({
  loginXaiOAuth: async (options: { onDeviceCode: (value: unknown) => void }) => {
    options.onDeviceCode({ code: 'test-code' })
    throw new Error('设备授权已取消')
  },
  cancelXaiOAuthLogin: cancelXai,
}))

test('Given OAuth 流程 When 取消或失败 Then 保留取消调用与错误返回', async () => {
  const { registerChannelsIpcHandlers } = await import('../ipc/channels.ipc')
  registerChannelsIpcHandlers()
  await h.invoke(C.CODEX_OAUTH_CANCEL)
  await h.invoke(C.XAI_OAUTH_CANCEL)
  expect(cancelCodex).toHaveBeenCalledTimes(1)
  expect(cancelXai).toHaveBeenCalledTimes(1)
  expect(await h.invoke(C.CODEX_OAUTH_LOGIN)).toEqual({ success: false, message: '授权已取消' })
  const send = mock(() => undefined)
  expect(await h.invoke(C.XAI_OAUTH_LOGIN, { sender: { send } })).toEqual({ success: false, message: '设备授权已取消' })
  expect(send).toHaveBeenCalledWith(C.XAI_OAUTH_DEVICE_CODE, { code: 'test-code' })
})
