import { ipcMain, shell } from 'electron'
import { WORKING_IPC_CHANNELS, type WorkingLoginInput, type WorkingRegisterInput, type WorkingSendVerificationCodeInput, type WorkingVerifyPasswordResetCodeInput, type WorkingPasswordResetInput, type WorkingWorkspaceInput, type WorkingFeedbackInput, type WorkingReceiveChannel } from '@copis/shared'
import { getWorkingApiClient } from '../lib/working-api-service'
import { getDshCordisStatus, reloadDshCordisPlugins } from '../lib/dsh-cordis-service'
import { getWorkingModelCatalogAccess } from '../lib/working-model-catalog-access'

export function registerWorkingAccountIpcHandlers(): void {
  ipcMain.handle(WORKING_IPC_CHANNELS.GET_CONFIG, async () => ({
    backendUrl: getWorkingApiClient().baseUrl,
  }))

  ipcMain.handle(WORKING_IPC_CHANNELS.GET_AUTH_STATE, async () => {
    const client = getWorkingApiClient()
    const previousAccess = JSON.stringify(getWorkingModelCatalogAccess())
    const state = await client.getAuthState()
    if (getDshCordisStatus().running && previousAccess !== JSON.stringify(getWorkingModelCatalogAccess())) {
      await reloadDshCordisPlugins({ startIfNeeded: false })
    }
    return {
      ...state,
      backendUrl: client.baseUrl,
    }
  })

  ipcMain.handle(WORKING_IPC_CHANNELS.LOGIN, async (_, input: WorkingLoginInput) => {
    if (!input || typeof input !== 'object' || typeof input.email !== 'string' || typeof input.password !== 'string') {
      throw new Error('登录参数不正确')
    }
    const client = getWorkingApiClient()
    await client.login(input)
    const state = await client.getAuthState()
    if (getDshCordisStatus().running) await reloadDshCordisPlugins({ startIfNeeded: false })
    return {
      ...state,
      backendUrl: client.baseUrl,
    }
  })

  ipcMain.handle(WORKING_IPC_CHANNELS.LOGIN_OIDC, async () => {
    const client = getWorkingApiClient()
    const result = await client.loginWithOAuth((url) => shell.openExternal(url))
    if (getDshCordisStatus().running) await reloadDshCordisPlugins({ startIfNeeded: false })
    return {
      authenticated: true,
      user: result.user ?? client.getCachedUser(),
      backendUrl: client.baseUrl,
    }
  })

  ipcMain.handle(WORKING_IPC_CHANNELS.REGISTER, async (_, input: WorkingRegisterInput) => {
    if (!input || typeof input !== 'object' || typeof input.email !== 'string' || typeof input.password !== 'string') {
      throw new Error('注册参数不正确')
    }
    return getWorkingApiClient().register(input)
  })

  ipcMain.handle(WORKING_IPC_CHANNELS.SEND_VERIFICATION_CODE, async (_, input: WorkingSendVerificationCodeInput) => {
    if (!input || typeof input !== 'object' || typeof input.email !== 'string') {
      throw new Error('验证码参数不正确')
    }
    return getWorkingApiClient().sendVerificationCode(input)
  })

  ipcMain.handle(WORKING_IPC_CHANNELS.VERIFY_PASSWORD_RESET_CODE, async (_, input: WorkingVerifyPasswordResetCodeInput) => {
    if (!input || typeof input !== 'object' || typeof input.email !== 'string' || typeof input.code !== 'string') {
      throw new Error('验证码参数不正确')
    }
    return getWorkingApiClient().verifyPasswordResetCode(input)
  })

  ipcMain.handle(WORKING_IPC_CHANNELS.RESET_PASSWORD, async (_, input: WorkingPasswordResetInput) => {
    if (!input || typeof input !== 'object' || typeof input.email !== 'string' || typeof input.resetToken !== 'string' || typeof input.password !== 'string') {
      throw new Error('密码重置参数不正确')
    }
    return getWorkingApiClient().resetPassword(input)
  })

  ipcMain.handle(WORKING_IPC_CHANNELS.LOGOUT, async () => {
    const client = getWorkingApiClient()
    await client.logout()
    if (getDshCordisStatus().running) await reloadDshCordisPlugins({ startIfNeeded: false })
    return { authenticated: false, user: null, backendUrl: client.baseUrl }
  })

  ipcMain.handle(WORKING_IPC_CHANNELS.GET_CURRENT_USER, async () => {
    const previousAccess = JSON.stringify(getWorkingModelCatalogAccess())
    const user = await getWorkingApiClient().getCurrentUser()
    if (getDshCordisStatus().running && previousAccess !== JSON.stringify(getWorkingModelCatalogAccess())) {
      await reloadDshCordisPlugins({ startIfNeeded: false })
    }
    return user
  })

  ipcMain.handle(WORKING_IPC_CHANNELS.LIST_WORKSPACES, async () => {
    return getWorkingApiClient().listWorkspaces()
  })

  ipcMain.handle(WORKING_IPC_CHANNELS.SAVE_WORKSPACE, async (_, input: WorkingWorkspaceInput) => {
    if (!input || typeof input !== 'object' || typeof input.workspacePath !== 'string') {
      throw new Error('工作区参数不正确')
    }
    return getWorkingApiClient().saveWorkspace(input)
  })

  ipcMain.handle(WORKING_IPC_CHANNELS.LIST_SESSIONS, async () => {
    return getWorkingApiClient().listSessions()
  })

  ipcMain.handle(WORKING_IPC_CHANNELS.GET_SESSION_HISTORY, async (_, runId: string, sessionId?: string) => {
    if (typeof runId !== 'string') throw new Error('runId 参数不正确')
    return getWorkingApiClient().getSessionHistory(runId, sessionId)
  })

  ipcMain.handle(WORKING_IPC_CHANNELS.LIST_SKILLS, async () => {
    return getWorkingApiClient().listSkills()
  })

  ipcMain.handle(WORKING_IPC_CHANNELS.CREATE_FEEDBACK, async (_, input: WorkingFeedbackInput) => {
    if (!input || typeof input !== 'object' || typeof input.title !== 'string' || typeof input.description !== 'string') {
      throw new Error('反馈参数不正确')
    }
    return getWorkingApiClient().createFeedback(input)
  })

  ipcMain.handle(WORKING_IPC_CHANNELS.GET_SETTINGS_SNAPSHOT, async () => {
    return getWorkingApiClient().getSettingsSnapshot()
  })

  ipcMain.handle(WORKING_IPC_CHANNELS.CHECK_IN, async () => {
    return getWorkingApiClient().checkIn()
  })

  ipcMain.handle(WORKING_IPC_CHANNELS.SET_RECEIVE_CHANNEL, async (_, channel: WorkingReceiveChannel) => {
    if (channel !== 'weixin' && channel !== 'feishu') throw new Error('消息接收方式不正确')
    return getWorkingApiClient().setReceiveChannel(channel)
  })
}
