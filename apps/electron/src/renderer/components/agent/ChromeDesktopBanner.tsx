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
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai'
import {
  Monitor,
  RefreshCw,
  AlertTriangle,
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
  chromeDesktopMediaStreamControlAtom,
  chromeDesktopCaptureAttemptAtom,
  reserveChromeDesktopCaptureAtom,
  commitChromeDesktopCaptureAtom,
  chromeDesktopAvailableWindowsAtom,
  chromeDesktopSelectedWindowIdAtom,
  chromeDesktopSystemStatusAtom,
  chromeDesktopIsStartingAtom,
  chromeDesktopErrorAtom,
  fetchChromeDesktopStatusAtom,
  fetchChromeDesktopWindowsAtom,
  stopChromeDesktopControlAtom,
} from '@/atoms/chrome-desktop-atoms'
import { openChromeDesktopPreviewTabAtom } from '@/atoms/chrome-desktop-preview-tabs'
import { isChromeDesktopTab, tabsAtom } from '@/atoms/tab-atoms'
import { workingSettingsOpenAtom, workingSettingsSectionAtom } from '@/atoms/working-atoms'
import { isRecoverableChromeDesktopPauseReason, type ChromeDesktopErrorCode } from '@copis/shared'

/** 预览尽力启动；原生 Observe 和输入不依赖此视频流。 */
async function requestPreviewStream(): Promise<MediaStream | null> {
  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 10, max: 15 } },
      audio: false,
    })
  } catch (error) {
    console.warn('[ChromeDesktopBanner] 实时预览暂不可用:', error instanceof Error ? error.message : String(error))
    return null
  }
}

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
  const store = useStore()
  const mediaStream = useAtomValue(chromeDesktopMediaStreamAtom)
  const mediaStreamControlId = useAtomValue(chromeDesktopMediaStreamControlAtom)
  const availableWindows = useAtomValue(chromeDesktopAvailableWindowsAtom)
  const [selectedWindowId, setSelectedWindowId] = useAtom(chromeDesktopSelectedWindowIdAtom)
  const systemStatus = useAtomValue(chromeDesktopSystemStatusAtom)
  const [isStarting, setIsStarting] = useAtom(chromeDesktopIsStartingAtom)
  const [localError, setLocalError] = useAtom(chromeDesktopErrorAtom)

  const fetchStatus = useSetAtom(fetchChromeDesktopStatusAtom)
  const fetchWindows = useSetAtom(fetchChromeDesktopWindowsAtom)
  const reserveCapture = useSetAtom(reserveChromeDesktopCaptureAtom)
  const commitCapture = useSetAtom(commitChromeDesktopCaptureAtom)
  const stopControl = useSetAtom(stopChromeDesktopControlAtom)
  const openPreviewTab = useSetAtom(openChromeDesktopPreviewTabAtom)
  const setSettingsSection = useSetAtom(workingSettingsSectionAtom)
  const setSettingsOpen = useSetAtom(workingSettingsOpenAtom)

  const [refreshingWindows, setRefreshingWindows] = useState(false)
  const previewVideoRef = useRef<HTMLVideoElement | null>(null)
  const unmountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previousControlRef = useRef<{ sessionId: string; controlId: string } | null>(null)

  // 校验当前会话是否属于该控制任务
  const isCurrentSession = sessionState?.sessionId === sessionId
  const state = isCurrentSession ? sessionState?.state : null
  const currentMediaStream = mediaStreamControlId === sessionState?.controlId ? mediaStream : null

  // 绑定实时预览视频流
  useEffect(() => {
    const video = previewVideoRef.current
    if (!video) return
    if (currentMediaStream && (state === 'active' || state === 'starting')) {
      video.srcObject = currentMediaStream
      video.play().catch((err) => {
        console.warn('[ChromeDesktopBanner] 预览视频播放失败:', err)
      })
    } else {
      video.srcObject = null
    }
  }, [currentMediaStream, state])

  // control 更替或 Banner 卸载时，只停止 effect 创建时归属的旧 control。
  useEffect(() => {
    const control = sessionState?.sessionId === sessionId
      ? { sessionId, controlId: sessionState.controlId }
      : null
    const previous = previousControlRef.current
    if (previous && (previous.sessionId !== control?.sessionId || previous.controlId !== control?.controlId)) {
      void stopControl(previous)
    }
    previousControlRef.current = control
    if (unmountTimerRef.current !== null) clearTimeout(unmountTimerRef.current)
    return () => {
      unmountTimerRef.current = setTimeout(() => {
        if (!control) return
        // 切到 Chrome 主 Tab 会卸载 AgentView，但控制会话仍由主 Tab 持有。
        // 只有没有对应预览 Tab 时才把卸载视为离开任务并停止控制。
        const hasChromePreviewTab = store.get(tabsAtom).some(
          (tab) => isChromeDesktopTab(tab) && tab.controlId === control.controlId,
        )
        if (!hasChromePreviewTab) void stopControl(control)
      }, 0)
    }
  }, [sessionId, sessionState?.sessionId, sessionState?.controlId, stopControl, store])

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
      await Promise.all([fetchStatus(), fetchWindows()])
    } finally {
      setRefreshingWindows(false)
    }
  }

  /** await 期间停止或换窗后，旧预览不能覆盖当前控制。 */
  const isCurrentCapture = (attempt: number, controlId: string): boolean => {
    const current = store.get(chromeDesktopSessionStateAtom)
    return store.get(chromeDesktopCaptureAttemptAtom) === attempt
      && current?.sessionId === sessionId
      && current.controlId === controlId
      && !['idle', 'stopping', 'stopped', 'error'].includes(current.state)
      && (current.state !== 'paused' || isRecoverableChromeDesktopPauseReason(current.pauseReason))
  }

  /** 流可以晚于原生连接完成；停止或切换后的迟到流只释放自身。 */
  const capturePreview = async (attempt: number, controlId: string): Promise<void> => {
    const stream = await requestPreviewStream()
    if (!stream) return
    if (!isCurrentCapture(attempt, controlId)) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }
    commitCapture({ attempt, controlId, stream })
  }

  /** 用户真实点击确认：绑定窗口后发起预览，同时立即建立原生连接。 */
  const handleConfirmStart = async (): Promise<void> => {
    if (isStarting || !sessionState) return
    const selected = availableWindows.find((w) => w.windowId === selectedWindowId)
    if (!selected) {
      setLocalError('请先选择一个有效的 Chrome 窗口')
      return
    }

    const attempt = reserveCapture(sessionState.controlId)
    if (attempt === null) return
    const control = { sessionId, controlId: sessionState.controlId }
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
      if (!isCurrentCapture(attempt, control.controlId)) return

      // getDisplayMedia 可能长时间等待系统响应；原生连接不能等待预览结果。
      void capturePreview(attempt, control.controlId)

      // 先触发预览请求，再确认原生连接；预览异常只在自己的 Promise 中处理。
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
      if (!isCurrentCapture(attempt, control.controlId)) return
      console.error('[ChromeDesktopBanner] 启动控制失败:', err)
      setLocalError(err.message || '启动控制失败')
      await stopControl(control)
    } finally {
      if (attempt === store.get(chromeDesktopCaptureAttemptAtom)) setIsStarting(false)
    }
  }

  /** 重试只更新预览，不重新确认或中断已有的原生连接。 */
  const handleRetryPreview = async (): Promise<void> => {
    if (state !== 'active' || !sessionState) return
    const controlId = sessionState.controlId
    const attempt = reserveCapture(controlId)
    if (attempt === null) return
    try {
      await capturePreview(attempt, controlId)
    } finally {
      if (attempt === store.get(chromeDesktopCaptureAttemptAtom)) setIsStarting(false)
    }
  }

  /** 停止控制 */
  const handleStop = async (): Promise<void> => {
    if (sessionState) await stopControl({ sessionId, controlId: sessionState.controlId })
  }

  /** 在顶部主 Tab 栏打开完整 Chrome 预览，复用当前已经授权的 MediaStream。 */
  const handleOpenPreviewTab = (): void => {
    if (!sessionState || !currentMediaStream) return
    openPreviewTab({
      sessionId,
      controlId: sessionState.controlId,
      title: `Chrome：${sessionState.targetWindow?.title || '窗口预览'}`,
    })
  }

  return (
    <div className="ml-8 mr-auto w-[calc(100%-2rem)] max-w-[560px] px-2.5 pb-2 md:pb-2">
      <div className="overflow-hidden rounded-xl border border-border/80 bg-card p-4 shadow-lg backdrop-blur-sm transition-all duration-200">
        {/* ===== 1. 待用户授权与选窗状态 (awaiting_user) ===== */}
        {state === 'awaiting_user' && (
          <div className="flex flex-col gap-3.5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
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
              <Badge variant="outline" className="min-w-[76px] shrink-0 justify-center whitespace-nowrap border-amber-500/40 text-amber-500 text-[11px] font-normal">
                等待授权
              </Badge>
            </div>

            {systemStatus && (systemStatus.supported === false || systemStatus.error) && (
              <div role="alert" className="flex flex-col gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
                <div className="flex items-center gap-1.5 font-medium">
                  <AlertTriangle className="size-4 shrink-0" />
                  <span>{systemStatus.supported ? 'Chrome 桌面自动化状态检查提示' : 'Chrome 桌面自动化组件暂不可用'}</span>
                </div>
                {systemStatus.error && <p className="break-words pl-5">{systemStatus.error}</p>}
                {!systemStatus.supported && (
                  <div className="flex flex-wrap items-center gap-2 pl-5 text-muted-foreground">
                    <span>请前往「设置 → 关于/更新 → 本地能力」安装或重试“Chrome 桌面自动化”组件，完成后点击“刷新列表”。</span>
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      onClick={() => {
                        setSettingsSection('about')
                        setSettingsOpen(true)
                      }}
                    >
                      打开关于/更新
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* 只有组件可用时，权限标志才代表实际的系统授权状态。 */}
            {systemStatus?.supported === true && (!systemStatus.screenRecordingGranted || !systemStatus.accessibilityGranted) && (
              <div className="flex flex-col gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-600 dark:text-amber-400">
                <div className="flex items-center gap-1.5 font-medium">
                  <ShieldAlert className="size-4 shrink-0" />
                  <span>系统必要权限未就绪：</span>
                </div>
                {!systemStatus.screenRecordingGranted && (
                  <p className="pl-5 text-muted-foreground">
                    • 屏幕录制权限未授予：请在 macOS「系统设置 → 隐私与安全性 → 屏幕录制」中允许 Chrome 桌面自动化组件（授权项以 macOS 实际显示的名称为准）。
                  </p>
                )}
                {!systemStatus.accessibilityGranted && (
                  <p className="pl-5 text-muted-foreground">
                    • 辅助功能权限未授予：请在 macOS「系统设置 → 隐私与安全性 → 辅助功能」中允许 Chrome 桌面自动化组件（授权项以 macOS 实际显示的名称为准）。
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
                  {systemStatus?.supported === false
                    ? '组件准备完成后，请点击“刷新列表”获取可用的 Chrome 窗口。'
                    : '未检测到运行中的 Google Chrome 窗口。请先在 macOS 中启动 Chrome 并打开目标网页，然后点击“刷新列表”。'}
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
                  {isStarting ? '正在启动...' : '开始观察'}
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
                  {sessionState.mode === 'observe' ? '已连接 Chrome，可观察页面：' : '正在控制 Chrome：'}
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

            {!currentMediaStream && (
              <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 p-2.5 text-xs text-muted-foreground">
                <span>{state === 'starting' ? '正在连接 Chrome，预览暂不可用。' : '已连接，可观察页面。预览暂不可用，不影响 Agent 观察与输入。'}</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 gap-1 text-xs"
                  onClick={handleRetryPreview}
                  disabled={isStarting || state !== 'active'}
                >
                  <RefreshCw className={`size-3 ${isStarting ? 'animate-spin' : ''}`} />
                  {isStarting ? '正在重试...' : '重试预览'}
                </Button>
              </div>
            )}

            {/* 低延迟预览 */}
            {currentMediaStream && (
              <button
                type="button"
                className="group relative flex w-full cursor-pointer justify-center overflow-hidden rounded-lg border border-border/60 bg-black/5 p-1.5 text-left transition-colors hover:border-primary/60 dark:bg-black/30"
                onClick={handleOpenPreviewTab}
                aria-label="在顶部主 Tab 中打开完整 Chrome 预览"
                title="点击在顶部主 Tab 中打开完整预览"
              >
                <video
                  ref={previewVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="h-auto max-h-[120px] max-w-[420px] w-auto object-contain"
                />
                <span className="pointer-events-none absolute inset-x-0 bottom-1 mx-auto w-fit rounded bg-black/65 px-2 py-0.5 text-[10px] text-white/90 opacity-0 transition-opacity group-hover:opacity-100">
                  点击在顶部 Tab 中完整打开
                </span>
                <ExternalLink className="pointer-events-none absolute right-2 top-2 size-3.5 text-white/80 opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
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
                    {isRecoverableChromeDesktopPauseReason(sessionState.pauseReason)
                      ? 'Chrome 桌面控制已暂停，授权仍保留'
                      : 'Chrome 桌面控制已暂停'}
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
              {isRecoverableChromeDesktopPauseReason(sessionState.pauseReason)
                ? '目标窗口重新可用后，下一次观察或输入会自动恢复，无需再次授权。'
                : '本次控制已安全暂停并释放输入与采集流。如需继续，请点击“结束控制”后重新授权启动。'}
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
