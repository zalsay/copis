/**
 * 语音输入会话路由
 *
 * Copis 前台时，听写状态内嵌在底部输入工具栏。
 * 外部应用前台时，显示无焦点、无转写文本的轻量状态条，避免用户失去听写反馈。
 */

import { app, BrowserWindow, screen, webContents, type BrowserWindowConstructorOptions } from 'electron'
import { join } from 'node:path'
import { VOICE_DICTATION_IPC_CHANNELS } from '../../types'
import { getSettings } from './settings-service'
import { captureVoiceDictationTarget } from './text-output-service'
import { getMainWindow } from '../index'
import { httpApiPortArgument, httpApiWebTokenArgument } from './http-api-web-token'
import { chromeDesktopService } from './chrome-desktop-service'

const INDICATOR_WIDTH = 360
const INDICATOR_HEIGHT = 110
const INDICATOR_BOTTOM_MARGIN = 28

let voiceDictationActive = false
let usesExternalIndicator = false
let indicatorState: 'recording' | 'stopping' = 'recording'
let indicatorVolume = 0
let indicatorTranscript = ''
let voiceIndicatorWindow: BrowserWindow | null = null

interface VoiceDictationToggleOptions {
  targetIsCopis?: boolean
}

/**
 * 保留原导出以兼容启动流程；Copis 内部听写不再创建独立窗口。
 */
export function createVoiceDictationWindow(): void {
  const mainWindow = getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return
  installVoiceDictationMediaPermissions(mainWindow)
}

export function toggleVoiceDictationWindow(options: VoiceDictationToggleOptions = {}): void {
  if (!isVoiceDictationEnabled()) {
    console.log('[语音输入] 功能未启用，忽略唤起请求')
    return
  }

  const mainWindow = getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return
  installVoiceDictationMediaPermissions(mainWindow)

  if (voiceDictationActive) {
    indicatorState = 'stopping'
    sendIndicatorState()
    mainWindow.webContents.send(VOICE_DICTATION_IPC_CHANNELS.TOGGLE_STOP)
    return
  }

  captureVoiceDictationTarget(options.targetIsCopis)
  voiceDictationActive = true
  usesExternalIndicator = options.targetIsCopis !== true
  indicatorState = 'recording'
  indicatorVolume = 0
  indicatorTranscript = ''
  if (usesExternalIndicator) showVoiceIndicator()
  mainWindow.webContents.send(VOICE_DICTATION_IPC_CHANNELS.SHOWN)
}

/** 听写完成、取消或失败后关闭所有可见状态。 */
export function hideVoiceDictationWindow(): void {
  voiceDictationActive = false
  usesExternalIndicator = false
  indicatorVolume = 0
  indicatorTranscript = ''
  if (voiceIndicatorWindow && !voiceIndicatorWindow.isDestroyed()) {
    voiceIndicatorWindow.hide()
  }
}

/** 内嵌模式不再调整独立听写面板尺寸。 */
export function resizeVoiceDictationWindow(_height: number): void {}

/** 听写不再干预主窗口激活。 */
export function shouldSuppressVoiceDictationActivate(): boolean {
  return false
}

export function destroyVoiceDictationWindow(): void {
  hideVoiceDictationWindow()
  if (voiceIndicatorWindow && !voiceIndicatorWindow.isDestroyed()) {
    voiceIndicatorWindow.destroy()
    voiceIndicatorWindow = null
  }
}

/** 仅接收主窗口的采集结果，转发给外部应用的无焦点状态条。 */
export function updateVoiceDictationIndicatorVolume(volume: number): void {
  if (!usesExternalIndicator || indicatorState !== 'recording') return
  indicatorVolume = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 0))
  sendIndicatorState()
}

/** 更新外部状态条的预览文本，不向第三方应用写入任何中间结果。 */
export function updateVoiceDictationIndicatorTranscript(text: string): void {
  if (!usesExternalIndicator) return
  indicatorTranscript = text
  sendIndicatorState()
}

function isVoiceDictationEnabled(): boolean {
  return getSettings().voiceDictation?.enabled === true
}

function showVoiceIndicator(): void {
  const indicator = getOrCreateVoiceIndicatorWindow()
  const bounds = getVoiceIndicatorBounds()
  indicator.setBounds(bounds)
  if (indicator.webContents.isLoading()) return
  indicator.showInactive()
  sendIndicatorState()
}

function getOrCreateVoiceIndicatorWindow(): BrowserWindow {
  if (voiceIndicatorWindow && !voiceIndicatorWindow.isDestroyed()) return voiceIndicatorWindow

  const options: BrowserWindowConstructorOptions = {
    width: INDICATOR_WIDTH,
    height: INDICATOR_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    hasShadow: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [httpApiWebTokenArgument(), httpApiPortArgument()],
      partition: 'voice-dictation-indicator',
    },
  }
  const indicator = new BrowserWindow(options)
  indicator.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  indicator.on('closed', () => {
    if (voiceIndicatorWindow === indicator) voiceIndicatorWindow = null
  })
  indicator.once('ready-to-show', () => {
    if (!usesExternalIndicator || indicator.isDestroyed()) return
    indicator.showInactive()
    sendIndicatorState()
  })

  if (app.isPackaged) {
    indicator.loadFile(join(__dirname, 'renderer', 'index.html'), {
      query: { window: 'voice-dictation-indicator' },
    })
  } else {
    indicator.loadURL('http://127.0.0.1:5174?window=voice-dictation-indicator')
  }

  voiceIndicatorWindow = indicator
  return indicator
}

