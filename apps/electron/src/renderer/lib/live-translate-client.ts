/**
 * Gemini Live 实时语音同传与音频处理客户端
 */

export interface LiveTranslateOptions {
  serverUrl: string
  serverApiKey?: string
  apiKey?: string
  model?: string
  targetLang?: string
  mode?: string
  enableVoicePlayback?: boolean
  onStatus?: (status: string, isError?: boolean) => void
  onReady?: (sessionId: string) => void
  onTranscript?: (text: string) => void
  onInterimTranscript?: (text: string) => void
  onTranslation?: (text: string) => void
  onTurnComplete?: () => void
  onError?: (err: string) => void
  onVolumeChange?: (volume: number) => void
}

export class LiveTranslateClient {
  private ws: WebSocket | null = null
  private audioContext: AudioContext | null = null
  private audioStream: MediaStream | null = null
  private audioInput: MediaStreamAudioSourceNode | null = null
  private processor: ScriptProcessorNode | null = null
  private analyser: AnalyserNode | null = null
  private playbackContext: AudioContext | null = null
  private nextPlaybackTime = 0
  private isRunning = false
  private animFrameId: number | null = null
  private options: LiveTranslateOptions

  constructor(options: LiveTranslateOptions) {
    this.options = options
  }

  public async start(): Promise<void> {
    if (this.isRunning) return
    this.options.onStatus?.('正在连接麦克风与翻译服务器...', false)

    try {
      // 1. 获取麦克风音频流
      this.audioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })

      // 2. 初始化录音 AudioContext
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      this.audioContext = new AudioCtx()
      const nativeSampleRate = this.audioContext.sampleRate

      this.audioInput = this.audioContext.createMediaStreamSource(this.audioStream)
      this.analyser = this.audioContext.createAnalyser()
      this.analyser.fftSize = 64

      // 4096 帧缓冲区
      this.processor = this.audioContext.createScriptProcessor(4096, 1, 1)

      this.audioInput.connect(this.analyser)
      this.audioInput.connect(this.processor)
      this.processor.connect(this.audioContext.destination)

      // 3. 连接 WebSocket 网关
      let wsUrl = this.options.serverUrl
      if (!wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://')) {
        wsUrl = `ws://${wsUrl}/ws/live`
      }
      if (this.options.serverApiKey) {
        const sep = wsUrl.includes('?') ? '&' : '?'
        wsUrl += `${sep}x-api-key=${encodeURIComponent(this.options.serverApiKey)}`
      }

      this.ws = new WebSocket(wsUrl)
      this.ws.binaryType = 'arraybuffer'

