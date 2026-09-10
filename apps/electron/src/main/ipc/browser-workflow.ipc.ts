import { ipcMain } from 'electron'
import {
  BROWSER_WORKFLOW_IPC_CHANNELS,
  type BrowserAgentContext,
  type BrowserPageControlMode,
} from '@copis/shared'
import {
  approveBrowserWorkflowDraft,
  assertBrowserWorkflowSessionOwner,
  bindBrowserAgentContext,
  cancelBrowserWorkflowRecording,
  getBrowserAgentSessionIdForTab,
  getBrowserWorkflowDraft,
  getBrowserWorkflowStatus,
  rejectBrowserWorkflowDraft,
  setBrowserPageControlMode,
  startBrowserWorkflowRecording,
  stopBrowserWorkflowRecording,
  subscribeBrowserWorkflowStatus,
  unbindBrowserAgentContext,
} from '../lib/browser-workflow-service'
import { continueBrowserWorkflowRun, stopBrowserWorkflowRun } from '../lib/browser-workflow-runner'

async function assertBrowserWorkflowMainWindow(senderId: number): Promise<void> {
  const { getMainWindow } = await import('../index')
  const mainWindow = getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed() || mainWindow.webContents.id !== senderId) {
    throw new Error('Browser Workflow IPC 只能由主渲染窗口调用')
  }
}

export function registerBrowserWorkflowIpcHandlers(): void {
  ipcMain.handle(BROWSER_WORKFLOW_IPC_CHANNELS.BIND_CONTEXT, async (event, sessionId: string, context: BrowserAgentContext) => {
    await assertBrowserWorkflowMainWindow(event.sender.id)
    if (!sessionId?.trim() || !context || typeof context.tabId !== 'string' || !context.tabId.trim()) {
      throw new Error('AI浏览器页面上下文参数不正确')
    }
    console.info('[AI浏览器][IPC] 渲染进程请求绑定上下文', { sessionId, tabId: context.tabId })
    return bindBrowserAgentContext(sessionId, context, event.sender.id, { preserveWorkerCapability: true })
  })
  ipcMain.handle(BROWSER_WORKFLOW_IPC_CHANNELS.UNBIND_CONTEXT, async (event, sessionId: string) => {
    await assertBrowserWorkflowMainWindow(event.sender.id)
    if (!sessionId?.trim()) throw new Error('AI浏览器会话 ID 不正确')
    assertBrowserWorkflowSessionOwner(sessionId, event.sender.id)
    unbindBrowserAgentContext(sessionId, event.sender.id)
  })
  ipcMain.handle(BROWSER_WORKFLOW_IPC_CHANNELS.SESSION_FOR_TAB, async (event, tabId: string) => {
    await assertBrowserWorkflowMainWindow(event.sender.id)
    if (!tabId?.trim()) throw new Error('网页页签 ID 不正确')
    return getBrowserAgentSessionIdForTab(tabId)
  })
  ipcMain.handle(BROWSER_WORKFLOW_IPC_CHANNELS.STATUS, async (event, sessionId: string) => {
    await assertBrowserWorkflowMainWindow(event.sender.id)
    if (!sessionId?.trim()) throw new Error('AI浏览器会话 ID 不正确')
    assertBrowserWorkflowSessionOwner(sessionId, event.sender.id)
    return getBrowserWorkflowStatus(sessionId)
  })
  ipcMain.handle(BROWSER_WORKFLOW_IPC_CHANNELS.SET_CONTROL_MODE, async (event, sessionId: string, mode: BrowserPageControlMode) => {
    await assertBrowserWorkflowMainWindow(event.sender.id)
    if (!sessionId?.trim() || (mode !== 'ask' && mode !== 'authorized')) {
      throw new Error('AI浏览器页面授权参数不正确')
    }
    assertBrowserWorkflowSessionOwner(sessionId, event.sender.id)
    return setBrowserPageControlMode(sessionId, mode)
  })
  ipcMain.handle(BROWSER_WORKFLOW_IPC_CHANNELS.START_RECORDING, async (event, sessionId: string) => {
    await assertBrowserWorkflowMainWindow(event.sender.id)
    if (!sessionId?.trim()) throw new Error('AI浏览器会话 ID 不正确')
    assertBrowserWorkflowSessionOwner(sessionId, event.sender.id)
    return startBrowserWorkflowRecording(sessionId)
  })
  ipcMain.handle(BROWSER_WORKFLOW_IPC_CHANNELS.STOP_RECORDING, async (event, sessionId: string) => {
    await assertBrowserWorkflowMainWindow(event.sender.id)
    assertBrowserWorkflowSessionOwner(sessionId, event.sender.id)
    return stopBrowserWorkflowRecording(sessionId)
  })
  ipcMain.handle(BROWSER_WORKFLOW_IPC_CHANNELS.STOP_RUN, async (event, sessionId: string) => {
    await assertBrowserWorkflowMainWindow(event.sender.id)
    assertBrowserWorkflowSessionOwner(sessionId, event.sender.id)
    return stopBrowserWorkflowRun(sessionId)
  })
  ipcMain.handle(BROWSER_WORKFLOW_IPC_CHANNELS.CONTINUE_RUN, async (event, sessionId: string) => {
    await assertBrowserWorkflowMainWindow(event.sender.id)
    assertBrowserWorkflowSessionOwner(sessionId, event.sender.id)
    return continueBrowserWorkflowRun(sessionId)
  })
  ipcMain.handle(BROWSER_WORKFLOW_IPC_CHANNELS.CANCEL_RECORDING, async (event, sessionId: string) => {
    await assertBrowserWorkflowMainWindow(event.sender.id)
    assertBrowserWorkflowSessionOwner(sessionId, event.sender.id)
    return cancelBrowserWorkflowRecording(sessionId)
  })
  ipcMain.handle(BROWSER_WORKFLOW_IPC_CHANNELS.DRAFT, async (event, sessionId: string) => {
    await assertBrowserWorkflowMainWindow(event.sender.id)
    assertBrowserWorkflowSessionOwner(sessionId, event.sender.id)
    return getBrowserWorkflowDraft(sessionId)
  })
  ipcMain.handle(BROWSER_WORKFLOW_IPC_CHANNELS.APPROVE_DRAFT, async (event, sessionId: string, name?: string, description?: string, unattendedAllowed?: boolean) => {
    await assertBrowserWorkflowMainWindow(event.sender.id)
    assertBrowserWorkflowSessionOwner(sessionId, event.sender.id)
    return approveBrowserWorkflowDraft(sessionId, name ?? '网页操作 Workflow', description, unattendedAllowed === true, 'ui')
  })
  ipcMain.handle(BROWSER_WORKFLOW_IPC_CHANNELS.REJECT_DRAFT, async (event, sessionId: string) => {
    await assertBrowserWorkflowMainWindow(event.sender.id)
    assertBrowserWorkflowSessionOwner(sessionId, event.sender.id)
    return rejectBrowserWorkflowDraft(sessionId)
  })
  subscribeBrowserWorkflowStatus((sessionId, status) => {
    void import('../index').then(({ getMainWindow }) => {
      const mainWindow = getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
      mainWindow.webContents.send(BROWSER_WORKFLOW_IPC_CHANNELS.STATUS_CHANGED, { sessionId, status })
    })
  })
}
