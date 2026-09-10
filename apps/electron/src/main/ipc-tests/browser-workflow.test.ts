import { beforeEach, expect, mock, test } from 'bun:test'
import { BROWSER_WORKFLOW_IPC_CHANNELS } from '@copis/shared'

const handle = mock(() => {})
const bindBrowserAgentContext = mock(() => ({ bound: true }))
const subscribeBrowserWorkflowStatus = mock(() => undefined)
const send = mock(() => undefined)

mock.module('electron', () => ({ ipcMain: { handle } }))
mock.module('../index', () => ({
  getMainWindow: () => ({
    isDestroyed: () => false,
    webContents: { id: 7, isDestroyed: () => false, send },
  }),
}))
mock.module('../lib/browser-workflow-service', () => ({
  approveBrowserWorkflowDraft: mock(() => undefined),
  assertBrowserWorkflowSessionOwner: mock(() => undefined),
  bindBrowserAgentContext,
  cancelBrowserWorkflowRecording: mock(() => undefined),
  getBrowserAgentSessionIdForTab: mock(() => undefined),
  getBrowserWorkflowDraft: mock(() => undefined),
  getBrowserWorkflowStatus: mock(() => undefined),
  rejectBrowserWorkflowDraft: mock(() => undefined),
  setBrowserPageControlMode: mock(() => undefined),
  startBrowserWorkflowRecording: mock(() => undefined),
  stopBrowserWorkflowRecording: mock(() => undefined),
  subscribeBrowserWorkflowStatus,
  unbindBrowserAgentContext: mock(() => undefined),
}))
mock.module('../lib/browser-workflow-runner', () => ({
  continueBrowserWorkflowRun: mock(() => undefined),
  stopBrowserWorkflowRun: mock(() => undefined),
}))

type IpcHandler = (...args: unknown[]) => unknown

function registeredHandler(channel: string): IpcHandler {
  const registrations = handle.mock.calls as unknown as Array<[unknown, unknown]>
  const registration = registrations.find(([registeredChannel]) => registeredChannel === channel)
  expect(registration).toBeDefined()
  return registration?.[1] as IpcHandler
}

beforeEach(() => {
  handle.mockClear()
  bindBrowserAgentContext.mockClear()
  subscribeBrowserWorkflowStatus.mockClear()
  send.mockClear()
})

test('Browser Workflow 只接受主窗口 sender', async () => {
  const { registerBrowserWorkflowIpcHandlers } = await import('../ipc/browser-workflow.ipc')
  registerBrowserWorkflowIpcHandlers()

  const event = { sender: { id: 8 } }
  await expect(registeredHandler(BROWSER_WORKFLOW_IPC_CHANNELS.BIND_CONTEXT)(event, 'session-1', { tabId: 'tab-1' })).rejects.toThrow('Browser Workflow IPC 只能由主渲染窗口调用')
  expect(bindBrowserAgentContext).not.toHaveBeenCalled()
})

test('Given 主窗口绑定浏览器上下文 When 调用 IPC Then 透传会话和 sender 并保留 Worker capability', async () => {
  const { registerBrowserWorkflowIpcHandlers } = await import('../ipc/browser-workflow.ipc')
  registerBrowserWorkflowIpcHandlers()

  const event = { sender: { id: 7 } }
  const context = { tabId: 'tab-1' }
  await expect(registeredHandler(BROWSER_WORKFLOW_IPC_CHANNELS.BIND_CONTEXT)(event, 'session-1', context)).resolves.toEqual({ bound: true })
  expect(bindBrowserAgentContext).toHaveBeenCalledWith('session-1', context, 7, { preserveWorkerCapability: true })
})

test('Browser Workflow 注册状态订阅器并推送状态更新', async () => {
  const { registerBrowserWorkflowIpcHandlers } = await import('../ipc/browser-workflow.ipc')
  registerBrowserWorkflowIpcHandlers()

  expect(subscribeBrowserWorkflowStatus).toHaveBeenCalledTimes(1)
  const callback = (subscribeBrowserWorkflowStatus.mock.calls as unknown as Array<[unknown]>)[0]?.[0] as ((sessionId: string, status: unknown) => void)
  callback('session-1', { state: 'recording' })
  await Promise.resolve()
  await Promise.resolve()
  expect(send).toHaveBeenCalledWith(BROWSER_WORKFLOW_IPC_CHANNELS.STATUS_CHANGED, {
    sessionId: 'session-1',
    status: { state: 'recording' },
  })
})
