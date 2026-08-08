/**
 * VoiceInputSettings — 语音输入设置
 */

import * as React from 'react'
import { CircleCheck, Globe, Loader2, Mic, MicOff, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  SettingsCard,
  SettingsSection,
  SettingsSelect,
  SettingsToggle,
} from './primitives'
import type { VoiceDictationSettings, MicPermissionResult } from '../../../types'
import './VoiceInputSettings.css'

const OUTPUT_OPTIONS = [
  { value: 'auto', label: '自动：Copis 激活时写入对话框，否则写入当前光标' },
  { value: 'clipboard', label: '仅复制到剪贴板' },
  { value: 'copis-input', label: '仅写入 Copis 输入框' },
]

const LANGUAGE_OPTIONS = [
  { value: 'auto', label: '自动识别' },
  { value: 'zh-CN', label: '中文普通话' },
  { value: 'en-US', label: '英语' },
  { value: 'yue-CN', label: '粤语' },
  { value: 'ja-JP', label: '日语' },
  { value: 'ko-KR', label: '韩语' },
]

export function VoiceInputSettings(): React.ReactElement {
  const [settings, setSettings] = React.useState<VoiceDictationSettings | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [micPermission, setMicPermission] = React.useState<MicPermissionResult | null>(null)
  const [requestingPermission, setRequestingPermission] = React.useState(false)

  const refreshMicPermission = React.useCallback(async () => {
    try {
      const result = await window.electronAPI.checkMicrophonePermission()
      setMicPermission(result)
    } catch (error) {
      console.error('[语音输入] 检查麦克风权限失败:', error)
    }
  }, [])

  React.useEffect(() => {
    window.electronAPI.getVoiceDictationSettings()
      .then(setSettings)
      .catch((error) => {
        console.error('[语音输入] 加载设置失败:', error)
        toast.error('加载语音输入设置失败')
      })
    refreshMicPermission()
  }, [refreshMicPermission])

  const handleRequestMicPermission = React.useCallback(async () => {
    setRequestingPermission(true)
    try {
      const result = await window.electronAPI.requestMicrophonePermission()
      setMicPermission(result)
      if (result.status === 'granted') {
        toast.success('麦克风权限已授权')
      } else if (result.status === 'denied') {
        toast.error('麦克风权限已被拒绝，请在系统设置中允许')
      }
    } catch (error) {
      console.error('[语音输入] 请求麦克风权限失败:', error)
      toast.error('请求麦克风权限失败')
    } finally {
      setRequestingPermission(false)
    }
  }, [])

  const update = React.useCallback(async (updates: Partial<VoiceDictationSettings>) => {
    if (!settings) return
    const optimistic = { ...settings, ...updates }
    setSettings(optimistic)
    setSaving(true)
    try {
      const saved = await window.electronAPI.updateVoiceDictationSettings(optimistic)
      setSettings(saved)
      window.electronAPI.reregisterGlobalShortcuts().catch(console.error)
    } catch (error) {
      console.error('[语音输入] 保存设置失败:', error)
      toast.error('保存语音输入设置失败')
    } finally {
      setSaving(false)
    }
  }, [settings])

  if (!settings) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        正在加载语音输入设置...
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <SettingsSection
        title="语音输入"
        description="管理麦克风权限、语音服务和全局语音输入行为。"
      >
        <SettingsCard>
          <SettingsToggle
            label="启用语音输入"
            description="启用后可使用 Ctrl+～ 打开语音输入浮窗，再按一次停止。"
            checked={settings.enabled}
            onCheckedChange={(enabled) => update({ enabled })}
          />
        </SettingsCard>

        {/* 麦克风权限状态 */}
        {micPermission && (
          <div className="rounded-lg border px-4 py-3 text-sm">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {micPermission.status === 'granted' ? (
                  <Mic className="size-4 text-green-500" />
                ) : micPermission.status === 'denied' ? (
                  <MicOff className="size-4 text-destructive" />
                ) : micPermission.status === 'not-determined' ? (
                  <Mic className="size-4 text-amber-500" />
                ) : (
                  <Mic className="size-4 text-muted-foreground" />
                )}
                <div>
                  <span className="font-medium text-foreground">麦克风权限</span>
                  <span className="ml-2 text-muted-foreground">
                    {micPermission.status === 'granted'
                      ? '已授权，语音输入可正常使用'
                      : micPermission.status === 'denied'
                      ? '已被系统阻止，请在系统设置中允许 Copis 访问麦克风'
                      : micPermission.status === 'not-determined'
                      ? '未授权，使用语音输入前需要先授权'
                      : '当前系统不支持预检，录音时将自动弹出权限请求'}
                  </span>
                </div>
              </div>
              {(micPermission.status === 'not-determined' || micPermission.status === 'denied') && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRequestMicPermission}
                  disabled={requestingPermission}
                >
                  {requestingPermission ? (
                    <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  ) : micPermission.status === 'not-determined' ? (
                    <Mic className="mr-1.5 size-3.5" />
                  ) : (
                    <MicOff className="mr-1.5 size-3.5" />
                  )}
                  {micPermission.status === 'not-determined' ? '允许麦克风权限' : '重新请求权限'}
                </Button>
              )}
            </div>
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title="识别模式"
        description="选择语音转写使用的识别服务。"
      >
        <div className="copis-voice-mode-grid">
          <button
            type="button"
            className={settings.provider === 'http-api' ? 'copis-voice-mode-card is-selected' : 'copis-voice-mode-card'}
            onClick={() => update({ provider: 'http-api' })}
            disabled={saving}
            aria-pressed={settings.provider === 'http-api'}
          >
            <span className="copis-voice-mode-card-heading">
              <span className="copis-voice-mode-card-icon">
                <Globe aria-hidden="true" />
              </span>
              {settings.provider === 'http-api' && <CircleCheck className="copis-voice-mode-card-check" aria-hidden="true" />}
            </span>
            <strong className="copis-voice-mode-card-title">使用免费语音识别</strong>
            <span className="copis-voice-mode-card-description">
              使用浏览器自带的语音识别，免费使用、无需配置任何凭证；适合日常听写。
            </span>
            <span className="copis-voice-mode-card-badge">免费</span>
          </button>

          <button
            type="button"
            className={settings.provider === 'copis-model' ? 'copis-voice-mode-card is-selected' : 'copis-voice-mode-card'}
            onClick={() => update({ provider: 'copis-model' })}
            disabled={saving}
            aria-pressed={settings.provider === 'copis-model'}
          >
            <span className="copis-voice-mode-card-heading">
              <span className="copis-voice-mode-card-icon copis-voice-mode-card-icon-copis">
                <Sparkles aria-hidden="true" />
              </span>
              {settings.provider === 'copis-model' && <CircleCheck className="copis-voice-mode-card-check" aria-hidden="true" />}
            </span>
            <strong className="copis-voice-mode-card-title">使用 Copis 语音识别大模型</strong>
            <span className="copis-voice-mode-card-description">
              由 Copis 语音识别大模型提供更精准的转写，识别时从账户余额扣除钻石。
            </span>
            <span className="copis-voice-mode-card-badge copis-voice-mode-card-badge-copis">消耗钻石</span>
          </button>
        </div>
      </SettingsSection>

      {settings.provider === 'copis-model' ? (
        <SettingsSection
          title="Copis 语音识别大模型"
          description="无需配置外部凭证，识别费用从 Copis 账户钻石余额扣除。"
        >
          <div className="rounded-lg bg-muted/55 px-4 py-3 text-sm text-muted-foreground shadow-sm">
            <div className="mb-1.5 font-medium text-foreground">使用说明</div>
            <div className="space-y-1 leading-relaxed">
              <p>启用后使用全局快捷键唤起浮窗，语音转写由 Copis 语音识别大模型完成，识别结果写入 Copis 输入框或当前光标位置。</p>
              <p>每次识别会消耗钻石，余额不足时无法继续使用，请在 Copis 账户中充值。</p>
              <p>该能力尚未接入，当前选择后启动语音输入会提示不可用，请先切换到“使用免费语音识别”。</p>
            </div>
          </div>
        </SettingsSection>
      ) : (
        <SettingsSection
          title="免费语音识别"
          description="由浏览器自带的语音识别能力提供，无需任何凭证或配置。"
        >
          <div className="rounded-lg bg-muted/55 px-4 py-3 text-sm text-muted-foreground shadow-sm">
            <div className="mb-1.5 font-medium text-foreground">使用说明</div>
            <div className="space-y-1 leading-relaxed">
              <p>选择后使用浏览器自带的语音识别能力进行听写，免费使用，无需配置任何凭证。</p>
              <p>首次使用前需要允许麦克风权限；识别过程需要浏览器语音服务可达。</p>
            </div>
          </div>

          <SettingsCard>
            <SettingsSelect
              label="识别语言"
              description="选择语音识别使用的语言，自动识别适合中英文混合输入。"
              value={settings.language || 'auto'}
              onValueChange={(language) => update({ language: language === 'auto' ? '' : language })}
              options={LANGUAGE_OPTIONS}
            />
            <SettingsSelect
              label="输出方式"
              description="默认写入当前光标位置；如果唤起时 Copis 是当前激活窗口，会写入当前 Agent 输入框。自动粘贴失败时会保留到剪贴板。"
              value={settings.outputMode}
              onValueChange={(outputMode) => update({ outputMode: outputMode as VoiceDictationSettings['outputMode'] })}
              options={OUTPUT_OPTIONS}
            />
          </SettingsCard>
        </SettingsSection>
      )}

      {saving && (
        <p className="text-xs text-muted-foreground">正在保存语音输入设置...</p>
      )}
    </div>
  )
}