function getVoiceIndicatorBounds(): Electron.Rectangle {
  const point = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(point)
  const { x, y, width, height } = display.workArea
  return {
    x: x + Math.round((width - INDICATOR_WIDTH) / 2),
    y: y + height - INDICATOR_HEIGHT - INDICATOR_BOTTOM_MARGIN,
    width: INDICATOR_WIDTH,
    height: INDICATOR_HEIGHT,
  }
}

function sendIndicatorState(): void {
  if (!usesExternalIndicator || !voiceIndicatorWindow || voiceIndicatorWindow.isDestroyed()) return
  voiceIndicatorWindow.webContents.send(VOICE_DICTATION_IPC_CHANNELS.INDICATOR_STATE, {
    state: indicatorState,
    volume: indicatorVolume,
    transcript: indicatorTranscript,
  })
}

function installVoiceDictationMediaPermissions(win: BrowserWindow): void {
  const voiceSession = win.webContents.session

  voiceSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (webContents?.id !== win.webContents.id) return false
    const url = details.requestingUrl ?? details.securityOrigin ?? webContents?.getURL() ?? requestingOrigin

    if ((permission as string) === 'display-capture') {
      return isTrustedVoiceDictationUrl(url) && chromeDesktopService.hasPendingCapture()
    }

    if (permission !== 'media' || details.mediaType === 'video') return false
    return isTrustedVoiceDictationUrl(url)
  })

  voiceSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (webContents.id !== win.webContents.id) {
      callback(false)
      return
    }

    if ((permission as string) === 'display-capture') {
      const isTrustedRequest = isTrustedVoiceDictationUrl(
        (details as any).requestingUrl ?? (details as any).securityOrigin ?? webContents.getURL(),
      )
      callback(isTrustedRequest && chromeDesktopService.hasPendingCapture())
      return
    }

    if (permission !== 'media') {
      callback(false)
      return
    }

    const mediaDetails = details as Electron.MediaAccessPermissionRequest
    const requestsVideo = mediaDetails.mediaTypes?.includes('video') ?? false
    const isTrustedRequest = isTrustedVoiceDictationUrl(
      mediaDetails.requestingUrl ??
      mediaDetails.securityOrigin ??
      webContents.getURL(),
    )

    callback(isTrustedRequest && !requestsVideo)
  })

  if (typeof (voiceSession as any).setDisplayMediaRequestHandler === 'function') {
    ;(voiceSession as any).setDisplayMediaRequestHandler(async (request: any, callback: any) => {
      const pendingTarget = chromeDesktopService.getPendingCaptureTarget()
      await handleDisplayMediaRequest(
        request,
        win.webContents.id,
        pendingTarget,
        () => {
          const { desktopCapturer } = require('electron')
          return desktopCapturer.getSources({ types: ['window'] })
        },
        callback,
        () => {
          const current = chromeDesktopService.getPendingCaptureTarget()
          return Boolean(current && pendingTarget && current.controlId === pendingTarget.controlId && current.windowId === pendingTarget.windowId && current.pid === pendingTarget.pid)
        },
      )
    })
  }
}

/**
 * 处理 DisplayMedia 请求，严格校验顶层 frame 与 pending capture target 匹配，
 * 失败分支调用 callback(null) 触发 Chromium NotAllowedError 拒绝。
 */
export async function handleDisplayMediaRequest(
  request: any,
  expectedWebContentsId: number,
  pendingTarget: { windowId: number } | null,
  getSources: () => Promise<Array<{ id: string; [key: string]: any }>>,
  callback: (streams: { video?: any } | null) => void,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (!validateDisplayMediaFrame(request?.frame, expectedWebContentsId)) {
    callback(null)
    return
  }

  if (!pendingTarget || !isCurrent()) {
    callback(null)
    return
  }

  try {
    const sources = await getSources()
    const matched = matchDesktopCaptureWindowSource(sources, pendingTarget.windowId)
    if (matched && isCurrent() && validateDisplayMediaFrame(request?.frame, expectedWebContentsId)) {
      callback({ video: matched })
    } else {
      callback(null)
    }
  } catch {
    callback(null)
  }
}

/** 校验 DisplayMedia 请求是否来自受信任的主窗口顶层 frame */
export function validateDisplayMediaFrame(frame: any, expectedWebContentsId: number): boolean {
  if (!frame || frame.parent !== null) return false
  try {
    return webContents.fromFrame(frame)?.id === expectedWebContentsId
  } catch {
    return false
  }
}

/** 精确匹配 windowId 的 desktopCapturer source，格式为 window:<windowId>:<subId> */
export function matchDesktopCaptureWindowSource<T extends { id: string }>(
  sources: T[],
  targetWindowId: number,
): T | null {
  const targetStr = String(targetWindowId)
  return sources.find((s) => {
    if (typeof s.id !== 'string' || !s.id.startsWith('window:')) return false
    const parts = s.id.split(':')
    return parts[1] === targetStr
  }) ?? null
}

function isTrustedVoiceDictationUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false

  try {
    const parsed = new URL(rawUrl)
    if (!app.isPackaged && parsed.origin === 'http://127.0.0.1:5174') return true
    return parsed.protocol === 'file:'
  } catch {
    return false
  }
}
