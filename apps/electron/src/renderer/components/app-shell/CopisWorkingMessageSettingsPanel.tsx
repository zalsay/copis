import * as React from 'react'
import { useAtomValue } from 'jotai'
import { cn } from '@/lib/utils'
import { feishuBotStatesAtom } from '@/atoms/feishu-atoms'
import { dingtalkBotStatesAtom } from '@/atoms/dingtalk-atoms'
import { wechatBridgeStateAtom } from '@/atoms/wechat-atoms'
import { FeishuSettings } from '@/components/settings/FeishuSettings'
import { DingTalkSettings } from '@/components/settings/DingTalkSettings'
import { WeChatSettings } from '@/components/settings/WeChatSettings'
import feishuLogo from '@/assets/bots/feishu.png'
import dingtalkLogo from '@/assets/bots/dingding.png'
import wechatLogo from '@/assets/bots/wechat.png'
import './CopisWorkingMessageSettingsPanel.css'

type MessagePlatformId = 'feishu' | 'wechat' | 'dingtalk'

interface MessagePlatform {
  id: MessagePlatformId
  name: string
  iconSrc: string
}

const platforms: readonly MessagePlatform[] = [
  { id: 'feishu', name: '飞书', iconSrc: feishuLogo },
  { id: 'wechat', name: '微信', iconSrc: wechatLogo },
  { id: 'dingtalk', name: '钉钉', iconSrc: dingtalkLogo },
]

export function CopisWorkingMessageSettingsPanel(): React.ReactElement {
  const [selectedPlatform, setSelectedPlatform] = React.useState<MessagePlatformId>('feishu')
  const feishuBotStates = useAtomValue(feishuBotStatesAtom)
  const dingtalkBotStates = useAtomValue(dingtalkBotStatesAtom)
  const wechatState = useAtomValue(wechatBridgeStateAtom)

  return (
    <div className="copis-working-message-settings">
      <aside className="copis-working-message-platforms" aria-label="消息平台设置">
        {platforms.map((platform) => {
          const selected = selectedPlatform === platform.id
          return (
            <button
              type="button"
              key={platform.id}
              className={cn('copis-working-message-platform', selected && 'active')}
              onClick={() => setSelectedPlatform(platform.id)}
            >
              <img src={platform.iconSrc} alt="" aria-hidden="true" />
              <span>{platform.name}</span>
              <span className={cn('copis-working-message-status-dot', getPlatformStatus(platform.id, feishuBotStates, dingtalkBotStates, wechatState.status))} aria-label={getPlatformStatusLabel(platform.id, feishuBotStates, dingtalkBotStates, wechatState.status)} />
            </button>
          )
        })}
      </aside>

      <div className="copis-working-message-content">
        {selectedPlatform === 'feishu' && <FeishuSettings />}
        {selectedPlatform === 'wechat' && <WeChatSettings />}
        {selectedPlatform === 'dingtalk' && <DingTalkSettings />}
      </div>
    </div>
  )
}

function getPlatformStatus(
  platform: MessagePlatformId,
  feishuBotStates: Record<string, { status: string }>,
  dingtalkBotStates: Record<string, { status: string }>,
  wechatStatus: string,
): 'connected' | 'connecting' | 'error' | 'disconnected' {
  if (platform === 'wechat') return normalizeStatus(wechatStatus)
  const states = Object.values(platform === 'feishu' ? feishuBotStates : dingtalkBotStates)
  if (states.some((state) => state.status === 'connected')) return 'connected'
  if (states.some((state) => state.status === 'error')) return 'error'
  if (states.some((state) => state.status === 'connecting')) return 'connecting'
  return 'disconnected'
}

function normalizeStatus(value: string): 'connected' | 'connecting' | 'error' | 'disconnected' {
  if (value === 'connected') return 'connected'
  if (value === 'connecting' || value === 'waiting_scan' || value === 'scanned') return 'connecting'
  if (value === 'error') return 'error'
  return 'disconnected'
}

function getPlatformStatusLabel(
  platform: MessagePlatformId,
  feishuBotStates: Record<string, { status: string }>,
  dingtalkBotStates: Record<string, { status: string }>,
  wechatStatus: string,
): string {
  const status = getPlatformStatus(platform, feishuBotStates, dingtalkBotStates, wechatStatus)
  if (status === 'connected') return '已连接'
  if (status === 'connecting') return '连接中'
  if (status === 'error') return '连接错误'
  return '未连接'
}
