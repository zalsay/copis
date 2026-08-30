import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

export interface SubtitleItem {
  id: string
  time: string
  original: string
  translated: string
}

export interface CurrentSubtitle {
  original: string
  translated: string
  interim: string
}

/** 浏览器实时翻译面板是否打开 */
export const liveTranslateOpenAtom = atom<boolean>(false)

/** 是否正在进行实时语音捕获与同传 */
export const liveTranslateActiveAtom = atom<boolean>(false)

/** 连接状态提示文字 */
export const liveTranslateStatusTextAtom = atom<string>('就绪')

/** Gemini API Key */
export const liveTranslateApiKeyAtom = atomWithStorage<string>(
  'copis-live-translate-api-key',
  '',
  undefined,
  { getOnInit: true },
)

/** 后端 Gemini Live WebSocket 网关地址 */
export const liveTranslateServerUrlAtom = atomWithStorage<string>(
  'copis-live-translate-server-url',
  'wss://us.siumt.xyz/gemini-live/ws/live',
  undefined,
  { getOnInit: true },
)

/** 服务端鉴权密钥 (x-api-key 请求头) */
export const liveTranslateServerApiKeyAtom = atomWithStorage<string>(
  'copis-live-translate-server-api-key',
  '2e5a31bb478540b38f0dbd6600e6fd25',
  undefined,
  { getOnInit: true },
)

/** 选中的 Gemini 模型 */
export const liveTranslateModelAtom = atomWithStorage<string>(
  'copis-live-translate-model',
  'gemini-3.5-live-translate-preview',
  undefined,
  { getOnInit: true },
)

/** 目标翻译语言 */
export const liveTranslateTargetLangAtom = atomWithStorage<string>(
  'copis-live-translate-target-lang',
  'zh-CN',
  undefined,
  { getOnInit: true },
)

/** 是否启用 24kHz 译文音频实时播报 */
export const liveTranslateVoicePlaybackAtom = atomWithStorage<boolean>(
  'copis-live-translate-voice-playback',
  true,
  undefined,
  { getOnInit: true },
)

/** 是否显示双语原文对照 */
export const liveTranslateBilingualAtom = atomWithStorage<boolean>(
  'copis-live-translate-bilingual',
  true,
  undefined,
  { getOnInit: true },
)

/** 是否在网页底部显示画中画悬浮字幕条 */
export const liveTranslateFloatingBannerAtom = atomWithStorage<boolean>(
  'copis-live-translate-floating-banner',
  true,
  undefined,
  { getOnInit: true },
)

/** 当前正在说的实时字幕 */
export const liveTranslateCurrentSubtitleAtom = atom<CurrentSubtitle>({
  original: '',
  translated: '',
  interim: '',
})

/** 历史逐字稿列表 */
export const liveTranslateHistoryAtom = atom<SubtitleItem[]>([])
