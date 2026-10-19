/**
 * macOS 本机 Chrome 桌面视觉自动化类型定义与常量
 */

export const CHROME_DESKTOP_ENDPOINT = '/api/internal/agent/chrome-desktop-tool' as const

export const CHROME_DESKTOP_DEFAULT_SHORTCUT = 'Control+Option+Command+.' as const

export const CHROME_DESKTOP_ALLOWED_KEYS = [
  'Enter',
  'Tab',
  'Shift+Tab',
  'Escape',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Cmd+L',
  'Cmd+A',
  'Cmd+R',
  'Cmd+T',
  'Cmd+W',
  'Alt+ArrowLeft',
  'Alt+ArrowRight',
] as const

export type ChromeDesktopAllowedKey = typeof CHROME_DESKTOP_ALLOWED_KEYS[number]

export type ChromeDesktopErrorCode =
  | 'CHROME_UNSUPPORTED_CONTEXT'
  | 'CHROME_VISION_MODEL_REQUIRED'
  | 'CHROME_BUSY'
  | 'CHROME_WINDOW_UNAVAILABLE'
  | 'CHROME_SCREEN_PERMISSION_REQUIRED'
  | 'CHROME_INPUT_PERMISSION_REQUIRED'
  | 'CHROME_STOP_SHORTCUT_UNAVAILABLE'
  | 'CHROME_FOCUS_LOST'
  | 'CHROME_GEOMETRY_CHANGED'
  | 'CHROME_FRAME_STALE'
  | 'CHROME_CAPTURE_FAILED'
  | 'CHROME_HELPER_FAILED'
  | 'CHROME_ACTION_UNCERTAIN'
  | 'CHROME_CANCELLED'
  | 'CHROME_CAPABILITY_STALE'

/** 焦点或窗口几何变化只暂停输入，已授权的采集会话可以继续恢复。 */
export function isRecoverableChromeDesktopPauseReason(
  reason?: ChromeDesktopErrorCode,
): boolean {
  return reason === 'CHROME_FOCUS_LOST' || reason === 'CHROME_GEOMETRY_CHANGED'
}

export type ChromeDesktopMode = 'observe' | 'control'

export type ChromeDesktopState =
  | 'idle'
  | 'awaiting_user'
  | 'starting'
  | 'active'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'error'

export type ChromeDesktopToolName =
  | 'ChromeDesktopStart'
  | 'ChromeDesktopObserve'
  | 'ChromeDesktopClick'
  | 'ChromeDesktopScroll'
  | 'ChromeDesktopType'
  | 'ChromeDesktopPress'
  | 'ChromeDesktopStop'

export interface ChromeDesktopBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface ChromeDesktopWindowInfo {
  windowId: number
  pid: number
  title: string
  bounds: ChromeDesktopBounds
}

export interface ChromeDesktopFrameMeta {
  controlId: string
  frameId: string
  width: number
  height: number
  capturedAt: number
  geometryVersion: number
  presentedFrames?: number
  mediaTime?: number
  encodedAt?: number
}

export interface ChromeDesktopFrameResult {
  frame: ChromeDesktopFrameMeta
  image: {
    mimeType: 'image/jpeg'
    data: string
  }
}

export interface PiWorkerChromeDesktopCapability {
  endpoint: typeof CHROME_DESKTOP_ENDPOINT
  token: string
}

export interface ChromeDesktopToolRequest {
  sessionId: string
  capabilityToken: string
  toolCallId: string
  toolName: ChromeDesktopToolName
  toolInput: Record<string, unknown>
}

export type ChromeDesktopToolResponse =
  | { kind: 'json'; value: Record<string, unknown> }
  | ({ kind: 'image' } & ChromeDesktopFrameResult)

export interface ChromeDesktopSessionState {
  controlId: string
  sessionId: string
  state: ChromeDesktopState
  mode?: ChromeDesktopMode
  targetWindow: ChromeDesktopWindowInfo | null
  pauseReason?: ChromeDesktopErrorCode
  errorMessage?: string
  shortcut: string
  createdAt: number
}

export interface ChromeDesktopSystemStatus {
  supported: boolean
  screenRecordingGranted: boolean
  accessibilityGranted: boolean
  visionModelSupported: boolean
  shortcut: string
  shortcutAvailable: boolean
  /** 当前已准备的 Chrome 原生组件版本。 */
  componentVersion?: string
  error?: string
}

export const CHROME_DESKTOP_IPC_CHANNELS = {
  CHECK_STATUS: 'chrome-desktop:check-status',
  LIST_WINDOWS: 'chrome-desktop:list-windows',
  PREPARE_CAPTURE: 'chrome-desktop:prepare-capture',
  CONFIRM_START: 'chrome-desktop:confirm-start',
  STOP_CONTROL: 'chrome-desktop:stop-control',
  GET_STATE: 'chrome-desktop:get-state',
  STATE_CHANGED: 'chrome-desktop:state-changed',
} as const

/** 组件安装前与执行前使用同一协议契约；新协议不能静默替换当前可运行版本。 */
export interface ChromeDesktopComponentMetadata {
  name: 'chrome-desktop-cli'
  version: string
  platform: 'darwin'
  arch: 'arm64' | 'x64'
  protocolVersion: 1
  entrypoint: 'copis-chrome'
  helper: 'copis-chrome-helper'
}

export function isChromeDesktopComponentMetadata(
  value: unknown,
  expected: { version: string; arch: string },
): value is ChromeDesktopComponentMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !expected.version || !['arm64', 'x64'].includes(expected.arch)) return false
  const metadata = value as Record<string, unknown>
  return metadata.name === 'chrome-desktop-cli'
    && metadata.version === expected.version
    && metadata.platform === 'darwin'
    && metadata.arch === expected.arch
    && metadata.protocolVersion === 1
    && metadata.entrypoint === 'copis-chrome'
    && metadata.helper === 'copis-chrome-helper'
}
