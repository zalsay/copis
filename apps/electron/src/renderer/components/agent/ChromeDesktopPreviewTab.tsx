/**
 * ChromeDesktopPreviewTab — 顶部主 Tab 中的 Chrome Desktop 完整预览。
 *
 * 与 Agent 横幅共享同一个 MediaStream，不重新触发 getDisplayMedia。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { Monitor, Square } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  chromeDesktopMediaStreamAtom,
  chromeDesktopMediaStreamControlAtom,
  chromeDesktopSessionStateAtom,
  stopChromeDesktopControlAtom,
} from '@/atoms/chrome-desktop-atoms'
import { tabsAtom } from '@/atoms/tab-atoms'

interface ChromeDesktopPreviewTabProps {
  sessionId: string
  controlId: string
  title: string
}

export function ChromeDesktopPreviewTab({
  sessionId,
  controlId,
  title,
}: ChromeDesktopPreviewTabProps): React.ReactElement {
  const sessionState = useAtomValue(chromeDesktopSessionStateAtom)
  const mediaStream = useAtomValue(chromeDesktopMediaStreamAtom)
  const mediaStreamControlId = useAtomValue(chromeDesktopMediaStreamControlAtom)
  const stopControl = useSetAtom(stopChromeDesktopControlAtom)
  const store = useStore()
  const videoRef = React.useRef<HTMLVideoElement | null>(null)

  const ownsControl = sessionState?.sessionId === sessionId && sessionState.controlId === controlId
  const isLive = ownsControl && (sessionState.state === 'active' || sessionState.state === 'starting')
  const isPaused = ownsControl && sessionState.state === 'paused'
  const currentMediaStream = mediaStreamControlId === controlId ? mediaStream : null

  React.useEffect(() => {
    const video = videoRef.current
    if (!video) return

    if (currentMediaStream && isLive) {
      video.srcObject = currentMediaStream
      void video.play().catch((error: unknown) => {
        console.warn('[ChromeDesktopPreviewTab] 预览视频播放失败:', error)
      })
    } else {
      video.srcObject = null
    }

    return () => {
      if (video.srcObject === currentMediaStream) video.srcObject = null
    }
  }, [currentMediaStream, isLive])

  React.useEffect(() => {
    return () => {
      // 切换到同一会话的 Agent/文件预览时保留控制；所属会话整体离开 Tab 栏时释放控制。
      setTimeout(() => {
        const hasOwnerAgentTab = store.get(tabsAtom).some(
          (tab) => tab.type === 'agent' && tab.sessionId === sessionId,
        )
        if (!hasOwnerAgentTab) void stopControl({ sessionId, controlId })
      }, 0)
    }
  }, [controlId, sessionId, stopControl, store])

  const handleStop = React.useCallback(() => {
    void stopControl({ sessionId, controlId })
  }, [controlId, sessionId, stopControl])

  return (
    <div className="flex h-full min-h-0 flex-col bg-black text-white">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-background px-3 py-2 text-foreground">
        <div className="flex min-w-0 items-center gap-2">
          <Monitor className="size-4 shrink-0 text-primary" />
          <span className="truncate text-xs font-medium">{title}</span>
          <Badge variant="outline" className="shrink-0 text-[10px]">
            {sessionState?.mode === 'control' ? '控制中' : '观察中'}
          </Badge>
        </div>
        {ownsControl && (isLive || isPaused) && (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="h-7 shrink-0 gap-1 px-2.5 text-xs"
            onClick={handleStop}
          >
            <Square className="size-3" />
            停止控制
          </Button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black p-3">
        {currentMediaStream && isLive ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <div className="flex flex-col items-center gap-2 text-center text-sm text-white/70">
            <Monitor className="size-8 text-white/40" />
            <span>{isPaused ? 'Chrome 控制已暂停' : 'Chrome 采集已结束'}</span>
            <span className="text-xs text-white/45">关闭此 Tab 后可返回 Agent 会话</span>
          </div>
        )}
      </div>
    </div>
  )
}
