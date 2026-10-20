/**
 * 全局 Chrome 预览宿主：监听原生控制状态并管理预览流的生命周期。
 * Agent Observe 与输入由原生组件负责，预览结束不代表原生窗口失效。
 */

import React, { useEffect, useRef } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { retainsChromeDesktopAuthorization } from '@copis/shared'
import {
  chromeDesktopMediaStreamAtom,
  chromeDesktopMediaStreamControlAtom,
  stopChromeDesktopControlAtom,
  chromeDesktopSessionStateAtom,
  cleanupChromeDesktopStreamAtom,
} from '@/atoms/chrome-desktop-atoms'
import { syncChromeDesktopSessionStateAtom } from '@/atoms/chrome-desktop-preview-tabs'

export function ChromeDesktopCaptureHost(): React.ReactElement | null {
  const mediaStream = useAtomValue(chromeDesktopMediaStreamAtom)
  const mediaStreamControlId = useAtomValue(chromeDesktopMediaStreamControlAtom)
  const setSessionState = useSetAtom(syncChromeDesktopSessionStateAtom)
  const cleanupStream = useSetAtom(cleanupChromeDesktopStreamAtom)
  const stopControl = useSetAtom(stopChromeDesktopControlAtom)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  streamRef.current = mediaStream

  const sessionState = useAtomValue(chromeDesktopSessionStateAtom)
  const latestControlRef = useRef<{ sessionId: string; controlId: string } | null>(null)
  latestControlRef.current = sessionState ? { sessionId: sessionState.sessionId, controlId: sessionState.controlId } : null
  const latestStreamControlIdRef = useRef<string | null>(mediaStreamControlId)
  latestStreamControlIdRef.current = mediaStreamControlId
  const unmountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 1. 同步 MediaStream 至隐藏的 video 元素
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    if (mediaStream) {
      video.srcObject = mediaStream
      video.play().catch((err) => {
        console.warn('[ChromeDesktopCaptureHost] video.play() 失败:', err)
      })

      // 监听 track ended 事件（例如用户在系统层面关闭共享或窗口被销毁）
      const tracks = mediaStream.getVideoTracks()
      const handleTrackEnded = (): void => {
        console.warn('[ChromeDesktopCaptureHost] 预览轨道已终止，原生连接继续保留')
        cleanupStream(mediaStream)
      }

      tracks.forEach((track) => {
        track.addEventListener('ended', handleTrackEnded)
      })

      return () => {
        tracks.forEach((track) => {
          track.removeEventListener('ended', handleTrackEnded)
        })
      }
    } else {
      video.srcObject = null
    }
  }, [mediaStream, mediaStreamControlId, cleanupStream])

  // 2. 监听主进程状态广播
  useEffect(() => {
    if (unmountTimerRef.current !== null) clearTimeout(unmountTimerRef.current)
    if (!window.electronAPI?.chromeDesktop) return

    // 初始化时先拉取一次状态；广播一旦到达，就不让较旧快照覆盖它。
    let mounted = true
    let receivedBroadcast = false
    window.electronAPI.chromeDesktop.getState().then((state) => {
      if (mounted && !receivedBroadcast) setSessionState(state)
    }).catch(console.error)

    const unsubscribe = window.electronAPI.chromeDesktop.onStateChanged((state) => {
      receivedBroadcast = true
      setSessionState(state)
      // 终止/错误或不保留授权的 paused 才释放 MediaStream；USER_PAUSED 保留资源但不自动恢复输入。
      const owner = latestControlRef.current
      const replaced = owner && (owner.sessionId !== state.sessionId || owner.controlId !== state.controlId)
      const unrecoverablePause = state.state === 'paused' && !retainsChromeDesktopAuthorization(state.pauseReason)
      if (state.state === 'stopped' || state.state === 'error' || unrecoverablePause || replaced) {
        const streamOwner = latestStreamControlIdRef.current
        if (streamOwner && (streamOwner === state.controlId || (replaced && streamOwner === owner?.controlId))) {
          cleanupStream(streamOwner)
        }
      }
    })

    return () => {
      mounted = false
      unsubscribe()
      // React StrictMode 会立即重建 effect；延迟一拍仅在宿主真实卸载时停止 control。
      const control = latestControlRef.current
      const expectedStream = streamRef.current
      unmountTimerRef.current = setTimeout(() => {
        if (control) void stopControl(control)
        if (expectedStream) cleanupStream(expectedStream)
      }, 0)
    }
  }, [setSessionState, cleanupStream, stopControl])

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted
      style={{
        position: 'fixed',
        left: -9999,
        top: -9999,
        width: 1,
        height: 1,
        opacity: 0,
        pointerEvents: 'none',
      }}
    />
  )
}
