import * as React from 'react'
import type { WorkingReceiveChannel, WorkingReceiveChannelSettings, AgentMailStatus } from '@copis/shared'
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Mail,
  RefreshCw,
  Smartphone,
} from 'lucide-react'
import QRCode from 'qrcode'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import wechatLogo from '@/assets/bots/wechat.png'
import feishuLogo from '@/assets/bots/feishu.png'
import dingtalkLogo from '@/assets/bots/dingding.png'
import './CopisWorkingMessageSettingsPanel.css'

interface MessageChannelOption {
  id: WorkingReceiveChannel
  name: string
  description: string
  boundKey: 'weixinBound' | 'feishuBound' | 'dingtalkBound'
  icon: string
}

const messageChannels: readonly MessageChannelOption[] = [
  {
    id: 'weixin',
    name: '微信',
    description: '通过微信机器人接收 Copis 工作消息。',
    boundKey: 'weixinBound',
    icon: wechatLogo,
  },
  {
    id: 'feishu',
    name: '飞书',
    description: '通过飞书机器人接收 Copis 工作消息。',
    boundKey: 'feishuBound',
    icon: feishuLogo,
  },
  {
    id: 'dingtalk',
    name: '钉钉',
    description: '通过钉钉机器人接收 Copis 工作消息。',
    boundKey: 'dingtalkBound',
    icon: dingtalkLogo,
  },
] as const

interface CopisWorkingMessageSettingsPanelProps {
  settings: WorkingReceiveChannelSettings | null
  onSettingsChange: (settings: WorkingReceiveChannelSettings) => void
  onRefresh?: () => Promise<void>
}