      this.ws.onopen = () => {
        this.options.onStatus?.('已连接网关，正在与 Gemini Live 协议握手...', false)
        const startMsg = {
          type: 'start',
          server_api_key: this.options.serverApiKey || undefined,
          api_key: this.options.apiKey || undefined,
          model: this.options.model || 'gemini-3.5-live-translate-preview',
          target_lang: this.options.targetLang || 'zh-CN',
          mode: this.options.mode || 'translate',
        }
        this.ws?.send(JSON.stringify(startMsg))
      }

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data)
      }

      this.ws.onerror = (e) => {
        console.error('[LiveTranslateClient] WebSocket error:', e)
        this.options.onStatus?.('WebSocket 连接异常', true)
        this.options.onError?.('无法连接至翻译服务网关，请确认服务已启动')
      }

      this.ws.onclose = () => {
        if (this.isRunning) {
          this.stop()
        }
        this.options.onStatus?.('连接已关闭', false)
      }

      // 音频处理回调：降采样为 16kHz Int16 PCM 并发送
      this.processor.onaudioprocess = (e) => {
        if (!this.isRunning || !this.ws || this.ws.readyState !== WebSocket.OPEN) return

        const channelData = e.inputBuffer.getChannelData(0)
        const pcm16 = this.downsampleTo16kPCM(channelData, nativeSampleRate)
        if (pcm16 && pcm16.byteLength > 0) {
          this.ws.send(pcm16.buffer)
        }
      }

      this.isRunning = true
      this.startVolumeMonitoring()
    } catch (error) {
      this.stop()
      const msg = error instanceof Error ? error.message : '启动失败'
      this.options.onStatus?.(`启动失败: ${msg}`, true)
      this.options.onError?.(msg)
      throw error
    }
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return
    try {
      const msg = JSON.parse(data) as {
        type: string
        text?: string
        data?: string
        session_id?: string
        message?: string
        error?: string
      }

      switch (msg.type) {
        case 'ready':
          this.options.onStatus?.('实时同传就绪中', false)
          if (msg.session_id) this.options.onReady?.(msg.session_id)
          break

        case 'status':
          if (msg.message) this.options.onStatus?.(msg.message, false)
          break

        case 'transcript':
          if (msg.text) this.options.onTranscript?.(msg.text)
          break

        case 'interim_transcript':
          if (msg.text) this.options.onInterimTranscript?.(msg.text)
          break

        case 'translation':
          if (msg.text) this.options.onTranslation?.(msg.text)
          break

        case 'audio':
          if (this.options.enableVoicePlayback && msg.data) {
            this.play24kPCMAudio(msg.data)
          }
          break

        case 'turn_complete':
          this.options.onTurnComplete?.()
          break

        case 'error':
          if (msg.error) {
            this.options.onStatus?.(`服务错误: ${msg.error}`, true)
            this.options.onError?.(msg.error)
          }
          break
      }
    } catch (e) {
      console.error('[LiveTranslateClient] Parse message error:', e)
    }
  }

  public stop(): void {
    this.isRunning = false

    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId)
      this.animFrameId = null
    }

    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'stop' }))
      }
      this.ws.close()
      this.ws = null
    }

    if (this.processor) {
      this.processor.disconnect()
      this.processor = null
    }
    if (this.audioInput) {
      this.audioInput.disconnect()
      this.audioInput = null
    }
    if (this.audioStream) {
      this.audioStream.getTracks().forEach((track) => track.stop())
      this.audioStream = null
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      void this.audioContext.close()
      this.audioContext = null
    }

    this.options.onVolumeChange?.(0)
  }

  // 16kHz 16-bit Int16 PCM 降采样算法
  private downsampleTo16kPCM(buffer: Float32Array, fromSampleRate: number): Int16Array {
    const targetSampleRate = 16000
    if (fromSampleRate === targetSampleRate) {
      const pcm16 = new Int16Array(buffer.length)
      for (let i = 0; i < buffer.length; i++) {
        const s = Math.max(-1, Math.min(1, buffer[i] ?? 0))
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
      }
      return pcm16
    }

    const ratio = fromSampleRate / targetSampleRate
    const newLength = Math.round(buffer.length / ratio)
    const pcm16 = new Int16Array(newLength)

    for (let i = 0; i < newLength; i++) {
      const originIndex = i * ratio
      const indexFloor = Math.floor(originIndex)
      const indexCeil = Math.min(indexFloor + 1, buffer.length - 1)
      const fraction = originIndex - indexFloor

      const s0 = buffer[indexFloor] ?? 0
      const s1 = buffer[indexCeil] ?? 0
      const sample = (1 - fraction) * s0 + fraction * s1
      const s = Math.max(-1, Math.min(1, sample))
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }

    return pcm16
  }

  // 播放 24kHz Mono 16-bit PCM 音频片段
  private play24kPCMAudio(base64Data: string): void {
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (!this.playbackContext || this.playbackContext.state === 'closed') {
        this.playbackContext = new AudioCtx({ sampleRate: 24000 })
        this.nextPlaybackTime = this.playbackContext.currentTime
      }

      const binaryStr = atob(base64Data)
      const len = binaryStr.length
      const bytes = new Uint8Array(len)
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryStr.charCodeAt(i)
      }

      const int16View = new Int16Array(bytes.buffer)
      const frameCount = int16View.length
      const audioBuffer = this.playbackContext.createBuffer(1, frameCount, 24000)
      const channelData = audioBuffer.getChannelData(0)

      for (let i = 0; i < frameCount; i++) {
        channelData[i] = (int16View[i] ?? 0) / 32768.0
      }

      const source = this.playbackContext.createBufferSource()
      source.buffer = audioBuffer
      source.connect(this.playbackContext.destination)

      const now = this.playbackContext.currentTime
      if (this.nextPlaybackTime < now) {
        this.nextPlaybackTime = now
      }

      source.start(this.nextPlaybackTime)
      this.nextPlaybackTime += audioBuffer.duration
    } catch (e) {
      console.error('[LiveTranslateClient] Play audio error:', e)
    }
  }

  private startVolumeMonitoring(): void {
    const update = () => {
      if (!this.isRunning || !this.analyser) return
      const data = new Uint8Array(this.analyser.frequencyBinCount)
      this.analyser.getByteFrequencyData(data)

      let sum = 0
      for (let i = 0; i < data.length; i++) {
        sum += data[i] ?? 0
      }
      const avg = sum / (data.length || 1)
      this.options.onVolumeChange?.(Math.min(100, Math.round((avg / 128) * 100)))

      this.animFrameId = requestAnimationFrame(update)
    }
    update()
  }
}

