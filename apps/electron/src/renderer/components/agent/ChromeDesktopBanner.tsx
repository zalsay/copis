/**
 * ChromeDesktopBanner — macOS 本机 Chrome 桌面视觉自动化交互横幅
 *
 * 挂载于 Agent 对话流底部：
 * 1. awaiting_user：展示授权提示、系统权限状态检查、Chrome 窗口选择器与真实的“开始控制”授权按钮。
 * 2. active / starting：展示低延迟实时预览画板、正在控制的窗口信息与“停止控制”按钮及紧急停止快捷键提示。
 * 3. paused：展示暂停原因（如前台焦点丢失或几何变化）及退出控制选项。
 * 4. error：展示错误提示与关闭选项。
 */

import React, { useEffect, useState, useRef } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  Monitor,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ShieldAlert,
  Square,
  Play,
  ExternalLink,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  chromeDesktopSessionStateAtom,
  chromeDesktopMediaStreamAtom,
  chromeDesktopAvailableWindowsAtom,
  chromeDesktopSelectedWindowIdAtom,
  chromeDesktopSystemStatusAtom,
  chromeDesktopIsStartingAtom,
  chromeDesktopErrorAtom,
  fetchChromeDesktopStatusAtom,
  fetchChromeDesktopWindowsAtom,
  cleanupChromeDesktopStreamAtom,
  stopChromeDesktopControlAtom,
} from '@/atoms/chrome-desktop-atoms'
import type { ChromeDesktopErrorCode } from '@copis/shared'

interface ChromeDesktopBannerProps {
  sessionId: string
}

/** 格式化暂停原因 */
function formatPauseReason(reason?: ChromeDesktopErrorCode): string {
  switch (reason) {
    case 'CHROME_FOCUS_LOST':
      return '目标 Chrome 窗口已失去前台焦点，输入已暂停以避免误触'
    case 'CHROME_GEOMETRY_CHANGED':
      return '目标 Chrome 窗口位置或大小发生改变，旧画面坐标已失效'
    case 'CHROME_FRAME_STALE':
      return '画面捕获帧已过期，需要重新获取观察帧'
    case 'CHROME_ACTION_UNCERTAIN':
      return '上一项操作结果无法确认，为安全起见已暂停'
    default:
      return '控制已暂停'
  }
}

