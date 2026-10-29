import { expect, mock, test } from 'bun:test'

const exposed: { api?: Record<string, unknown> } = {}
mock.module('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: Record<string, unknown>) => { exposed.api = api } },
  ipcRenderer: { invoke: async () => undefined, on: () => {}, removeListener: () => {} },
  webUtils: { getPathForFile: () => '' },
}))
mock.module('../renderer/lib/agent-http-stream', () => ({ agentHttpStreamClient: { setBaseUrl: () => {} } }))
mock.module('../renderer/lib/http-api-web-token', () => ({ setHttpApiWebToken: () => {} }))

await import('./index')

test('Given 旧聊天室已移除 When 初始化桥接 Then 只保留创造模式群聊入口', () => {
  expect(exposed.api).toBeDefined()
  expect(exposed.api).not.toHaveProperty('chatrooms')
  const groupChat = exposed.api?.dshGroupChat as Record<string, unknown>
  expect(typeof groupChat?.createGroup).toBe('function')
  expect(typeof groupChat?.postMessage).toBe('function')
  expect(typeof groupChat?.onEventStream).toBe('function')
})
