import { ipcMain } from 'electron'
import {
  WEB_IPC_CHANNELS,
  type CreateWebTabInput,
  type NavigateWebTabInput,
  type ReorderWebTabInput,
  type SaveWebPageProjectAssociationInput,
  type UpdateWebTabBoundsInput,
} from '@copis/shared'
import {
  activateWebTab,
  activateWebTabIncognito,
  closeWebTab,
  createWebTab,
  goBackWebTab,
  goForwardWebTab,
  listWebTabs,
  navigateWebTab,
  reloadWebTab,
  reorderWebTab,
  updateWebTabBounds,
} from '../lib/web-tab-manager'
import {
  getWebPageProjectAssociation,
  saveWebPageProjectAssociation,
} from '../lib/web-project-association-service'
import {
  cancelWebJavascriptPromptRequest,
  getWebJavascriptPromptRequest,
  resolveWebJavascriptPromptRequest,
} from '../lib/web-tab-javascript-prompt-window'

export function registerWebTabsCoreIpcHandlers(): void {
  ipcMain.handle(WEB_IPC_CHANNELS.LIST, () => listWebTabs())
  ipcMain.handle(WEB_IPC_CHANNELS.CREATE, (_event, input?: CreateWebTabInput) => createWebTab(input))
  ipcMain.handle(WEB_IPC_CHANNELS.ACTIVATE, (_event, tabId: string | null) => activateWebTab(tabId))
  ipcMain.handle(WEB_IPC_CHANNELS.INCOGNITO_ACTIVATE, (_event, tabId: string) => {
    if (typeof tabId !== 'string' || !tabId.trim()) throw new Error('无痕页签参数不正确')
    return activateWebTabIncognito(tabId)
  })
  ipcMain.handle(WEB_IPC_CHANNELS.CLOSE, (_event, tabId: string) => closeWebTab(tabId))
  ipcMain.handle(WEB_IPC_CHANNELS.NAVIGATE, (_event, input: NavigateWebTabInput) => navigateWebTab(input))
  ipcMain.handle(WEB_IPC_CHANNELS.REORDER, (_event, input: ReorderWebTabInput) => {
    if (!input || typeof input !== 'object' || typeof input.tabId !== 'string' || !input.tabId.trim() || !Number.isInteger(input.targetIndex)) {
      throw new Error('网页页签重排参数不正确')
    }
    return reorderWebTab(input)
  })
  ipcMain.handle(WEB_IPC_CHANNELS.UPDATE_BOUNDS, (_event, input: UpdateWebTabBoundsInput) => updateWebTabBounds(input))
}

export function registerWebTabsNavigationIpcHandlers(): void {
  ipcMain.handle(WEB_IPC_CHANNELS.GO_BACK, (_event, tabId: string) => goBackWebTab(tabId))
  ipcMain.handle(WEB_IPC_CHANNELS.GO_FORWARD, (_event, tabId: string) => goForwardWebTab(tabId))
  ipcMain.handle(WEB_IPC_CHANNELS.RELOAD, (_event, tabId: string) => reloadWebTab(tabId))
}

export function registerWebTabsProjectIpcHandlers(): void {
  ipcMain.handle(WEB_IPC_CHANNELS.PROJECT_ASSOCIATION_GET, (_event, url: string) => {
    if (typeof url !== 'string') throw new Error('页面项目关联地址不正确')
    return getWebPageProjectAssociation(url)
  })
  ipcMain.handle(WEB_IPC_CHANNELS.PROJECT_ASSOCIATION_SAVE, (_event, input: SaveWebPageProjectAssociationInput) => {
    if (!input || typeof input !== 'object' || typeof input.url !== 'string' || typeof input.workspaceId !== 'string') {
      throw new Error('页面项目关联参数不正确')
    }
    return saveWebPageProjectAssociation(input)
  })
  ipcMain.handle(WEB_IPC_CHANNELS.JAVASCRIPT_PROMPT_GET, (event, requestId: string) => (
    getWebJavascriptPromptRequest(requestId, event.sender.id)
  ))
  ipcMain.handle(WEB_IPC_CHANNELS.JAVASCRIPT_PROMPT_RESOLVE, (event, input) => (
    resolveWebJavascriptPromptRequest(input, event.sender.id)
  ))
  ipcMain.handle(WEB_IPC_CHANNELS.JAVASCRIPT_PROMPT_CANCEL, (event, requestId: string) => (
    cancelWebJavascriptPromptRequest(requestId, event.sender.id)
  ))
}

export function registerWebTabsIpcHandlers(): void {
  registerWebTabsCoreIpcHandlers()
  registerWebTabsNavigationIpcHandlers()
  registerWebTabsProjectIpcHandlers()
}
