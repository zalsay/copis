import type { DingTalkOAuthExchangeInput, DingTalkOAuthExchangeResult } from '@copis/shared'
import {
  getDecryptedBotClientSecret,
  getDecryptedClientSecret,
  getDingTalkConfig,
  getDingTalkMultiBotConfig,
  saveDingTalkBotConfig,
} from './dingtalk-config'
import { dingtalkBridgeManager } from './dingtalk-bridge-manager'
import { redactSensitiveLogValue } from './bridge-log-redaction'

/**
 * 交换钉钉 OAuth 2.0 authCode 并获取用户信息及完成绑定
 */
export async function exchangeDingTalkAuthCode(
  input: DingTalkOAuthExchangeInput,
): Promise<DingTalkOAuthExchangeResult> {
  try {
    const multi = getDingTalkMultiBotConfig()
    const firstBot = multi.bots[0]
    const legacy = getDingTalkConfig()

    const clientId = input.clientId?.trim()
      || firstBot?.clientId
      || legacy.clientId
    const clientSecret = input.clientSecret?.trim()
      || (firstBot ? getDecryptedBotClientSecret(firstBot.id) : undefined)
      || getDecryptedClientSecret()

    if (!clientId) {
      return {
        success: false,
        message: '未配置钉钉 Client ID (AppKey)，无法完成 OAuth 凭证换取',
      }
    }

    if (!clientSecret) {
      return {
        success: false,
        message: '未配置钉钉 Client Secret，无法换取 Access Token',
      }
    }

    // 1. 调用钉钉开放平台接口换取用户 userAccessToken
    const tokenResp = await fetch('https://api.dingtalk.com/v1.0/oauth2/userAccessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId,
        clientSecret,
        code: input.authCode,
        grantType: 'authorization_code',
      }),
    })

    if (!tokenResp.ok) {
      const errBody = await tokenResp.text()
      console.error('[钉钉 OAuth] 换取 userAccessToken 失败:', redactSensitiveLogValue(errBody))
      return {
        success: false,
        message: `钉钉授权失败: HTTP ${tokenResp.status}`,
      }
    }

    const tokenData = (await tokenResp.json()) as {
      accessToken?: string
      expireIn?: number
      refreshToken?: string
      corpId?: string
      openId?: string
      unionId?: string
    }

    const accessToken = tokenData.accessToken
    if (!accessToken) {
      return {
        success: false,
        message: '钉钉授权返回缺少 accessToken',
      }
    }

    // 2. 获取用户个人资料
    let nick = '钉钉用户'
    let avatarUrl: string | undefined
    try {
      const userResp = await fetch('https://api.dingtalk.com/v1.0/contact/users/me', {
        headers: {
          'x-acs-dingtalk-access-token': accessToken,
        },
      })
      if (userResp.ok) {
        const userData = (await userResp.json()) as {
          nick?: string
          avatarUrl?: string
          openId?: string
          unionId?: string
        }
        if (userData.nick) nick = userData.nick
        if (userData.avatarUrl) avatarUrl = userData.avatarUrl
      }
    } catch (userErr) {
      console.warn('[钉钉 OAuth] 获取用户信息失败:', redactSensitiveLogValue(userErr))
    }

    // 3. 自动保存并启用 Bot 配置
    const bot = saveDingTalkBotConfig({
      id: firstBot?.id,
      name: firstBot?.name || `钉钉助手 (${nick})`,
      clientId,
      clientSecret: input.clientSecret?.trim() || '',
      enabled: true,
    })

    // 4. 尝试启动 Stream WebSocket 连接
    try {
      await dingtalkBridgeManager.restartBot(bot.id)
    } catch (startErr) {
      console.warn('[钉钉 OAuth] 启动 Bridge 失败:', redactSensitiveLogValue(startErr))
    }

    return {
      success: true,
      accessToken,
      openId: tokenData.openId,
      unionId: tokenData.unionId,
      nick,
      avatarUrl,
    }
  } catch (error) {
    console.error('[钉钉 OAuth] 授权流程异常:', redactSensitiveLogValue(error))
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
