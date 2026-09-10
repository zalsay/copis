import { ipcMain } from 'electron'
import { AGENT_MAIL_IPC_CHANNELS } from '@copis/shared'
import { AgentMailService } from '../lib/agent-mail-service'

export function registerAgentMailIpcHandlers(): void {
  // ===== Agent Mail (QQ 邮箱) =====
  ipcMain.handle(AGENT_MAIL_IPC_CHANNELS.GET_STATUS, async () => {
    return AgentMailService.getInstance().getStatus()
  })

  ipcMain.handle(AGENT_MAIL_IPC_CHANNELS.START_LOGIN, async () => {
    return AgentMailService.getInstance().startLogin()
  })

  ipcMain.handle(AGENT_MAIL_IPC_CHANNELS.CANCEL_LOGIN, async () => {
    AgentMailService.getInstance().cancelLogin()
  })

  ipcMain.handle(AGENT_MAIL_IPC_CHANNELS.LOGOUT, async () => {
    return AgentMailService.getInstance().logout()
  })
}
