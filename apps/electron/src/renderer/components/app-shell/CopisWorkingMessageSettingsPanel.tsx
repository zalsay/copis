import * as React from 'react'
import type { WorkingReceiveChannel, WorkingReceiveChannelSettings } from '@copis/shared'
import './CopisWorkingMessageSettingsPanel.css'

interface MessageChannelOption {
  id: WorkingReceiveChannel
  name: string
  description: string
  boundKey: 'weixinBound' | 'feishuBound'
}

const messageChannels: readonly MessageChannelOption[] = [
  {
    id: 'weixin',
    name: '微信',
    description: '接收 Working 工作消息和任务提醒。',
    boundKey: 'weixinBound',
  },
  {
    id: 'feishu',
    name: '飞书',
    description: '通过飞书机器人接收 Working 工作消息。',
    boundKey: 'feishuBound',
  },
] as const

interface CopisWorkingMessageSettingsPanelProps {
  settings: WorkingReceiveChannelSettings | null
  onSettingsChange: (settings: WorkingReceiveChannelSettings) => void
}

export function CopisWorkingMessageSettingsPanel({
  settings,
  onSettingsChange,
}: CopisWorkingMessageSettingsPanelProps): React.ReactElement {
  const [savingChannel, setSavingChannel] = React.useState<WorkingReceiveChannel | null>(null)
  const [error, setError] = React.useState('')

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

  return (
    <section className="copis-working-message-settings" aria-label="工作消息接收方式">
      <header className="copis-working-message-header">
        <div>
          <h2>工作消息接收方式</h2>
          <p>选择 Working 工作消息的接收渠道，变更会同步到当前 Working 账户。</p>
        </div>
        <span className="copis-working-message-sync-state">{settings ? '已同步' : '加载中...'}</span>
      </header>

      {error && <div className="copis-working-message-error" role="alert">{error}</div>}

      <div className="copis-working-message-channel-list">
        {messageChannels.map((channel) => {
          const isSelected = settings?.channel === channel.id
          const isBound = settings?.[channel.boundKey] === true
          const isSaving = savingChannel === channel.id
          return (
            <article className={`copis-working-message-channel ${isSelected ? 'selected' : ''}`} key={channel.id}>
              <div className="copis-working-message-channel-icon" aria-hidden="true">{channel.name.slice(0, 1)}</div>
              <div className="copis-working-message-channel-copy">
                <div className="copis-working-message-channel-title">
                  <strong>{channel.name}</strong>
                  <span className={`copis-working-message-binding ${isBound ? 'bound' : 'unbound'}`}>
                    {isBound ? '已绑定' : '未绑定'}
                  </span>
                </div>
                <p>{channel.description}</p>
              </div>
              <button
                type="button"
                className="copis-working-message-channel-action"
                onClick={() => void handleSelectChannel(channel.id)}
                disabled={!settings || isSelected || savingChannel !== null}
                aria-pressed={isSelected}
              >
                {isSaving ? '保存中...' : isSelected ? '当前渠道' : '设为接收渠道'}
              </button>
            </article>
          )
        })}
      </div>

      <p className="copis-working-message-note">未绑定渠道不能接收消息，请先在对应渠道完成绑定。</p>
    </section>
  )
}
