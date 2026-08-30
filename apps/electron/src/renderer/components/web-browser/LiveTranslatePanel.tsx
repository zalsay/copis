import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import {
  Activity,
  Calendar,
  CheckCircle2,
  Copy,
  Download,
  FileAudio,
  Languages,
  Mic,
  MicOff,
  Radio,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  User,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  liveTranslateActiveAtom,
  liveTranslateApiKeyAtom,
  liveTranslateServerApiKeyAtom,
  liveTranslateBilingualAtom,
  liveTranslateCurrentSubtitleAtom,
  liveTranslateFloatingBannerAtom,
  liveTranslateHistoryAtom,
  liveTranslateModelAtom,
  liveTranslateServerUrlAtom,
  liveTranslateStatusTextAtom,
  liveTranslateTargetLangAtom,
  liveTranslateVoicePlaybackAtom,
  type SubtitleItem,
} from '@/atoms/live-translate-atoms'
import {
  generateMeetingMinutes,
  translateAudioFile,
  LiveTranslateClient,
  type AudioTranslationResult,
} from '@/lib/live-translate-client'

interface LiveTranslatePanelProps {
  width?: number
  onClose: () => void
}

export function LiveTranslatePanel({ width = 420, onClose }: LiveTranslatePanelProps): React.ReactElement {
  const [isActive, setIsActive] = useAtom(liveTranslateActiveAtom)
  const [statusText, setStatusText] = useAtom(liveTranslateStatusTextAtom)
  const [apiKey, setApiKey] = useAtom(liveTranslateApiKeyAtom)
  const [serverApiKey, setServerApiKey] = useAtom(liveTranslateServerApiKeyAtom)
  const [serverUrl, setServerUrl] = useAtom(liveTranslateServerUrlAtom)
  const [model, setModel] = useAtom(liveTranslateModelAtom)
  const [targetLang, setTargetLang] = useAtom(liveTranslateTargetLangAtom)
  const [voicePlayback, setVoicePlayback] = useAtom(liveTranslateVoicePlaybackAtom)
  const [bilingual, setBilingual] = useAtom(liveTranslateBilingualAtom)
  const [floatingBanner, setFloatingBanner] = useAtom(liveTranslateFloatingBannerAtom)
  const [currentSubtitle, setCurrentSubtitle] = useAtom(liveTranslateCurrentSubtitleAtom)
  const [history, setHistory] = useAtom(liveTranslateHistoryAtom)

  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [notes, setNotes] = React.useState('')
  const [activeTab, setActiveTab] = React.useState<'subtitles' | 'minutes' | 'upload'>('subtitles')
  const [volume, setVolume] = React.useState(0)
  const [isGeneratingMinutes, setIsGeneratingMinutes] = React.useState(false)
  const [minutesResult, setMinutesResult] = React.useState<{
    title: string
    summary: string
    key_points: string[]
    action_items: Array<{ task: string; owner?: string; deadline?: string }>
  } | null>(null)
  const [minutesMarkdown, setMinutesMarkdown] = React.useState('')

  // Audio Upload States
  const [selectedAudioFile, setSelectedAudioFile] = React.useState<File | null>(null)
  const [audioPreviewUrl, setAudioPreviewUrl] = React.useState<string | null>(null)
  const [isTranslatingAudio, setIsTranslatingAudio] = React.useState(false)
  const [audioTranslationResult, setAudioTranslationResult] = React.useState<AudioTranslationResult | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)

  const clientRef = React.useRef<LiveTranslateClient | null>(null)
  const currentSubRef = React.useRef(currentSubtitle)
  currentSubRef.current = currentSubtitle

  const isTranscribeMode = model.includes('transcribe')

  const commitCurrentSubtitle = React.useCallback(() => {
    const cur = currentSubRef.current
    if (!cur.original.trim() && !cur.translated.trim()) return

    const newItem: SubtitleItem = {
      id: Math.random().toString(36).slice(2),
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      original: cur.original.trim(),
      translated: cur.translated.trim(),
    }

    setHistory((prev) => [...prev, newItem])
    setCurrentSubtitle({ original: '', translated: '', interim: '' })
  }, [setCurrentSubtitle, setHistory])

  const checkSentenceEnding = React.useCallback((text: string) => {
    const endings = ['。', '！', '？', '.', '?', '!', '\n']
    if (endings.some((end) => text.includes(end))) {
      setTimeout(() => commitCurrentSubtitle(), 600)
    }
  }, [commitCurrentSubtitle])

  const handleToggle = React.useCallback(async () => {
    if (isActive) {
      clientRef.current?.stop()
      clientRef.current = null
      setIsActive(false)
      setStatusText('已停止')
      commitCurrentSubtitle()
      return
    }

    const client = new LiveTranslateClient({
      serverUrl,
      serverApiKey: serverApiKey.trim() || undefined,
      apiKey: apiKey.trim() || undefined,
      model,
      targetLang,
      mode: isTranscribeMode ? 'transcribe' : 'translate',
      enableVoicePlayback: voicePlayback && !isTranscribeMode,
      onStatus: (status, isErr) => {
        setStatusText(status)
        if (isErr) toast.error(status)
      },
      onReady: () => {
        setIsActive(true)
        setStatusText('实时同传运行中')
        toast.success('Gemini Live 已就绪')
      },
      onTranscript: (text) => {
        setCurrentSubtitle((prev) => ({ ...prev, original: prev.original + text, interim: '' }))
        checkSentenceEnding(text)
      },
      onInterimTranscript: (text) => {
        setCurrentSubtitle((prev) => ({ ...prev, interim: text }))
      },
      onTranslation: (text) => {
        setCurrentSubtitle((prev) => ({ ...prev, translated: prev.translated + text }))
        checkSentenceEnding(text)
      },
      onTurnComplete: () => {
        commitCurrentSubtitle()
      },
      onError: (err) => {
        if (err.includes('suspended') || err.includes('Permission denied') || err.includes('CONSUMER_SUSPENDED')) {
          toast.error('Google Gemini API Key 已被官方封禁或暂停，请在设置抽屉中输入新的有效 API Key')
          setSettingsOpen(true)
        } else {
          toast.error(err)
        }
        setIsActive(false)
      },
      onVolumeChange: (vol) => {
        setVolume(vol)
      },
    })

    clientRef.current = client
    try {
      await client.start()
      setIsActive(true)
    } catch (err) {
      console.error('[LiveTranslate] 启动失败:', err)
      setIsActive(false)
    }
  }, [
    apiKey,
    serverApiKey,
    checkSentenceEnding,
    commitCurrentSubtitle,
    isActive,
    isTranscribeMode,
    model,
    serverUrl,
    setCurrentSubtitle,
    setIsActive,
    setStatusText,
    targetLang,
    voicePlayback,
  ])

  React.useEffect(() => {
    return () => {
      clientRef.current?.stop()
      clientRef.current = null
    }
  }, [])

  const handleClearHistory = () => {
    setHistory([])
    toast.info('逐字稿已清空')
  }

  const handleCopyTranscript = () => {
    const text = history.map((item) => {
      if (item.translated && item.original) {
        return `[${item.time}] 原文: ${item.original}\n[${item.time}] 译文: ${item.translated}`
      }
      return `[${item.time}] ${item.translated || item.original}`
    }).join('\n\n')

    if (!text) {
      toast.error('暂无逐字稿内容可复制')
      return
    }

    void navigator.clipboard.writeText(text).then(() => {
      toast.success('逐字稿已复制')
    })
  }

  const handleGenerateMinutes = async () => {
    const fullTranscript = history.map((item) => {
      if (item.translated && item.original) {
        return `[${item.time}] 原文: ${item.original}\n[${item.time}] 译文: ${item.translated}`
      }
      return `[${item.time}] ${item.translated || item.original}`
    }).join('\n')

    if (!fullTranscript.trim() && !notes.trim()) {
      toast.error('请先录制对话或输入会议笔记')
      return
    }

    setIsGeneratingMinutes(true)
    try {
      const res = await generateMeetingMinutes(serverUrl, apiKey, fullTranscript, notes, serverApiKey)
      setMinutesResult(res.minutes)
      setMinutesMarkdown(res.markdown)
      setActiveTab('minutes')
      toast.success('AI 智能会议纪要已生成')
    } catch (err) {
      const msg = err instanceof Error ? err.message : '生成失败'
      toast.error(msg)
    } finally {
      setIsGeneratingMinutes(false)
    }
  }

  const handleDownloadMinutes = () => {
    if (!minutesMarkdown) return
    const blob = new Blob([minutesMarkdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `meeting-minutes-${new Date().toISOString().slice(0, 10)}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files[0]) {
      const file = files[0]
      setSelectedAudioFile(file)
      const url = URL.createObjectURL(file)
      setAudioPreviewUrl(url)
    }
  }

  const handleTranslateUploadedAudio = async () => {
    if (!selectedAudioFile) {
      toast.error('请先选择音频文件')
      return
    }

    setIsTranslatingAudio(true)
    try {
      const res = await translateAudioFile(
        serverUrl,
        selectedAudioFile,
        targetLang,
        serverApiKey.trim() || undefined,
        apiKey.trim() || undefined,
        model.includes('flash') ? model : 'gemini-3.7-flash',
      )
      setAudioTranslationResult(res)
      toast.success('音频 AI 直译完成！')
    } catch (err) {
      const msg = err instanceof Error ? err.message : '音频直译失败'
      toast.error(msg)
    } finally {
      setIsTranslatingAudio(false)
    }
  }

  const handleImportAudioToHistory = () => {
    if (!audioTranslationResult) return
    const newItem: SubtitleItem = {
      id: Math.random().toString(36).slice(2),
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      original: audioTranslationResult.transcript,
      translated: audioTranslationResult.translation,
    }
    setHistory((prev) => [...prev, newItem])
    setActiveTab('subtitles')
    toast.success('已导入到实时逐字稿记录')
  }

  const handleDownloadAudioMarkdown = () => {
    if (!audioTranslationResult) return
    const d = audioTranslationResult
    const md = `# 音频文件 AI 翻译与摘要报告\n\n**识别源语言**：${d.source_language}\n**目标翻译语言**：${d.target_language}\n**处理时间**：${new Date().toLocaleString()}\n\n## 📋 核心要点摘要\n\n${d.summary}\n\n## 🌐 目标语言完整译文\n\n${d.translation}\n\n## 📝 完整原文逐字稿\n\n${d.transcript}\n\n## ⏱️ 逐句时间轴对照\n\n` +
      (d.segments || []).map((s, i) => `### ${i + 1}. [${s.timestamp || '分段'}]\n- **原文**：${s.original}\n- **译文**：${s.translated}\n`).join('\n')

    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `audio-translation-${new Date().toISOString().slice(0, 10)}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <aside
      style={{ width }}
      aria-label="Gemini Live 实时同传"
      className={cn(
        'z-30 flex h-full shrink-0 flex-col border-l bg-zinc-950/95 text-zinc-100 backdrop-blur-2xl transition-all duration-300',
        'border-white/[0.08] shadow-[0_0_50px_rgba(0,0,0,0.8)]',
      )}
    >
      {/* Panel Header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/[0.08] px-3.5 bg-zinc-900/40">
        <div className="flex items-center gap-2.5">
          {/* Icon Box with ui-primary-background and ui-primary */}
          <div
            className="flex size-7 items-center justify-center rounded-lg border shadow-xs"
            style={{
              backgroundColor: 'var(--ui-primary-background)',
              color: 'var(--ui-primary)',
              borderColor: 'color-mix(in srgb, var(--ui-primary) 30%, transparent)',
            }}
          >
            <Languages className="size-4" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-semibold tracking-tight text-white">Gemini Live</span>
              <span
                className="text-[10px] font-mono font-medium rounded px-1.5 py-0.2 border"
                style={{
                  backgroundColor: 'var(--ui-primary-background)',
                  color: 'var(--ui-primary)',
                  borderColor: 'color-mix(in srgb, var(--ui-primary) 25%, transparent)',
                }}
              >
                v3.5
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {/* Status Badge with ui-primary-background and ui-primary */}
          <div
            className="flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium border transition-colors"
            style={{
              backgroundColor: 'var(--ui-primary-background)',
              color: 'var(--ui-primary)',
              borderColor: 'color-mix(in srgb, var(--ui-primary) 35%, transparent)',
            }}
          >
            <span
              className={cn(
                'size-1.5 rounded-full',
                isActive ? 'animate-ping' : '',
              )}
              style={{ backgroundColor: 'var(--ui-primary)' }}
            />
            <span>{isActive ? '实时同传' : '空闲'}</span>
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn(
                  'size-7 rounded-md text-zinc-400 hover:text-white transition-colors',
                  settingsOpen && 'bg-white/[0.08] text-white',
                )}
                onClick={() => setSettingsOpen((prev) => !prev)}
              >
                <Settings2 className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">参数配置</TooltipContent>
          </Tooltip>

          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 rounded-md text-zinc-400 hover:bg-red-500/10 hover:text-red-400 transition-colors"
            onClick={onClose}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Settings Drawer */}
      {settingsOpen ? (
        <div className="border-b border-white/[0.08] bg-zinc-900/80 p-3.5 text-xs space-y-3 animate-in slide-in-from-top-2 duration-200">
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-zinc-400">服务网关地址</label>
            <Input
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="ws://us.siumt.xyz:8088/ws/live"
              className="h-8 text-xs bg-zinc-950 border-white/[0.1] focus-visible:ring-[var(--ui-primary)]"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-medium text-zinc-400">Gemini API Key</label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="留空自动读取服务端已存密钥"
              className="h-8 text-xs bg-zinc-950 border-white/[0.1] font-mono focus-visible:ring-[var(--ui-primary)]"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-medium text-zinc-400">服务端鉴权密钥 (x-api-key)</label>
            <Input
              type="password"
              value={serverApiKey}
              onChange={(e) => setServerApiKey(e.target.value)}
              placeholder="输入 32 位服务端鉴权密钥"
              className="h-8 text-xs bg-zinc-950 border-white/[0.1] font-mono focus-visible:ring-[var(--ui-primary)]"
            />
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-zinc-400">模型模式</label>
              <Select value={model} onValueChange={(val) => setModel(val)}>
                <SelectTrigger className="h-8 text-xs bg-zinc-950 border-white/[0.1]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-zinc-900 border-white/[0.1] text-zinc-200">
                  <SelectItem value="gemini-3.5-live-translate-preview">3.5 实时同传</SelectItem>
                  <SelectItem value="gemini-3.5-transcribe-live">3.5 纯逐字稿</SelectItem>
                  <SelectItem value="gemini-3.1-flash-live-preview">3.1 Flash Live 实时语音</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-zinc-400">目标语言</label>
              <Select value={targetLang} onValueChange={(val) => setTargetLang(val)} disabled={isTranscribeMode}>
                <SelectTrigger className="h-8 text-xs bg-zinc-950 border-white/[0.1]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-zinc-900 border-white/[0.1] text-zinc-200">
                  <SelectItem value="zh-CN">简体中文 (zh-CN)</SelectItem>
                  <SelectItem value="zh-TW">繁体中文 (zh-TW)</SelectItem>
                  <SelectItem value="en">English (en)</SelectItem>
                  <SelectItem value="ja">日本語 (ja)</SelectItem>
                  <SelectItem value="ko">한국어 (ko)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="pt-2 flex flex-col gap-2 border-t border-white/[0.08]">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-zinc-300">24kHz 译文音频实时播报</span>
              <Switch checked={voicePlayback} onCheckedChange={setVoicePlayback} disabled={isTranscribeMode} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-zinc-300">双语原文对照</span>
              <Switch checked={bilingual} onCheckedChange={setBilingual} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-zinc-300">网页底部悬浮字幕条</span>
              <Switch checked={floatingBanner} onCheckedChange={setFloatingBanner} />
            </div>
          </div>
        </div>
      ) : null}

      {/* Main Action Bar */}
      <div className="p-3.5 border-b border-white/[0.08] flex items-center gap-3 bg-zinc-900/30">
        <Button
          onClick={() => void handleToggle()}
          className={cn(
            'flex-1 h-10 font-semibold text-xs gap-2 rounded-xl transition-all duration-200 shadow-md active:scale-[0.98]',
          )}
          style={{
            backgroundColor: isActive ? '#ef4444' : 'var(--ui-primary)',
            color: isActive ? '#ffffff' : 'var(--ui-primary-foreground)',
          }}
        >
          {isActive ? (
            <>
              <MicOff className="size-4" />
              <span>停止实时同传</span>
            </>
          ) : (
            <>
              <Mic className="size-4" />
              <span>开启实时同传</span>
            </>
          )}
        </Button>

        {isActive ? (
          <div
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs"
            style={{
              backgroundColor: 'var(--ui-primary-background)',
              borderColor: 'color-mix(in srgb, var(--ui-primary) 30%, transparent)',
            }}
          >
            <Activity className="size-3.5 animate-pulse" style={{ color: 'var(--ui-primary)' }} />
            <div className="w-10 h-2 bg-zinc-950 rounded-full overflow-hidden p-0.5 border border-white/[0.05]">
              <div
                className="h-full rounded-full transition-all duration-75"
                style={{ width: `${volume}%`, backgroundColor: 'var(--ui-primary)' }}
              />
            </div>
          </div>
        ) : null}
      </div>

      {/* Live Active Subtitle Card */}
      <div className="p-3.5 border-b border-white/[0.08] bg-zinc-900/20">
        <div
          className="relative overflow-hidden rounded-xl border p-3.5 space-y-2 shadow-inner bg-zinc-900/60"
          style={{
            borderColor: 'color-mix(in srgb, var(--ui-primary) 30%, transparent)',
          }}
        >
          <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider">
            <div className="flex items-center gap-1.5" style={{ color: 'var(--ui-primary)' }}>
              <Radio className="size-3 animate-pulse" />
              <span>实时声学流</span>
            </div>
            <span className="text-zinc-400 font-normal lowercase">{statusText}</span>
          </div>

          {bilingual && currentSubtitle.original ? (
            <div className="text-xs text-zinc-400 line-clamp-2 leading-relaxed">
              {currentSubtitle.original}
            </div>
          ) : null}

          {currentSubtitle.translated ? (
            <div
              className="text-sm font-bold leading-snug tracking-tight"
              style={{ color: 'var(--ui-primary)' }}
            >
              {currentSubtitle.translated}
            </div>
          ) : null}

          {currentSubtitle.interim ? (
            <div className="text-xs italic text-zinc-400 flex items-center gap-1">
              <span
                className="size-1.5 rounded-full animate-pulse"
                style={{ backgroundColor: 'var(--ui-primary)' }}
              />
              <span>{currentSubtitle.interim}...</span>
            </div>
          ) : null}

          {!currentSubtitle.original && !currentSubtitle.translated && !currentSubtitle.interim ? (
            <div className="text-xs text-zinc-500 py-1.5 text-center">
              {isActive ? '正在监听说话声音...' : '点击上方按钮开启麦克风同传'}
            </div>
          ) : null}
        </div>
      </div>

      {/* Segmented Tab Bar */}
      <div className="flex items-center border-b border-white/[0.08] px-3.5 bg-zinc-900/30 text-xs">
        <button
          onClick={() => setActiveTab('subtitles')}
          className={cn(
            'flex items-center gap-1.5 py-2.5 px-3 border-b-2 font-medium transition-all duration-150',
            activeTab === 'subtitles'
              ? 'font-bold text-white'
              : 'border-transparent text-zinc-400 hover:text-zinc-200',
          )}
          style={
            activeTab === 'subtitles'
              ? { borderBottomColor: 'var(--ui-primary)', color: 'var(--ui-primary)' }
              : {}
          }
        >
          <span>逐字稿</span>
          <span
            className="rounded-full px-1.5 py-0.2 text-[10px] font-mono font-medium border"
            style={{
              backgroundColor: 'var(--ui-primary-background)',
              color: 'var(--ui-primary)',
              borderColor: 'color-mix(in srgb, var(--ui-primary) 30%, transparent)',
            }}
          >
            {history.length}
          </span>
        </button>

        <button
          onClick={() => setActiveTab('minutes')}
          className={cn(
            'flex items-center gap-1.5 py-2.5 px-3 border-b-2 font-medium transition-all duration-150',
            activeTab === 'minutes'
              ? 'font-bold text-white'
              : 'border-transparent text-zinc-400 hover:text-zinc-200',
          )}
          style={
            activeTab === 'minutes'
              ? { borderBottomColor: 'var(--ui-primary)', color: 'var(--ui-primary)' }
              : {}
          }
        >
          <Sparkles className="size-3.5" style={{ color: 'var(--ui-primary)' }} />
          <span>智能纪要</span>
        </button>

        <button
          onClick={() => setActiveTab('upload')}
          className={cn(
            'flex items-center gap-1.5 py-2.5 px-3 border-b-2 font-medium transition-all duration-150',
            activeTab === 'upload'
              ? 'font-bold text-white'
              : 'border-transparent text-zinc-400 hover:text-zinc-200',
          )}
          style={
            activeTab === 'upload'
              ? { borderBottomColor: 'var(--ui-primary)', color: 'var(--ui-primary)' }
              : {}
          }
        >
          <Upload className="size-3.5" style={{ color: 'var(--ui-primary)' }} />
          <span>音频直译</span>
        </button>
      </div>

      {/* Tab Body */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3.5">
        {activeTab === 'subtitles' ? (
          <div className="flex flex-col h-full space-y-2.5">
            <div className="flex items-center justify-between pb-1">
              <span className="text-[11px] font-medium text-zinc-400">发言历史流</span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-7 rounded-md text-zinc-400 hover:text-white"
                  onClick={handleCopyTranscript}
                  title="复制逐字稿"
                >
                  <Copy className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-7 rounded-md text-zinc-400 hover:text-red-400 hover:bg-red-500/10"
                  onClick={handleClearHistory}
                  title="清空历史"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2 pr-1">
              {history.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-48 text-center text-xs text-zinc-500 space-y-2.5">
                  <Languages className="size-8 stroke-[1.2] text-zinc-600" />
                  <span>暂无对话记录，说话后将自动沉淀为逐字稿</span>
                </div>
              ) : (
                history.map((item) => (
                  <div
                    key={item.id}
                    className="rounded-xl border border-white/[0.06] bg-zinc-900/60 p-3 text-xs space-y-1 hover:border-white/[0.12] transition-colors"
                  >
                    {bilingual && item.original ? (
                      <div className="text-zinc-400 text-[11px] leading-relaxed">{item.original}</div>
                    ) : null}
                    <div className="font-semibold text-zinc-100 leading-snug">{item.translated || item.original}</div>
                    <div className="text-[10px] font-mono text-zinc-500 pt-0.5">{item.time}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : activeTab === 'minutes' ? (
          /* AI Minutes Tab */
          <div className="flex flex-col h-full space-y-3">
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-zinc-400">会议笔录与背景 (可选)</label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="记录补充背景或讨论要点，AI 将融合逐字稿提取结构化行动项..."
                className="h-20 text-xs resize-none bg-zinc-900 border-white/[0.08] focus-visible:ring-[var(--ui-primary)]"
              />
            </div>

            <Button
              onClick={() => void handleGenerateMinutes()}
              disabled={isGeneratingMinutes}
              className="w-full h-9 text-xs font-semibold gap-2 shadow-md rounded-xl transition-all active:scale-[0.98]"
              style={{
                backgroundColor: 'var(--ui-primary)',
                color: 'var(--ui-primary-foreground)',
              }}
            >
              <Sparkles className="size-3.5" />
              <span>{isGeneratingMinutes ? 'AI 正在提炼结构化纪要...' : '生成智能会议纪要'}</span>
            </Button>

            {minutesResult ? (
              <div className="flex-1 overflow-y-auto rounded-xl border border-white/[0.08] bg-zinc-900/70 p-3.5 text-xs space-y-3">
                <div className="flex items-center justify-between border-b border-white/[0.08] pb-2.5">
                  <span className="font-semibold text-sm text-white tracking-tight">{minutesResult.title}</span>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    className="size-7 rounded-md border-white/[0.1] bg-zinc-800 text-zinc-300 hover:text-white"
                    onClick={handleDownloadMinutes}
                    title="下载 Markdown 纪要"
                  >
                    <Download className="size-3.5" />
                  </Button>
                </div>

                <div className="space-y-1">
                  <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--ui-primary)' }}>核心概要</div>
                  <p className="text-zinc-300 text-xs leading-relaxed">{minutesResult.summary}</p>
                </div>

                {minutesResult.key_points?.length ? (
                  <div className="space-y-1.5">
                    <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--ui-primary)' }}>讨论要点</div>
                    <ul className="space-y-1 text-zinc-300 text-xs">
                      {minutesResult.key_points.map((kp, idx) => (
                        <li key={idx} className="flex items-start gap-1.5">
                          <span style={{ color: 'var(--ui-primary)' }}>•</span>
                          <span>{kp}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {minutesResult.action_items?.length ? (
                  <div className="space-y-1.5">
                    <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--ui-primary)' }}>待办行动项</div>
                    <div className="space-y-1.5">
                      {minutesResult.action_items.map((item, idx) => (
                        <div
                          key={idx}
                          className="rounded-lg bg-zinc-950/80 p-2.5 border border-white/[0.06] text-xs space-y-1"
                        >
                          <div className="flex items-start gap-1.5 font-medium text-zinc-100">
                            <CheckCircle2 className="size-3.5 shrink-0 mt-0.5" style={{ color: 'var(--ui-primary)' }} />
                            <span>{item.task}</span>
                          </div>
                          {(item.owner || item.deadline) && (
                            <div className="flex items-center gap-2 text-[10px] text-zinc-400 pl-5">
                              {item.owner && (
                                <span
                                  className="flex items-center gap-1 rounded px-1.5 py-0.5 border"
                                  style={{
                                    backgroundColor: 'var(--ui-primary-background)',
                                    color: 'var(--ui-primary)',
                                    borderColor: 'color-mix(in srgb, var(--ui-primary) 30%, transparent)',
                                  }}
                                >
                                  <User className="size-2.5" />
                                  <span>{item.owner}</span>
                                </span>
                              )}
                              {item.deadline && (
                                <span
                                  className="flex items-center gap-1 rounded px-1.5 py-0.5 border"
                                  style={{
                                    backgroundColor: 'var(--ui-primary-background)',
                                    color: 'var(--ui-primary)',
                                    borderColor: 'color-mix(in srgb, var(--ui-primary) 30%, transparent)',
                                  }}
                                >
                                  <Calendar className="size-2.5" />
                                  <span>{item.deadline}</span>
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-center text-xs text-zinc-500 space-y-2 py-8">
                <Sparkles className="size-8 stroke-[1.2] text-zinc-600" />
                <span>录制完成后点击上方按钮，AI 自动提炼纪要与行动项</span>
              </div>
            )}
          </div>
        ) : (
          /* Audio Upload Tab */
          <div className="flex flex-col h-full space-y-3">
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*,.mp3,.wav,.m4a,.ogg,.aac,.flac,.webm"
              className="hidden"
              onChange={handleFileChange}
            />

            {!selectedAudioFile ? (
              <div
                onClick={() => fileInputRef.current?.click()}
                className="flex flex-col items-center justify-center border-2 border-dashed rounded-xl p-6 text-center cursor-pointer hover:bg-white/[0.02] transition-colors"
                style={{ borderColor: 'color-mix(in srgb, var(--ui-primary) 35%, transparent)' }}
              >
                <div
                  className="size-10 rounded-full flex items-center justify-center mb-2"
                  style={{ backgroundColor: 'var(--ui-primary-background)' }}
                >
                  <FileAudio className="size-5" style={{ color: 'var(--ui-primary)' }} />
                </div>
                <span className="text-xs font-semibold text-zinc-200">点击或选择音频文件</span>
                <span className="text-[10px] text-zinc-500 mt-1">支持 MP3, WAV, M4A, OGG, AAC, FLAC (最大 50MB)</span>
              </div>
            ) : (
              <div className="rounded-xl border border-white/[0.08] bg-zinc-900/60 p-3 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 overflow-hidden">
                    <FileAudio className="size-4 shrink-0" style={{ color: 'var(--ui-primary)' }} />
                    <span className="font-semibold text-zinc-200 truncate">{selectedAudioFile.name}</span>
                  </div>
                  <span className="text-[10px] text-zinc-500 shrink-0">
                    {(selectedAudioFile.size / (1024 * 1024)).toFixed(2)} MB
                  </span>
                </div>

                {audioPreviewUrl ? (
                  <audio controls src={audioPreviewUrl} className="w-full h-8 rounded" />
                ) : null}

                <div className="flex items-center gap-2 pt-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 text-xs text-zinc-400 hover:text-white"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    重新选文件
                  </Button>
                  <Button
                    onClick={() => void handleTranslateUploadedAudio()}
                    disabled={isTranslatingAudio}
                    className="flex-1 h-8 text-xs font-semibold gap-1.5 shadow-md rounded-lg"
                    style={{
                      backgroundColor: 'var(--ui-primary)',
                      color: 'var(--ui-primary-foreground)',
                    }}
                  >
                    <Sparkles className="size-3.5" />
                    <span>{isTranslatingAudio ? '正在 AI 翻译中...' : '开始音频直译'}</span>
                  </Button>
                </div>
              </div>
            )}

            {audioTranslationResult ? (
              <div className="flex-1 overflow-y-auto rounded-xl border border-white/[0.08] bg-zinc-900/70 p-3.5 text-xs space-y-3">
                <div className="flex items-center justify-between border-b border-white/[0.08] pb-2">
                  <span
                    className="text-[10px] font-mono px-2 py-0.5 rounded border"
                    style={{
                      backgroundColor: 'var(--ui-primary-background)',
                      color: 'var(--ui-primary)',
                      borderColor: 'color-mix(in srgb, var(--ui-primary) 30%, transparent)',
                    }}
                  >
                    源语言: {audioTranslationResult.source_language}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="icon-sm"
                      className="size-7 rounded-md border-white/[0.1] bg-zinc-800 text-zinc-300 hover:text-white"
                      onClick={handleImportAudioToHistory}
                      title="导入到逐字稿流"
                    >
                      <Copy className="size-3.5" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      className="size-7 rounded-md border-white/[0.1] bg-zinc-800 text-zinc-300 hover:text-white"
                      onClick={handleDownloadAudioMarkdown}
                      title="导出 Markdown"
                    >
                      <Download className="size-3.5" />
                    </Button>
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--ui-primary)' }}>核心摘要</div>
                  <p className="text-zinc-300 text-xs leading-relaxed">{audioTranslationResult.summary}</p>
                </div>

                <div className="space-y-1">
                  <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--ui-primary)' }}>目标译文 ({audioTranslationResult.target_language})</div>
                  <p className="text-zinc-200 font-medium text-xs leading-relaxed bg-zinc-950/60 p-2.5 rounded-lg border border-white/[0.04]">
                    {audioTranslationResult.translation}
                  </p>
                </div>

                <div className="space-y-1">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">原文逐字稿</div>
                  <p className="text-zinc-400 text-xs leading-relaxed bg-zinc-950/40 p-2.5 rounded-lg border border-white/[0.04]">
                    {audioTranslationResult.transcript}
                  </p>
                </div>

                {audioTranslationResult.segments && audioTranslationResult.segments.length > 0 ? (
                  <div className="space-y-1.5 pt-1">
                    <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--ui-primary)' }}>逐句时间轴对照</div>
                    <div className="space-y-1.5">
                      {audioTranslationResult.segments.map((seg, idx) => (
                        <div key={idx} className="rounded-lg bg-zinc-950/60 p-2 border border-white/[0.04] text-[11px] space-y-0.5">
                          {seg.timestamp ? <div className="text-[10px] font-mono text-indigo-400 font-medium">{seg.timestamp}</div> : null}
                          <div className="text-zinc-400">{seg.original}</div>
                          <div className="font-semibold text-zinc-100">{seg.translated}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </aside>
  )
}
