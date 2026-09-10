import { ipcMain } from 'electron'
import { CHANNEL_IPC_CHANNELS } from '@copis/shared'
import type { Channel, ChannelCreateInput, ChannelUpdateInput, ChannelTestResult, ChannelDirectTestInput, FetchModelsInput, FetchModelsResult } from '@copis/shared'
import { listChannels, createChannel, updateChannel, deleteChannel, decryptApiKey, testChannel, testChannelDirect, fetchModels, getChannelPlanQuota } from '../lib/channel-manager'
import { loginCodexOAuth, cancelCodexOAuthLogin } from '../lib/codex-oauth-service'
import { loginXaiOAuth, cancelXaiOAuthLogin } from '../lib/xai-oauth-service'
import { serializeCodexCredentials, serializeXaiCredentials } from '@copis/shared'

export function registerChannelsIpcHandlers(): void {
  // ===== 渠道管理相关 =====

  // 获取所有渠道（apiKey 保持加密态）
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.LIST,
    async (): Promise<Channel[]> => {
      return listChannels()
    }
  )

  // 创建渠道
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.CREATE,
    async (_, input: ChannelCreateInput): Promise<Channel> => {
      return createChannel(input)
    }
  )

  // 更新渠道
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.UPDATE,
    async (_, id: string, input: ChannelUpdateInput): Promise<Channel> => {
      return updateChannel(id, input)
    }
  )

  // 删除渠道
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.DELETE,
    async (_, id: string): Promise<void> => {
      return deleteChannel(id)
    }
  )

  // 解密 API Key（仅在用户查看时调用）
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.DECRYPT_KEY,
    async (_, channelId: string): Promise<string> => {
      return decryptApiKey(channelId)
    }
  )

  // 测试渠道连接
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.TEST,
    async (_, channelId: string): Promise<ChannelTestResult> => {
      return testChannel(channelId)
    }
  )

  // 直接测试连接（无需已保存渠道，传入明文凭证）
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.TEST_DIRECT,
    async (_, input: ChannelDirectTestInput): Promise<ChannelTestResult> => {
      return testChannelDirect(input)
    }
  )

  // 从供应商拉取可用模型列表（直接传入凭证，无需已保存渠道）
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.FETCH_MODELS,
    async (_, input: FetchModelsInput): Promise<FetchModelsResult> => {
      return fetchModels(input)
    }
  )

  // 查询订阅 Plan 额度（用于 Agent Context 圆环 hover 信息）
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.GET_PLAN_QUOTA,
    async (_, channelId: string): Promise<import('@copis/shared').ChannelPlanQuotaResult> => {
      return getChannelPlanQuota(channelId)
    }
  )

  // 发起 ChatGPT (Codex) OAuth 登录。登录在主进程执行（Pi SDK 用 Node crypto +
  // 本地 :1455 回调服务）；成功后返回序列化的凭据 JSON（明文），由渲染层作为
  // apiKey 传给 create/update，channel-manager 加密后存储——与现有 apiKey 明文回传模式一致。
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.CODEX_OAUTH_LOGIN,
    async (): Promise<import('@copis/shared').CodexOAuthLoginResult> => {
      try {
        const credentials = await loginCodexOAuth()
        return {
          success: true,
          credentials: serializeCodexCredentials(credentials),
          ...(credentials.accountId ? { accountId: credentials.accountId } : {}),
        }
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
        }
      }
    }
  )

  // 取消进行中的 ChatGPT OAuth 登录流程
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.CODEX_OAUTH_CANCEL,
    async (): Promise<void> => {
      cancelCodexOAuthLogin()
    }
  )

  // 发起 xAI（Grok/X 订阅）OAuth device-code 登录。Pi 会通过 device-code 事件给出
  // 预填的浏览器授权链接；成功后的凭据沿用 Channel.apiKey 加密存储。
  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.XAI_OAUTH_LOGIN,
    async (event): Promise<import('@copis/shared').XaiOAuthLoginResult> => {
      try {
        const credentials = await loginXaiOAuth({
          onDeviceCode: (deviceCode) => event.sender.send(CHANNEL_IPC_CHANNELS.XAI_OAUTH_DEVICE_CODE, deviceCode),
        })
        return { success: true, credentials: serializeXaiCredentials(credentials) }
      } catch (error) {
        return { success: false, message: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle(
    CHANNEL_IPC_CHANNELS.XAI_OAUTH_CANCEL,
    async (): Promise<void> => {
      cancelXaiOAuthLogin()
    }
  )
}
