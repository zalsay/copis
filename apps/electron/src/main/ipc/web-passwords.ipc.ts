import { ipcMain } from 'electron'
import {
  WEB_PASSWORD_IPC_CHANNELS,
  type WebPasswordPromptResolveInput,
  type WebPasswordSettings,
} from '@copis/shared'
import type { SaveLoginInput } from '../lib/web-password-database'
import { getWebPasswordService } from '../lib/web-password-service'
import { getWebTabContents } from '../lib/web-tab-manager'

export function registerWebPasswordsIpcHandlers(): void {
  ipcMain.handle(WEB_PASSWORD_IPC_CHANNELS.LIST, (_event, searchQuery?: string) => {
    return getWebPasswordService().listLogins(searchQuery)
  })

  ipcMain.handle(WEB_PASSWORD_IPC_CHANNELS.GET_BY_ORIGIN, (_event, originUrl: string) => {
    if (!originUrl) return []
    return getWebPasswordService().getLoginsByOrigin(originUrl)
  })

  ipcMain.handle(WEB_PASSWORD_IPC_CHANNELS.REVEAL, (_event, id: string) => {
    if (!id) return null
    return getWebPasswordService().revealPassword(id)
  })

  ipcMain.handle(WEB_PASSWORD_IPC_CHANNELS.SAVE_OR_UPDATE, (_event, input: SaveLoginInput) => {
    return getWebPasswordService().saveOrUpdateLogin(input)
  })

  ipcMain.handle(WEB_PASSWORD_IPC_CHANNELS.REMOVE, (_event, id: string) => {
    if (!id) return false
    return getWebPasswordService().removeLogin(id)
  })

  ipcMain.handle(WEB_PASSWORD_IPC_CHANNELS.GET_ACTIVE_PROMPT, (_event, tabId: string) => {
    if (!tabId) return null
    return getWebPasswordService().getActivePrompt(tabId)
  })

  ipcMain.handle(WEB_PASSWORD_IPC_CHANNELS.RESOLVE_PROMPT, async (_event, input: WebPasswordPromptResolveInput) => {
    await getWebPasswordService().resolvePrompt(input)
  })

  ipcMain.handle(WEB_PASSWORD_IPC_CHANNELS.LIST_DISABLED_ORIGINS, () => {
    return getWebPasswordService().listDisabledOrigins()
  })

  ipcMain.handle(WEB_PASSWORD_IPC_CHANNELS.ADD_DISABLED_ORIGIN, (_event, originUrl: string) => {
    return getWebPasswordService().addDisabledOrigin(originUrl)
  })

  ipcMain.handle(WEB_PASSWORD_IPC_CHANNELS.REMOVE_DISABLED_ORIGIN, (_event, id: string) => {
    return getWebPasswordService().removeDisabledOrigin(id)
  })

  ipcMain.handle(WEB_PASSWORD_IPC_CHANNELS.FILL_CREDENTIALS, async (_event, { tabId, entryId }: { tabId: string; entryId: string }) => {
    const contents = getWebTabContents(tabId)
    return getWebPasswordService().fillCredentials(tabId, entryId, contents)
  })

  ipcMain.handle(WEB_PASSWORD_IPC_CHANNELS.GET_SETTINGS, () => {
    return getWebPasswordService().getSettings()
  })

  ipcMain.handle(WEB_PASSWORD_IPC_CHANNELS.UPDATE_SETTINGS, (_event, partial: Partial<WebPasswordSettings>) => {
    return getWebPasswordService().updateSettings(partial)
  })
}