/**
 * 调用后端 API 生成结构化会议纪要
 */
export async function generateMeetingMinutes(
  serverUrl: string,
  apiKey: string,
  transcript: string,
  notes: string,
  serverApiKey?: string,
): Promise<{
  markdown: string
  minutes: {
    title: string
    summary: string
    key_points: string[]
    action_items: Array<{ task: string; owner?: string; deadline?: string }>
  }
}> {
  // Convert ws:// or wss:// to http:// or https://
  let httpUrl = serverUrl.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://')
  // Strip query parameters
  const [cleanUrl] = httpUrl.split('?')
  httpUrl = cleanUrl ?? httpUrl
  if (httpUrl.includes('/ws/live')) {
    httpUrl = httpUrl.replace('/ws/live', '/api/minutes')
  } else if (!httpUrl.endsWith('/api/minutes')) {
    httpUrl = httpUrl.replace(/\/+$/, '') + '/api/minutes'
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  const key = serverApiKey || '2e5a31bb478540b38f0dbd6600e6fd25'
  if (key) {
    headers['x-api-key'] = key
  }

  const resp = await fetch(httpUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      api_key: apiKey || undefined,
      transcript,
      notes,
    }),
  })

  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`生成会议纪要失败 (${resp.status}): ${errText}`)
  }

  return (await resp.json()) as {
    markdown: string
    minutes: {
      title: string
      summary: string
      key_points: string[]
      action_items: Array<{ task: string; owner?: string; deadline?: string }>
    }
  }
}

export interface AudioTranslationResult {
  source_language: string
  target_language: string
  transcript: string
  translation: string
  summary: string
  segments?: Array<{
    timestamp?: string
    original: string
    translated: string
  }>
}

/**
 * 上传音频文件到服务端进行多模态 AI 直译与摘要
 */
export async function translateAudioFile(
  serverUrl: string,
  file: File | Blob,
  targetLang: string,
  serverApiKey?: string,
  apiKey?: string,
  model?: string,
): Promise<AudioTranslationResult> {
  let httpUrl = serverUrl.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://')
  const [cleanUrl] = httpUrl.split('?')
  httpUrl = cleanUrl ?? httpUrl
  if (httpUrl.includes('/ws/live')) {
    httpUrl = httpUrl.replace('/ws/live', '/api/translate-audio')
  } else if (!httpUrl.endsWith('/api/translate-audio')) {
    httpUrl = httpUrl.replace(/\/+$/, '') + '/api/translate-audio'
  }

  const formData = new FormData()
  formData.append('file', file)
  formData.append('target_lang', targetLang)
  if (model) formData.append('model', model)
  if (apiKey) formData.append('api_key', apiKey)

  const headers: Record<string, string> = {}
  const key = serverApiKey || '2e5a31bb478540b38f0dbd6600e6fd25'
  if (key) {
    headers['x-api-key'] = key
  }

  const resp = await fetch(httpUrl, {
    method: 'POST',
    headers,
    body: formData,
  })

  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`音频直译失败 (${resp.status}): ${errText}`)
  }

  const json = (await resp.json()) as {
    success?: boolean
    error?: string
    data?: AudioTranslationResult
  }
  if (!json.success || !json.data) {
    throw new Error(json.error || '音频直译返回异常')
  }

  return json.data
}