export function ChromeDesktopBanner({ sessionId }: ChromeDesktopBannerProps): React.ReactElement | null {
  const sessionState = useAtomValue(chromeDesktopSessionStateAtom)
  const [mediaStream, setMediaStream] = useAtom(chromeDesktopMediaStreamAtom)
  const availableWindows = useAtomValue(chromeDesktopAvailableWindowsAtom)
  const [selectedWindowId, setSelectedWindowId] = useAtom(chromeDesktopSelectedWindowIdAtom)
  const systemStatus = useAtomValue(chromeDesktopSystemStatusAtom)
  const [isStarting, setIsStarting] = useAtom(chromeDesktopIsStartingAtom)
  const [localError, setLocalError] = useAtom(chromeDesktopErrorAtom)

  const fetchStatus = useSetAtom(fetchChromeDesktopStatusAtom)
  const fetchWindows = useSetAtom(fetchChromeDesktopWindowsAtom)
  const cleanupStream = useSetAtom(cleanupChromeDesktopStreamAtom)
  const stopControl = useSetAtom(stopChromeDesktopControlAtom)

  const [refreshingWindows, setRefreshingWindows] = useState(false)
  const previewVideoRef = useRef<HTMLVideoElement | null>(null)

  // 校验当前会话是否属于该控制任务
  const isCurrentSession = sessionState?.sessionId === sessionId
  const state = isCurrentSession ? sessionState?.state : null

  // 绑定实时预览视频流
  useEffect(() => {
    const video = previewVideoRef.current
    if (!video) return
    if (mediaStream && (state === 'active' || state === 'starting')) {
      video.srcObject = mediaStream
      video.play().catch((err) => {
        console.warn('[ChromeDesktopBanner] 预览视频播放失败:', err)
      })
    } else {
      video.srcObject = null
    }
  }, [mediaStream, state])

  // 当进入 awaiting_user 状态时，自动拉取权限与窗口列表
  useEffect(() => {
    if (state === 'awaiting_user') {
      fetchStatus()
      fetchWindows()
    }
  }, [state, fetchStatus, fetchWindows])

  if (!isCurrentSession || !state || state === 'idle' || state === 'stopped') {
    return null
  }

  /** 刷新 Chrome 窗口列表 */
  const handleRefreshWindows = async (): Promise<void> => {
    setRefreshingWindows(true)
    try {
      await fetchWindows()
    } finally {
      setRefreshingWindows(false)
    }
  }

  /**
   * 用户真实点击“开始控制”
   * 必须直接在用户点击回调中调用 navigator.mediaDevices.getDisplayMedia
   */
  const handleConfirmStart = async (): Promise<void> => {
    if (isStarting || !sessionState) return
    const selected = availableWindows.find((w) => w.windowId === selectedWindowId)
    if (!selected) {
      setLocalError('请先选择一个有效的 Chrome 窗口')
      return
    }

    setIsStarting(true)
    setLocalError(null)

    try {
      // 1. 预先向主进程登记待授权窗口
      const prep = await window.electronAPI.chromeDesktop.prepareCapture({
        sessionId,
        controlId: sessionState.controlId,
        windowId: selected.windowId,
        pid: selected.pid,
      })
      if (!prep.ok) {
        throw new Error(prep.message || '准备采集目标失败')
      }

      // 2. 真实用户点击发起屏幕媒体捕获
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 10, max: 15 } },
        audio: false,
      })

      // 3. 将 MediaStream 存入 Jotai 状态供 CaptureHost 提取帧
      setMediaStream(stream)

      // 4. 确认启动控制
      const res = await window.electronAPI.chromeDesktop.confirmStart({
        sessionId,
        controlId: sessionState.controlId,
        windowId: selected.windowId,
        pid: selected.pid,
      })

      if (!res.ok) {
        throw new Error(res.message || '激活 Chrome 窗口控制失败')
      }
    } catch (err: any) {
      console.error('[ChromeDesktopBanner] 启动控制失败:', err)
      setLocalError(err.message || '启动控制失败')
      cleanupStream()
      await stopControl(sessionId)
    } finally {
      setIsStarting(false)
    }
  }

  /** 停止控制 */
  const handleStop = async (): Promise<void> => {
    await stopControl(sessionId)
  }

  return (
    <div className="mx-auto w-full max-w-[760px] px-2.5 pb-2.5 md:px-[18px] md:pb-[18px]">
      <div className="overflow-hidden rounded-xl border border-border/80 bg-card p-4 shadow-lg backdrop-blur-sm transition-all duration-200">
        {/* ===== 1. 待用户授权与选窗状态 (awaiting_user) ===== */}
        {state === 'awaiting_user' && (
          <div className="flex flex-col gap-3.5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Monitor className="size-5" />
                </div>
                <div>
                  <h4 className="text-sm font-semibold tracking-tight text-foreground">
                    Agent 正在请求控制本机 Chrome 桌面窗口
                  </h4>
                  <p className="text-xs text-muted-foreground">
                    授权后 Agent 将可观察该窗口并进行点击与输入。按需截图会发送给当前模型，并可能随会话记录保存。
                  </p>
                </div>
              </div>
              <Badge variant="outline" className="border-amber-500/40 text-amber-500 text-[11px] font-normal">
                等待授权
              </Badge>
            </div>

            {/* 权限缺失警示 */}
            {systemStatus && (!systemStatus.screenRecordingGranted || !systemStatus.accessibilityGranted) && (
              <div className="flex flex-col gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-600 dark:text-amber-400">
                <div className="flex items-center gap-1.5 font-medium">
                  <ShieldAlert className="size-4 shrink-0" />
                  <span>系统必要权限未就绪：</span>
                </div>
                {!systemStatus.screenRecordingGranted && (
                  <p className="pl-5 text-muted-foreground">
                    • 屏幕录制权限未授予：请在 macOS「系统设置 → 隐私与安全性 → 屏幕录制」中允许 Copis。
                  </p>
                )}
                {!systemStatus.accessibilityGranted && (
                  <p className="pl-5 text-muted-foreground">
                    • 辅助功能权限未授予：请在 macOS「系统设置 → 隐私与安全性 → 辅助功能」中允许 Chrome Desktop Helper。
                  </p>
                )}
              </div>
            )}

            {/* 窗口选择器 */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>选择目标 Chrome 窗口</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground"
                  onClick={handleRefreshWindows}
                  disabled={refreshingWindows}
                >
                  <RefreshCw className={`size-3 ${refreshingWindows ? 'animate-spin' : ''}`} />
                  刷新列表
                </Button>
              </div>

              {availableWindows.length === 0 ? (
                <div className="rounded-md border border-dashed border-border/80 bg-muted/40 p-3 text-center text-xs text-muted-foreground">
                  未检测到运行中的 Google Chrome 窗口。请先在 macOS 中启动 Chrome 并打开目标网页，然后点击“刷新列表”。
                </div>
              ) : (
                <Select
                  value={selectedWindowId ? String(selectedWindowId) : undefined}
                  onValueChange={(val) => setSelectedWindowId(Number(val))}
                >
                  <SelectTrigger className="w-full text-xs">
                    <SelectValue placeholder="请选择要控制的 Chrome 窗口" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableWindows.map((win) => (
                      <SelectItem key={win.windowId} value={String(win.windowId)} className="text-xs">
                        {win.title ? `${win.title} (PID: ${win.pid})` : `Chrome 窗口 (ID: ${win.windowId})`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {/* 错误提示 */}
            {(localError || sessionState.errorMessage) && (
              <div className="flex items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
                <AlertTriangle className="size-4 shrink-0" />
                <span>{localError || sessionState.errorMessage}</span>
              </div>
            )}

            {/* 安全提示与操作按钮 */}
            <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-[11px] text-muted-foreground">
                使用期间请让出鼠标与键盘。可通过快捷键{' '}
                <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
                  {sessionState.shortcut}
                </kbd>{' '}
                紧急停止。
              </span>
              <div className="flex items-center gap-2 self-end sm:self-auto">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={handleStop}
                  disabled={isStarting}
                >
                  拒绝 / 取消
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  className="h-8 gap-1.5 text-xs font-medium"
                  onClick={handleConfirmStart}
                  disabled={isStarting || availableWindows.length === 0 || !selectedWindowId}
                >
                  <Play className="size-3.5" />
                  {isStarting ? '正在启动...' : '开始控制'}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ===== 2. 活跃控制中 (active / starting) ===== */}
        {(state === 'active' || state === 'starting') && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="relative flex size-2.5">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex size-2.5 rounded-full bg-emerald-500" />
                </span>
                <span className="text-xs font-medium text-foreground">
                  正在控制 Chrome：
                  <span className="ml-1 text-muted-foreground font-normal">
                    {sessionState.targetWindow?.title || 'Google Chrome 窗口'}
                  </span>
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="hidden text-[11px] text-muted-foreground sm:inline">
                  紧急停止: <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">{sessionState.shortcut}</kbd>
                </span>
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-7 gap-1 px-2.5 text-xs"
                  onClick={handleStop}
                >
                  <Square className="size-3" />
                  停止控制
                </Button>
              </div>
            </div>

            {/* 低延迟预览 */}
            {mediaStream && (
              <div className="relative overflow-hidden rounded-lg border border-border/60 bg-black/5 dark:bg-black/30">
                <video
                  ref={previewVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="max-h-[160px] w-full object-contain"
                />
              </div>
            )}
          </div>
        )}

        {/* ===== 3. 暂停状态 (paused) ===== */}
        {state === 'paused' && (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="size-4 text-amber-500 shrink-0" />
                <div>
                  <h4 className="text-xs font-semibold text-foreground">
                    Chrome 桌面控制已暂停
                  </h4>
                  <p className="text-xs text-muted-foreground">
                    {formatPauseReason(sessionState.pauseReason)}
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={handleStop}
              >
                结束控制
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              本次控制已安全暂停并释放输入与采集流。如需继续，请点击“结束控制”后重新授权启动。
            </p>
          </div>
        )}

        {/* ===== 4. 错误状态 (error) ===== */}
        {state === 'error' && (
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-destructive">
              <XCircle className="size-4 shrink-0" />
              <span className="text-xs">
                控制出错: {sessionState.errorMessage || '未知错误'}
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={handleStop}
            >
              关闭
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