export function CopisWorkingMessageSettingsPanel({
  settings,
  onSettingsChange,
  onRefresh,
}: CopisWorkingMessageSettingsPanelProps): React.ReactElement {
  const [savingChannel, setSavingChannel] = React.useState<WorkingReceiveChannel | null>(null)
  const [error, setError] = React.useState('')
  const [rebindChannel, setRebindChannel] = React.useState<WorkingReceiveChannel | 'agent-mail' | null>(null)
  const [checkingBinding, setCheckingBinding] = React.useState(false)
  const [feedback, setFeedback] = React.useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [qrCodeDataUrl, setQrCodeDataUrl] = React.useState<string>('')
  const [qrSeed, setQrSeed] = React.useState<number>(Date.now())

  // Agent Mail 状态
  const [agentMailStatus, setAgentMailStatus] = React.useState<AgentMailStatus | null>(null)
  const [agentMailAuthUrl, setAgentMailAuthUrl] = React.useState<string>('')
  const [loggingOutMail, setLoggingOutMail] = React.useState(false)

  // 钉钉表单状态
  const [dingtalkClientId, setDingtalkClientId] = React.useState('')
  const [dingtalkClientSecret, setDingtalkClientSecret] = React.useState('')
  const [dingtalkBotName, setDingtalkBotName] = React.useState('钉钉助手')
  const [dingtalkMode, setDingtalkMode] = React.useState<'qrcode' | 'manual'>('manual')
  const [testingDingtalk, setTestingDingtalk] = React.useState(false)

  const activeRebindOption = messageChannels.find((item) => item.id === rebindChannel)

  // 钉钉 OAuth 扫码生成
  React.useEffect(() => {
    if (rebindChannel !== 'dingtalk' || dingtalkMode !== 'qrcode') return undefined

    let isMounted = true
    const cid = dingtalkClientId.trim()
    if (!cid) {
      setQrCodeDataUrl('')
      return undefined
    }

    const oauthUrl = `https://login.dingtalk.com/oauth2/auth?client_id=${encodeURIComponent(cid)}&response_type=code&scope=openid+corpid&prompt=consent&redirect_uri=https://copis.ai/callback&state=${Date.now()}`

    QRCode.toDataURL(oauthUrl, { width: 280, margin: 2, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (isMounted) setQrCodeDataUrl(url)
      })
      .catch(console.error)

    // 监听钉钉 OAuth postMessage 回调
    const handleMessage = async (event: MessageEvent) => {
      if (typeof event.data === 'object' && event.data?.redirectUrl) {
        try {
          const parsed = new URL(event.data.redirectUrl)
          const authCode = parsed.searchParams.get('authCode')
          if (authCode) {
            setFeedback({ type: 'success', message: '钉钉扫码成功！正在换取凭证...' })
            const result = await window.electronAPI.exchangeDingTalkAuthCode({
              authCode,
              clientId: dingtalkClientId.trim() || undefined,
              clientSecret: dingtalkClientSecret.trim() || undefined,
            })
            if (result.success) {
              const nextSettings = await window.electronAPI.setWorkingReceiveChannel('dingtalk')
              onSettingsChange(nextSettings)
              if (onRefresh) await onRefresh()
              setFeedback({ type: 'success', message: `绑定成功！已关联钉钉账号 ${result.nick || ''}` })
              setTimeout(() => {
                setRebindChannel(null)
                setFeedback(null)
              }, 1000)
            } else {
              setFeedback({ type: 'error', message: result.message || '钉钉授权换取失败' })
            }
          }
        } catch (e) {
          console.error('[钉钉扫码] 解析回调失败:', e)
        }
      }
    }

    window.addEventListener('message', handleMessage)
    return () => {
      isMounted = false
      window.removeEventListener('message', handleMessage)
    }
  }, [rebindChannel, dingtalkMode, dingtalkClientId, dingtalkClientSecret, qrSeed, onRefresh, onSettingsChange])

  // 飞书官方 SDK 扫码一键注册与授权 (Hermes 协议)
  React.useEffect(() => {
    if (rebindChannel !== 'feishu') return undefined

    let isMounted = true
    setQrCodeDataUrl('')

    const unsubscribeQr = window.electronAPI.onFeishuRegisterQrcode?.((payload) => {
      if (!isMounted) return
      if (payload.dataUrl) {
        setQrCodeDataUrl(payload.dataUrl)
      } else if (payload.url) {
        QRCode.toDataURL(payload.url, { width: 280, margin: 1, errorCorrectionLevel: 'M' })
          .then((dataUrl) => {
            if (isMounted) setQrCodeDataUrl(dataUrl)
          })
          .catch(console.error)
      }
    })

    const unsubscribeStatus = window.electronAPI.onFeishuRegisterStatus?.((payload) => {
      if (!isMounted) return
      if (payload.status === 'polling') {
        // 正在轮询等待用户扫码授权
      }
    })

    // 发起官方飞书扫码注册流程
    window.electronAPI.registerFeishuApp?.()
      .then(async (result) => {
        if (!isMounted) return
        setFeedback({ type: 'success', message: '飞书授权成功！正在保存配置...' })

        try {
          if (result?.appId && result?.appSecret) {
            const bot = await window.electronAPI.saveFeishuBotConfig?.({
              name: result.tenantBrand ? `飞书助手 (${result.tenantBrand})` : '飞书助手',
              appId: result.appId,
              appSecret: result.appSecret,
              enabled: true,
            })
            if (bot?.id) {
              await window.electronAPI.startFeishuBot?.(bot.id)
            }
          }

          // 同步接收渠道
          const nextSettings = await window.electronAPI.setWorkingReceiveChannel('feishu')
          onSettingsChange(nextSettings)
          if (onRefresh) {
            await onRefresh()
          }

          // 授权成功立即关闭弹窗
          if (isMounted) {
            setRebindChannel(null)
            setFeedback(null)
          }
        } catch (saveErr) {
          console.error('[飞书扫码] 保存飞书配置失败:', saveErr)
          setFeedback({
            type: 'error',
            message: saveErr instanceof Error ? saveErr.message : '保存飞书配置失败，请重试',
          })
        }
      })
      .catch((regErr) => {
        if (!isMounted) return
        const message = regErr instanceof Error ? regErr.message : String(regErr)
        // 排除用户主动取消
        if (!message.includes('abort') && !message.includes('cancel')) {
          setFeedback({
            type: 'error',
            message: `飞书扫码授权失败: ${message}`,
          })
        }
      })

    return () => {
      isMounted = false
      unsubscribeQr?.()
      unsubscribeStatus?.()
      window.electronAPI.cancelFeishuRegistration?.().catch(() => {})
    }
  }, [rebindChannel, qrSeed, onRefresh, onSettingsChange])

  // 微信官方 iLink Bot 扫码授权与登录
  React.useEffect(() => {
    if (rebindChannel !== 'weixin') return undefined

    let isMounted = true
    setQrCodeDataUrl('')

    const unsubscribeStatus = window.electronAPI.onWeChatStatusChanged?.((state) => {
      if (!isMounted) return
      if (state.qrCodeData) {
        setQrCodeDataUrl(state.qrCodeData)
      }
      if (state.status === 'scanned') {
        setFeedback({ type: 'success', message: '已扫码，请在手机微信上点击确认授权...' })
      } else if (state.status === 'connected') {
        setFeedback({ type: 'success', message: '微信授权绑定成功！已完成配置。' })
        void (async () => {
          try {
            const nextSettings = await window.electronAPI.setWorkingReceiveChannel('weixin')
            if (isMounted) {
              onSettingsChange(nextSettings)
              if (onRefresh) {
                await onRefresh()
              }
              setRebindChannel(null)
              setFeedback(null)
            }
          } catch (saveErr) {
            console.error('[微信扫码] 同步接收渠道失败:', saveErr)
          }
        })()
      } else if (state.status === 'error' && state.errorMessage) {
        setFeedback({
          type: 'error',
          message: `微信扫码授权失败: ${state.errorMessage}`,
        })
      }
    })

    // 发起微信 Bot 扫码登录流程
    window.electronAPI.startWeChatLogin?.().catch((loginErr) => {
      if (!isMounted) return
      const message = loginErr instanceof Error ? loginErr.message : String(loginErr)
      if (!message.includes('abort') && !message.includes('cancel')) {
        setFeedback({
          type: 'error',
          message: `获取微信二维码失败: ${message}`,
        })
      }
    })

    return () => {
      isMounted = false
      unsubscribeStatus?.()
      window.electronAPI.stopWeChatBridge?.().catch(() => {})
    }
  }, [rebindChannel, qrSeed, onRefresh, onSettingsChange])

  // 钉钉配置加载
  React.useEffect(() => {
    if (rebindChannel !== 'dingtalk') return
    let isMounted = true
    window.electronAPI.getDingTalkMultiConfig?.()
      .then((multi) => {
        if (!isMounted) return
        const firstBot = multi?.bots?.[0]
        if (firstBot) {
          setDingtalkClientId(firstBot.clientId || '')
          setDingtalkBotName(firstBot.name || '钉钉助手')
        }
      })
      .catch(() => {
        window.electronAPI.getDingTalkConfig?.().then((cfg) => {
          if (!isMounted || !cfg) return
          setDingtalkClientId(cfg.clientId || '')
        }).catch(() => {})
      })
    return () => {
      isMounted = false
    }
  }, [rebindChannel])

  // Agent Mail 状态加载与事件监听
  React.useEffect(() => {
    let isMounted = true
    window.electronAPI.getAgentMailStatus?.()
      .then((status) => {
        if (isMounted && status) setAgentMailStatus(status)
      })
      .catch(console.error)

    const unsubscribe = window.electronAPI.onAgentMailStatusChanged?.((status) => {
      if (!isMounted) return
      setAgentMailStatus(status)
      if (status.status === 'connected' && rebindChannel === 'agent-mail') {
        setFeedback({ type: 'success', message: `Agent 邮箱绑定成功！已关联 ${status.email || ''}` })
        setTimeout(() => {
          setRebindChannel(null)
          setFeedback(null)
        }, 1000)
      }
    })

    return () => {
      isMounted = false
      unsubscribe?.()
    }
  }, [rebindChannel])

  // Agent Mail 发起登录
  React.useEffect(() => {
    if (rebindChannel !== 'agent-mail') return undefined
    let isMounted = true
    setQrCodeDataUrl('')
    setAgentMailAuthUrl('')

    window.electronAPI.startAgentMailLogin?.()
      .then((res) => {
        if (!isMounted) return
        setAgentMailAuthUrl(res.authUrl)
        setQrCodeDataUrl(res.qrCodeDataUrl)
      })
      .catch((err) => {
        if (!isMounted) return
        const msg = err instanceof Error ? err.message : String(err)
        if (!msg.includes('abort') && !msg.includes('cancel')) {
          setFeedback({ type: 'error', message: `启动授权失败: ${msg}` })
        }
      })

    return () => {
      isMounted = false
      window.electronAPI.cancelAgentMailLogin?.().catch(() => {})
    }
  }, [rebindChannel, qrSeed])

  const handleLogoutAgentMail = async (): Promise<void> => {
    setLoggingOutMail(true)
    try {
      const nextStatus = await window.electronAPI.logoutAgentMail()
      setAgentMailStatus(nextStatus)
      setFeedback({ type: 'success', message: '已成功退出 Agent 邮箱登录' })
      setTimeout(() => setFeedback(null), 1500)
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : '退出登录失败',
      })
    } finally {
      setLoggingOutMail(false)
    }
  }

  const handleSaveDingTalk = async (): Promise<void> => {
    if (!dingtalkClientId.trim() || !dingtalkClientSecret.trim()) {
      setFeedback({ type: 'error', message: '请填写 Client ID (AppKey) 和 Client Secret (AppSecret)' })
      return
    }
    setTestingDingtalk(true)
    setFeedback(null)
    try {
      const testResult = await window.electronAPI.testDingTalkConnection(
        dingtalkClientId.trim(),
        dingtalkClientSecret.trim(),
      )
      if (!testResult?.success) {
        setFeedback({
          type: 'error',
          message: `连接测试失败: ${testResult?.message || '请检查 Client ID 和 Client Secret 是否正确'}`,
        })
        return
      }

      await window.electronAPI.saveDingTalkBotConfig?.({
        name: dingtalkBotName.trim() || '钉钉助手',
        clientId: dingtalkClientId.trim(),
        clientSecret: dingtalkClientSecret.trim(),
        enabled: true,
      })
      await window.electronAPI.startDingTalkBridge?.()

      const nextSettings = await window.electronAPI.setWorkingReceiveChannel('dingtalk')
      onSettingsChange(nextSettings)
      if (onRefresh) {
        await onRefresh()
      }
      setFeedback({ type: 'success', message: '钉钉机器人绑定成功！' })
      setTimeout(() => {
        setRebindChannel(null)
        setFeedback(null)
      }, 800)
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : '保存钉钉机器人配置失败，请重试',
      })
    } finally {
      setTestingDingtalk(false)
    }
  }

  const handleSelectChannel = async (channel: WorkingReceiveChannel): Promise<void> => {
    if (savingChannel || !settings || channel === settings.channel) return
    setSavingChannel(channel)
    setError('')
    try {
      const nextSettings = await window.electronAPI.setWorkingReceiveChannel(channel)
      onSettingsChange(nextSettings)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '更新消息接收方式失败，请稍后重试')
    } finally {
      setSavingChannel(null)
    }
  }

  const handleOpenRebind = (channel: WorkingReceiveChannel | 'agent-mail'): void => {
    setRebindChannel(channel)
    setFeedback(null)
    setQrSeed(Date.now())
  }

  // 轮询检查绑定状态
  const checkStatusSilently = React.useCallback(async (targetChannel: WorkingReceiveChannel): Promise<boolean> => {
    try {
      if (targetChannel === 'weixin') {
        const wechatState = await window.electronAPI.getWeChatStatus?.()
        if (wechatState?.status === 'connected') return true
      } else if (targetChannel === 'dingtalk') {
        const dtState = await window.electronAPI.getDingTalkStatus?.()
        if (dtState?.status === 'connected') return true
      }
      const snapshot = await window.electronAPI.getWorkingSettingsSnapshot()
      if (snapshot.receiveChannel) {
        onSettingsChange(snapshot.receiveChannel)
      }
      if (onRefresh) {
        await onRefresh()
      }
      const boundKey: 'weixinBound' | 'feishuBound' | 'dingtalkBound' =
        targetChannel === 'weixin' ? 'weixinBound' : (targetChannel === 'dingtalk' ? 'dingtalkBound' : 'feishuBound')
      return snapshot.receiveChannel?.[boundKey] === true
    } catch {
      return false
    }
  }, [onRefresh, onSettingsChange])

  const handleManualCheck = async (): Promise<void> => {
    if (!rebindChannel || checkingBinding) return
    setCheckingBinding(true)
    setFeedback(null)
    try {
      if (rebindChannel === 'agent-mail') {
        const mailStatus = await window.electronAPI.getAgentMailStatus?.()
        if (mailStatus?.loggedIn) {
          setAgentMailStatus(mailStatus)
          setFeedback({ type: 'success', message: `已完成 Agent 邮箱绑定 (${mailStatus.email || ''})` })
          setTimeout(() => {
            setRebindChannel(null)
            setFeedback(null)
          }, 800)
        } else {
          setFeedback({
            type: 'error',
            message: '尚未检测到授权，请在微信/QQ扫码或在浏览器中同意授权后重试。',
          })
        }
        return
      }

      const isBound = await checkStatusSilently(rebindChannel)
      if (isBound) {
        setRebindChannel(null)
        setFeedback(null)
      } else {
        setFeedback({
          type: 'error',
          message:
            rebindChannel === 'weixin'
              ? '尚未检测到微信绑定，请在手机微信扫码关注并确认后重试。'
              : rebindChannel === 'dingtalk'
              ? '尚未检测到钉钉连接，请先输入凭证并点击「测试并完成绑定」。'
              : '尚未检测到飞书授权，请在手机飞书「扫一扫」确认授权后重试。',
        })
      }
    } catch (checkError) {
      setFeedback({
        type: 'error',
        message: checkError instanceof Error ? checkError.message : '检查绑定状态失败，请稍后重试',
      })
    } finally {
      setCheckingBinding(false)
    }
  }

  return (
    <section className="copis-working-message-settings" aria-label="App 连接器">
      {error && <div className="copis-working-message-error" role="alert">{error}</div>}

      <div className="copis-working-message-channel-list">
        {messageChannels.map((channel) => {
          const isSelected = settings?.channel === channel.id
          const isBound = settings?.[channel.boundKey] === true
          const isSaving = savingChannel === channel.id
          return (
            <article className={`copis-working-message-channel ${isSelected ? 'selected' : ''}`} key={channel.id}>
              <div className="copis-working-message-channel-icon" aria-hidden="true">
                <img src={channel.icon} alt={`${channel.name} 图标`} className="copis-working-message-channel-logo" />
              </div>
              <div className="copis-working-message-channel-copy">
                <div className="copis-working-message-channel-title">
                  <strong>{channel.name}</strong>
                  <span className={`copis-working-message-binding ${isBound ? 'bound' : 'unbound'}`}>
                    {isBound ? '已绑定' : '未绑定'}
                  </span>
                </div>
                <p>{channel.description}</p>
              </div>
              <div className="copis-working-message-channel-actions">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="copis-working-message-channel-rebind-btn"
                  onClick={() => handleOpenRebind(channel.id)}
                  title={`${isBound ? '重新绑定' : '立即绑定'}${channel.name}`}
                >
                  <RefreshCw className="mr-1.5 size-3" />
                  {isBound ? '重新绑定' : '立即绑定'}
                </Button>
                <Button
                  type="button"
                  variant={isSelected ? 'secondary' : 'default'}
                  size="sm"
                  className={cn(
                    'copis-working-message-channel-action',
                    isSelected && 'selected'
                  )}
                  onClick={() => void handleSelectChannel(channel.id)}
                  disabled={!settings || isSelected || isSaving}
                  aria-pressed={isSelected}
                >
                  {isSaving ? (
                    <>
                      <Loader2 className="mr-1.5 size-3 animate-spin" />
                      保存中...
                    </>
                  ) : isSelected ? (
                    '当前渠道'
                  ) : (
                    '设为接收渠道'
                  )}
                </Button>
              </div>
            </article>
          )
        })}

        {/* Agent 原生邮箱 (QQ 邮箱) */}
        <article className="copis-working-message-channel">
          <div className="copis-working-message-channel-icon" aria-hidden="true">
            <Mail className="size-5 text-[var(--ui-primary)]" />
          </div>
          <div className="copis-working-message-channel-copy">
            <div className="copis-working-message-channel-title">
              <strong>Agent 邮箱 (QQ 邮箱)</strong>
              <span className={`copis-working-message-binding ${agentMailStatus?.loggedIn ? 'bound' : 'unbound'}`}>
                {agentMailStatus?.loggedIn ? `已绑定${agentMailStatus.email ? ` (${agentMailStatus.email})` : ''}` : '未绑定'}
              </span>
            </div>
            <p>通过 Agent 原生邮箱 (@agent.qq.com) 授权收发与管理邮件。</p>
          </div>
          <div className="copis-working-message-channel-actions">
            {agentMailStatus?.loggedIn && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="copis-working-message-channel-rebind-btn text-red-400 hover:text-red-300"
                onClick={() => void handleLogoutAgentMail()}
                disabled={loggingOutMail}
              >
                {loggingOutMail ? <Loader2 className="mr-1.5 size-3 animate-spin" /> : null}
                退出登录
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="copis-working-message-channel-rebind-btn"
              onClick={() => handleOpenRebind('agent-mail')}
              title={agentMailStatus?.loggedIn ? '重新授权 Agent 邮箱' : '立即连接 Agent 邮箱'}
            >
              <RefreshCw className="mr-1.5 size-3" />
              {agentMailStatus?.loggedIn ? '重新授权' : '立即连接'}
            </Button>
          </div>
        </article>
      </div>

      <p className="copis-working-message-note">未绑定渠道不能接收消息，请先在对应渠道完成绑定。</p>

      {/* 绑定对话框 */}
      <Dialog open={rebindChannel !== null} onOpenChange={(open) => { if (!open) setRebindChannel(null) }}>
        <DialogContent className="border-[#f0a15a]/20 bg-[#191a1b] text-[#f2f3f3] sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base font-medium text-[#f1f3f2]">
              {rebindChannel === 'agent-mail' ? (
                <>
                  <div className="flex size-5 items-center justify-center rounded bg-white/10">
                    <Mail className="size-3.5 text-[var(--ui-primary)]" />
                  </div>
                  <span>{agentMailStatus?.loggedIn ? '重新授权 Agent 邮箱' : '连接 Agent QQ 邮箱'}</span>
                </>
              ) : (
                <>
                  {activeRebindOption && (
                    <img src={activeRebindOption.icon} alt="" className="size-5 rounded object-contain" />
                  )}
                  {activeRebindOption
                    ? `${settings?.[activeRebindOption.boundKey] ? '重新绑定' : '绑定'}${activeRebindOption.name}消息渠道`
                    : '渠道绑定'}
                </>
              )}
            </DialogTitle>
            <DialogDescription className="text-xs text-[#9fa3a6]">
              {rebindChannel === 'agent-mail'
                ? '使用手机微信/QQ扫码或在浏览器中完成 OAuth 授权，绑定 Agent 原生邮箱 (@agent.qq.com)。'
                : rebindChannel === 'feishu'
                ? '使用手机飞书「扫一扫」扫描下方二维码，即可完成授权绑定。'
                : rebindChannel === 'dingtalk' && dingtalkMode === 'manual'
                ? '配置钉钉企业内部机器人 Client ID 与 Client Secret，启用 Stream 模式连接。'
                : rebindChannel === 'dingtalk'
                ? '使用手机钉钉「扫一扫」扫描下方二维码，即可一键完成授权绑定。'
                : '使用手机微信「扫一扫」扫描下方二维码，即可完成关注与授权绑定。'}
            </DialogDescription>
          </DialogHeader>

          {rebindChannel === 'agent-mail' ? (
            <div className="space-y-4 py-1">
              <div className="flex flex-col items-center justify-center rounded-xl border border-white/10 bg-[#121314] p-5 text-center shadow-inner">
                {/* 二维码容器 */}
                <div className="relative flex size-44 items-center justify-center rounded-lg border border-slate-200/90 bg-white p-2 shadow-md">
                  {qrCodeDataUrl ? (
                    <img
                      src={qrCodeDataUrl}
                      alt="Agent 邮箱授权二维码"
                      className="size-full rounded object-contain"
                    />
                  ) : (
                    <div className="flex flex-col items-center justify-center gap-2 text-slate-500">
                      <Loader2 className="size-6 animate-spin text-[var(--ui-primary)]" />
                      <span className="text-[11px]">正在生成授权二维码...</span>
                    </div>
                  )}
                  {qrCodeDataUrl && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <div className="flex size-8 items-center justify-center rounded-md border border-slate-200 bg-white p-0.5 shadow">
                        <Mail className="size-5 text-[var(--ui-primary)]" />
                      </div>
                    </div>
                  )}
                </div>

                {/* 状态指示 */}
                <div className="mt-3 flex items-center gap-1.5 text-xs text-[#9fa3a6]">
                  <Loader2 className="size-3.5 animate-spin text-[var(--ui-primary)]" />
                  <span>等待微信/QQ扫码或浏览器授权中...</span>
                  <button
                    type="button"
                    onClick={() => setQrSeed(Date.now())}
                    className="ml-1 text-[11px] text-[var(--ui-primary)] hover:underline"
                    title="刷新二维码"
                  >
                    刷新
                  </button>
                </div>

                {/* 浏览器直达按钮 */}
                {agentMailAuthUrl && (
                  <div className="mt-3 w-full">
                    <Button
                      type="button"
                      size="sm"
                      className="w-full bg-[var(--ui-primary)] text-black hover:opacity-90 text-xs font-medium"
                      onClick={() => window.electronAPI.openExternal?.(agentMailAuthUrl)}
                    >
                      <ExternalLink className="mr-1.5 size-3.5" />
                      在浏览器中打开授权页面
                    </Button>
                  </div>
                )}

                {/* 步骤说明 */}
                <div className="mt-3 w-full rounded-lg border border-white/5 bg-white/[0.02] p-3 text-left">
                  <div className="flex items-center gap-1 text-[11px] font-medium text-[#dfe4e1]">
                    <Smartphone className="size-3.5 text-[var(--ui-primary)]" />
                    <span>操作步骤：</span>
                  </div>
                  <ol className="mt-1.5 list-decimal list-inside space-y-1 text-[11px] leading-relaxed text-[#9fa3a6]">
                    <li>使用<strong>微信</strong>或<strong>QQ</strong>「扫一扫」扫描二维码，或点击上方按钮在浏览器中完成授权</li>
                    <li>在腾讯 QQ 邮箱授权页中点击<strong>「同意授权」</strong></li>
                    <li>授权成功后系统将<strong>自动识别并完成绑定</strong></li>
                  </ol>
                </div>
              </div>

              {feedback && (
                <div
                  className={`flex items-start gap-2 rounded-md p-2.5 text-xs ${
                    feedback.type === 'success'
                      ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
                      : 'bg-red-500/10 text-red-300 border border-red-500/20'
                  }`}
                  role="status"
                >
                  {feedback.type === 'success' ? (
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-400 mt-0.5" />
                  ) : (
                    <AlertCircle className="size-4 shrink-0 text-red-400 mt-0.5" />
                  )}
                  <span>{feedback.message}</span>
                </div>
              )}
            </div>
          ) : rebindChannel === 'dingtalk' && dingtalkMode === 'manual' ? (
            <div className="space-y-4 py-1">
              <div className="rounded-xl border border-white/10 bg-[#121314] p-4 text-left shadow-inner space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-[#dfe4e1]">机器人名称</Label>
                  <Input
                    value={dingtalkBotName}
                    onChange={(e) => setDingtalkBotName(e.target.value)}
                    placeholder="例如：钉钉助手"
                    className="h-8 border-white/10 bg-white/5 text-xs text-[#f1f3f2]"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-[#dfe4e1]">Client ID (AppKey)</Label>
                  <Input
                    value={dingtalkClientId}
                    onChange={(e) => setDingtalkClientId(e.target.value)}
                    placeholder="例如：dingxxxxxxxxxxxxxxxx"
                    className="h-8 border-white/10 bg-white/5 text-xs text-[#f1f3f2]"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-[#dfe4e1]">Client Secret (AppSecret)</Label>
                  <Input
                    type="password"
                    value={dingtalkClientSecret}
                    onChange={(e) => setDingtalkClientSecret(e.target.value)}
                    placeholder="输入钉钉应用 Client Secret"
                    className="h-8 border-white/10 bg-white/5 text-xs text-[#f1f3f2]"
                  />
                </div>

                {/* 配置指引 */}
                <div className="mt-2 rounded-lg border border-white/5 bg-white/[0.02] p-3 text-left">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1 text-[11px] font-medium text-[#dfe4e1]">
                      <span>📌 钉钉自建机器人配置步骤：</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => window.electronAPI.openExternal?.('https://open.dingtalk.com')}
                      className="flex items-center gap-1 text-[11px] text-[var(--ui-primary)] hover:underline"
                    >
                      <span>打开钉钉开放平台</span>
                      <ExternalLink className="size-3" />
                    </button>
                  </div>
                  <ol className="mt-1.5 list-decimal list-inside space-y-1 text-[11px] leading-relaxed text-[#9fa3a6]">
                    <li>登录<strong>钉钉开放平台</strong> (open.dingtalk.com)，创建<strong>企业内部应用</strong>并添加机器人</li>
                    <li>在机器人配置中开启机器人，消息接收模式选择 <strong>Stream 模式</strong>并发布</li>
                    <li>复制 <strong>Client ID (AppKey)</strong> 与 <strong>Client Secret</strong> 填入上方</li>
                  </ol>
                </div>
              </div>

              {feedback && (
                <div
                  className={`flex items-start gap-2 rounded-md p-2.5 text-xs ${
                    feedback.type === 'success'
                      ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
                      : 'bg-red-500/10 text-red-300 border border-red-500/20'
                  }`}
                  role="status"
                >
                  {feedback.type === 'success' ? (
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-400 mt-0.5" />
                  ) : (
                    <AlertCircle className="size-4 shrink-0 text-red-400 mt-0.5" />
                  )}
                  <span>{feedback.message}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4 py-1">
              <div className="flex flex-col items-center justify-center rounded-xl border border-white/10 bg-[#121314] p-5 text-center shadow-inner">
                {rebindChannel === 'dingtalk' && !dingtalkClientId.trim() ? (
                  <div className="flex flex-col items-center justify-center gap-2 py-4 text-center">
                    <AlertCircle className="size-8 text-amber-400" />
                    <span className="text-sm font-medium text-[#f1f3f2]">未配置钉钉企业应用 Client ID</span>
                    <p className="text-xs text-[#9fa3a6] max-w-xs leading-relaxed">
                      钉钉扫码授权需指定您企业的有效 AppKey，请先在凭证设置中填入 Client ID 与 Client Secret。
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      className="mt-2 bg-[var(--ui-primary)] text-black hover:opacity-90 text-xs"
                      onClick={() => setDingtalkMode('manual')}
                    >
                      前往配置凭证
                    </Button>
                  </div>
                ) : (
                  <>
                    {/* 二维码容器 */}
                    <div className="relative flex size-44 items-center justify-center rounded-lg border border-slate-200/90 bg-white p-2 shadow-md">
                      {qrCodeDataUrl ? (
                        <img
                          src={qrCodeDataUrl}
                          alt={`${activeRebindOption?.name || ''} 授权绑定二维码`}
                          className="size-full rounded object-contain"
                        />
                      ) : (
                        <div className="flex flex-col items-center justify-center gap-2 text-slate-500">
                          <Loader2 className="size-6 animate-spin text-[var(--ui-primary)]" />
                          <span className="text-[11px]">
                            {rebindChannel === 'feishu'
                              ? '正在生成飞书官方二维码...'
                              : rebindChannel === 'dingtalk'
                              ? '正在生成钉钉授权二维码...'
                              : '正在获取微信机器人二维码...'}
                          </span>
                        </div>
                      )}
                      {/* 居中 Logo 徽标 */}
                      {qrCodeDataUrl && activeRebindOption && (
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                          <div className="flex size-8 items-center justify-center rounded-md border border-slate-200 bg-white p-0.5 shadow">
                            <img src={activeRebindOption.icon} alt="" className="size-full rounded object-contain" />
                          </div>
                        </div>
                      )}
                    </div>

                    {/* 实时扫码状态指示器 */}
                    <div className="mt-3 flex items-center gap-1.5 text-xs text-[#9fa3a6]">
                      <Loader2 className="size-3.5 animate-spin text-[var(--ui-primary)]" />
                      <span>
                        等待手机
                        {rebindChannel === 'feishu'
                          ? '飞书'
                          : rebindChannel === 'dingtalk'
                          ? '钉钉'
                          : '微信'}
                        扫码授权中...
                      </span>
                      <button
                        type="button"
                        onClick={() => setQrSeed(Date.now())}
                        className="ml-1 text-[11px] text-[var(--ui-primary)] hover:underline"
                        title="刷新二维码"
                      >
                        刷新
                      </button>
                    </div>

                    {/* 步骤说明 */}
                    <div className="mt-3 w-full rounded-lg border border-white/5 bg-white/[0.02] p-3 text-left">
                      <div className="flex items-center gap-1 text-[11px] font-medium text-[#dfe4e1]">
                        <Smartphone className="size-3.5 text-[var(--ui-primary)]" />
                        <span>扫码操作步骤：</span>
                      </div>
                      <ol className="mt-1.5 list-decimal list-inside space-y-1 text-[11px] leading-relaxed text-[#9fa3a6]">
                        <li>
                          打开手机
                          <strong>
                            {rebindChannel === 'feishu'
                              ? '飞书'
                              : rebindChannel === 'dingtalk'
                              ? '钉钉'
                              : '微信'}{' '}
                            App
                          </strong>
                          ，点击右上角<strong>「扫一扫」</strong>
                        </li>
                        <li>扫描上方二维码，在手机端点击<strong>「确认授权绑定」</strong></li>
                        <li>授权完成后系统将<strong>自动识别并完成绑定</strong></li>
                      </ol>
                    </div>
                  </>
                )}
              </div>

              {feedback && (
                <div
                  className={`flex items-start gap-2 rounded-md p-2.5 text-xs ${
                    feedback.type === 'success'
                      ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
                      : 'bg-red-500/10 text-red-300 border border-red-500/20'
                  }`}
                  role="status"
                >
                  {feedback.type === 'success' ? (
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-400 mt-0.5" />
                  ) : (
                    <AlertCircle className="size-4 shrink-0 text-red-400 mt-0.5" />
                  )}
                  <span>{feedback.message}</span>
                </div>
              )}
            </div>
          )}

          <DialogFooter className="flex-row items-center justify-between sm:justify-between">
            {rebindChannel === 'dingtalk' && dingtalkMode === 'manual' ? (
              <>
                {dingtalkClientId.trim() ? (
                  <button
                    type="button"
                    onClick={() => { setDingtalkMode('qrcode'); setFeedback(null) }}
                    className="text-[11px] text-[var(--ui-primary)] hover:underline"
                  >
                    查看扫码授权二维码 →
                  </button>
                ) : (
                  <span className="text-[11px] text-[#858b8e]">
                    支持钉钉 Stream 模式直连
                  </span>
                )}
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="border-white/15 bg-transparent text-[#dfe4e1] hover:bg-white/5"
                    onClick={() => setRebindChannel(null)}
                    disabled={testingDingtalk}
                  >
                    取消
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="bg-[var(--ui-primary)] text-black hover:opacity-90 font-medium"
                    onClick={() => void handleSaveDingTalk()}
                    disabled={testingDingtalk}
                  >
                    {testingDingtalk ? (
                      <>
                        <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                        测试连接中...
                      </>
                    ) : (
                      '测试并完成绑定'
                    )}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-[#858b8e]">
                    自动识别中，也可手动核验
                  </span>
                  {rebindChannel === 'dingtalk' && (
                    <button
                      type="button"
                      onClick={() => { setDingtalkMode('manual'); setFeedback(null) }}
                      className="text-[11px] text-[var(--ui-primary)] hover:underline ml-1"
                    >
                      自建机器人凭证配置
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="border-white/15 bg-transparent text-[#dfe4e1] hover:bg-white/5"
                    onClick={() => setRebindChannel(null)}
                    disabled={checkingBinding}
                  >
                    取消
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="bg-[var(--ui-primary)] text-black hover:opacity-90 font-medium"
                    onClick={() => void handleManualCheck()}
                    disabled={checkingBinding}
                  >
                    {checkingBinding ? (
                      <>
                        <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                        核验中...
                      </>
                    ) : rebindChannel === 'agent-mail' ? (
                      '核验授权'
                    ) : (
                      '我已在手机确认'
                    )}
                  </Button>
                </div>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
