import { expect, mock, test } from 'bun:test'
import { WEB_IPC_CHANNELS } from '@copis/shared'

const handle = mock(() => {})
const listWebTabs = mock(() => ({ tabs: [], activeTabId: null }))
const reorderWebTab = mock((input: unknown) => input)
const getWebPageProjectAssociation = mock((url: string) => ({ url }))
const getWebJavascriptPromptRequest = mock((requestId: string, senderId: number) => ({ requestId, senderId }))

mock.module('electron', () => ({ ipcMain: { handle } }))
mock.module('../lib/web-tab-manager', () => ({
  activateWebTab: mock(() => undefined),
  activateWebTabIncognito: mock(() => undefined),
  closeWebTab: mock(() => undefined),
  createWebTab: mock(() => undefined),
  goBackWebTab: mock(() => undefined),
  goForwardWebTab: mock(() => undefined),
  listWebTabs,
  navigateWebTab: mock(() => undefined),
  reloadWebTab: mock(() => undefined),
  reorderWebTab,
  updateWebTabBounds: mock(() => undefined),
}))
mock.module('../lib/web-project-association-service', () => ({
  getWebPageProjectAssociation,
  saveWebPageProjectAssociation: mock(() => undefined),
}))
mock.module('../lib/web-tab-javascript-prompt-window', () => ({
  cancelWebJavascriptPromptRequest: mock(() => undefined),
  getWebJavascriptPromptRequest,
  resolveWebJavascriptPromptRequest: mock(() => undefined),
}))

type IpcHandler = (...args: unknown[]) => unknown

function registeredHandler(channel: string): IpcHandler {
  const registrations = handle.mock.calls as unknown as Array<[unknown, unknown]>
  const registration = registrations.find(([registeredChannel]) => registeredChannel === channel)
  expect(registration).toBeDefined()
  return registration?.[1] as IpcHandler
}

test('页签列表处理器返回页签服务快照', async () => {
  const { registerWebTabsIpcHandlers } = await import('../ipc/web-tabs.ipc')
  registerWebTabsIpcHandlers()

  expect(await registeredHandler(WEB_IPC_CHANNELS.LIST)({})).toEqual({ tabs: [], activeTabId: null })
  expect(listWebTabs).toHaveBeenCalledTimes(1)
})

test('页签重排拒绝无效输入并保留有效输入', async () => {
  const { registerWebTabsIpcHandlers } = await import('../ipc/web-tabs.ipc')
  registerWebTabsIpcHandlers()

  expect(() => registeredHandler(WEB_IPC_CHANNELS.REORDER)({}, { tabId: 'tab-1', targetIndex: 1.5 })).toThrow('网页页签重排参数不正确')
  const input = { tabId: 'tab-1', targetIndex: 1 }
  expect(await registeredHandler(WEB_IPC_CHANNELS.REORDER)({}, input)).toEqual(input)
  expect(reorderWebTab).toHaveBeenCalledWith(input)
})

test('JavaScript prompt 查询使用调用方的 sender ID', async () => {
  const { registerWebTabsIpcHandlers } = await import('../ipc/web-tabs.ipc')
  registerWebTabsIpcHandlers()

  const event = { sender: { id: 42 } }
  expect(await registeredHandler(WEB_IPC_CHANNELS.JAVASCRIPT_PROMPT_GET)(event, 'request-1')).toEqual({ requestId: 'request-1', senderId: 42 })
  expect(getWebJavascriptPromptRequest).toHaveBeenCalledWith('request-1', 42)
})
