import { beforeEach, expect, mock, test } from 'bun:test'
import { FEISHU_IPC_CHANNELS as F, DINGTALK_IPC_CHANNELS as D, AGENT_MAIL_IPC_CHANNELS as M, DSH_CORDIS_IPC_CHANNELS as S } from '@copis/shared'
import { createIpcHarness } from './t2-harness'

const h = createIpcHarness()
const restart = mock(async (_id: string) => {})
const stop = mock((_id: string) => {})
const startAll = mock(async () => {})
const cancelLogin = mock(() => {})
const logout = mock(() => {})
const liveSend = mock((_channel: string, _payload: unknown) => {})
const destroyedSend = mock((_channel: string, _payload: unknown) => {})
let bots: Record<string, { status: string }> = {}
let broadcast: (status: unknown) => void = () => {}
const passthrough = (input: unknown) => input
mock.module('electron', () => ({
  ipcMain: h.ipcMain,
  BrowserWindow: { getAllWindows: () => [
    { isDestroyed: () => false, webContents: { send: liveSend } },
    { isDestroyed: () => true, webContents: { send: destroyedSend } },
    { isDestroyed: () => false, webContents: undefined },
  ] },
}))
mock.module('../lib/feishu-config', () => ({
  getFeishuConfig: () => ({}), saveFeishuConfig: passthrough, getDecryptedAppSecret: () => '',
  getFeishuMultiBotConfig: () => ({ bots: [{ id: 'first' }, { id: 'second' }] }),
  saveFeishuBotConfig: passthrough, removeFeishuBot: () => {}, getDecryptedBotAppSecret: () => '',
}))
mock.module('../lib/feishu-bridge-manager', () => ({ feishuBridgeManager: {
  restartBot: restart, stopBot: stop, startAll, stopAll: () => {}, getStates: () => ({ bots }),
} }))
mock.module('../lib/feishu-presence', () => ({ presenceService: { updatePresence: () => {} } }))
mock.module('../lib/dingtalk-config', () => ({
  getDingTalkConfig: () => ({}), saveDingTalkConfig: passthrough, getDecryptedClientSecret: () => '',
  getDingTalkMultiBotConfig: () => ({ bots: [] }), saveDingTalkBotConfig: passthrough,
  removeDingTalkBot: () => {}, getDecryptedBotClientSecret: () => '',
}))
mock.module('../lib/dingtalk-bridge-manager', () => ({ dingtalkBridgeManager: {
  startAll, stopAll: () => {}, getStates: () => ({ bots }),
} }))
mock.module('../lib/agent-mail-service', () => ({ AgentMailService: {
  getInstance: () => ({ getStatus: () => ({}), startLogin: async () => {}, cancelLogin, logout }),
} }))
mock.module('../lib/dsh-cordis-service', () => ({
  getDshCordisStatus: () => ({}), reloadDshCordisPlugins: async () => {},
  startDshCordisServer: async () => {}, stopDshCordisServer: () => {},
  setDshStatusChangeBroadcaster: (listener: typeof broadcast) => { broadcast = listener },
}))
mock.module('../lib/dsh-view-manager', () => ({ ensureDshView: () => {}, updateDshViewBounds: () => {}, dispatchToDshClient: () => {} }))

beforeEach(async () => {
  for (const fn of [restart, stop, startAll, cancelLogin, logout, liveSend, destroyedSend]) fn.mockClear()
  bots = {}
  const { registerFeishuIpcHandlers } = await import('../ipc/feishu.ipc')
  const { registerDingtalkIpcHandlers } = await import('../ipc/dingtalk.ipc')
  const { registerAgentMailIpcHandlers } = await import('../ipc/agent-mail.ipc')
  const { registerDshIpcHandlers } = await import('../ipc/dsh.ipc')
  registerFeishuIpcHandlers()
  registerDingtalkIpcHandlers()
  registerAgentMailIpcHandlers()
  registerDshIpcHandlers()
})

test('Given 多个飞书 Bot When 旧接口保存启用配置 Then 只重启第一个 Bot 并返回配置', async () => {
  const input = { enabled: true, appId: 'app', appSecret: 'test-secret' }
  expect(await h.invoke(F.SAVE_CONFIG, {}, input)).toEqual(input)
  expect(restart).toHaveBeenCalledTimes(1)
  expect(restart).toHaveBeenCalledWith('first')
  expect(stop).not.toHaveBeenCalled()
})

test('Given 飞书旧配置 When 禁用 Then 停止第一个 Bot 且不重启', async () => {
  await h.invoke(F.SAVE_CONFIG, {}, { enabled: false })
  expect(stop).toHaveBeenCalledWith('first')
  expect(restart).not.toHaveBeenCalled()
})

test('Given 空 Bot 状态 When 旧接口查询 Then 保留各平台默认断开状态', async () => {
  expect(await h.invoke(F.GET_STATUS)).toEqual({ status: 'disconnected', activeBindings: 0 })
  expect(await h.invoke(D.GET_STATUS)).toEqual({ status: 'disconnected' })
  bots = { first: { status: 'connected' }, second: { status: 'connecting' } }
  expect(await h.invoke(F.GET_STATUS)).toEqual(bots.first)
  expect(await h.invoke(D.GET_STATUS)).toEqual(bots.first)
})

test('Given 钉钉多 Bot When 旧接口启动 Bridge Then 启动所有 Bot', async () => {
  await h.invoke(D.START_BRIDGE)
  expect(startAll).toHaveBeenCalledTimes(1)
})

test('Given 邮箱登录正在进行 When 取消登录 Then 仅取消登录且不登出', async () => {
  await h.invoke(M.CANCEL_LOGIN)
  expect(cancelLogin).toHaveBeenCalledTimes(1)
  expect(logout).not.toHaveBeenCalled()
})

test('Given 存活和已销毁窗口 When 收到 DSH 客户端事件与服务状态 Then 只广播到存活窗口', () => {
  const event = { type: 'test-event', payload: { value: 1 } }
  const status = { running: true }
  h.emit(S.CLIENT_EVENT, {}, event)
  broadcast(status)
  expect(liveSend.mock.calls).toEqual([[S.CLIENT_EVENT, event], [S.ON_STATUS_CHANGE, status]])
  expect(destroyedSend).not.toHaveBeenCalled()
})
