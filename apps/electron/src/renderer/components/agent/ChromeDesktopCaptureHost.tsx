/**
 * ChromeDesktopCaptureHost — 全局 Chrome 窗口采集宿主
 *
 * 挂载于主窗口根节点，负责持有当前授权的 MediaStream，并在接收到主进程的
 * 截帧请求时利用隐藏的 `<video>` 与 `<canvas>` 按规格提取单帧 JPEG base64。
 *
 * 规范约束：
 * - 单帧按需提取，最长边不超过 1600px，JPEG 编码且不超过 1 MiB。
 * - 捕获轨道异常终止（track.onended）时向主进程汇报 STREAM_ERROR 并释放控制。
 * - 仅驻留内存，绝不将视频流或连续帧持久化至磁盘。
 */

import React, { useEffect, useRef } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  chromeDesktopMediaStreamAtom,
  chromeDesktopSessionStateAtom,
  cleanupChromeDesktopStreamAtom,
} from '@/atoms/chrome-desktop-atoms'

const MAX_FRAME_DIMENSION = 1600
const MAX_BASE64_LENGTH = 1_350_000 // ~1 MiB raw bytes

export function ChromeDesktopCaptureHost(): React.ReactElement | null {
  const mediaStream = useAtomValue(chromeDesktopMediaStreamAtom)
  const setSessionState = useSetAtom(chromeDesktopSessionStateAtom)
  const cleanupStream = useSetAtom(cleanupChromeDesktopStreamAtom)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  streamRef.current = mediaStream

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
        console.warn('[ChromeDesktopCaptureHost] 视频采集轨道已终止')
        window.electronAPI?.chromeDesktop?.sendStreamError({
          reason: 'CHROME_CAPTURE_FAILED',
          message: 'Chrome 窗口视频采集轨道已终止',
        })
        cleanupStream()
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
  }, [mediaStream, cleanupStream])

  // 2. 监听主进程状态广播
  useEffect(() => {
    if (!window.electronAPI?.chromeDesktop) return

    // 初始化时先拉取一次状态
    window.electronAPI.chromeDesktop.getState().then((state) => {
      setSessionState(state)
    }).catch(console.error)

    const unsubscribe = window.electronAPI.chromeDesktop.onStateChanged((state) => {
      setSessionState(state)
      if (state.state === 'stopped' || state.state === 'error') {
        cleanupStream()
      }
    })

    return () => {
      unsubscribe()
    }
  }, [setSessionState, cleanupStream])

  // 3. 监听截帧请求 (REQUEST_FRAME)
  useEffect(() => {
    if (!window.electronAPI?.chromeDesktop) return

    const unsubscribe = window.electronAPI.chromeDesktop.onRequestFrame(async (req) => {
      const video = videoRef.current
      if (!video || !streamRef.current) {
        window.electronAPI.chromeDesktop.sendFrameResponse({
          controlId: req.controlId,
          width: 0,
          height: 0,
          capturedAt: Date.now(),
          data: '',
          error: 'CHROME_CAPTURE_FAILED: 采集视频流不可用',
        })
        return
      }

      // 等待视频元数据就绪（最多 300ms）
      if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
        let retries = 0
        while ((video.readyState < 2 || video.videoWidth === 0) && retries < 6) {
          await new Promise((r) => setTimeout(r, 50))
          retries++
        }
        if (video.readyState < 2 || video.videoWidth === 0) {
          window.electronAPI.chromeDesktop.sendFrameResponse({
            controlId: req.controlId,
            width: 0,
            height: 0,
            capturedAt: Date.now(),
            data: '',
            error: 'CHROME_CAPTURE_FAILED: 视频帧尚未准备就绪',
          })
          return
        }
      }

      try {
        const origW = video.videoWidth
        const origH = video.videoHeight

        // 计算最长边不超过 1600px 的缩放尺寸
        let targetW = origW
        let targetH = origH
        if (targetW > MAX_FRAME_DIMENSION || targetH > MAX_FRAME_DIMENSION) {
          if (targetW >= targetH) {
            targetH = Math.round((targetH * MAX_FRAME_DIMENSION) / targetW)
            targetW = MAX_FRAME_DIMENSION
          } else {
            targetW = Math.round((targetW * MAX_FRAME_DIMENSION) / targetH)
            targetH = MAX_FRAME_DIMENSION
          }
        }

        if (!canvasRef.current) {
          canvasRef.current = document.createElement('canvas')
        }
        const canvas = canvasRef.current
        canvas.width = targetW
        canvas.height = targetH

        const ctx = canvas.getContext('2d', { alpha: false })
        if (!ctx) {
          throw new Error('无法创建 Canvas 2D 绘图上下文')
        }

        ctx.drawImage(video, 0, 0, targetW, targetH)

        // 尝试默认 0.85 质量
        let quality = 0.85
        let dataUrl = canvas.toDataURL('image/jpeg', quality)

        // 若超出 1 MiB，递减质量或进一步缩放
        if (dataUrl.length > MAX_BASE64_LENGTH) {
          quality = 0.65
          dataUrl = canvas.toDataURL('image/jpeg', quality)
        }

        if (dataUrl.length > MAX_BASE64_LENGTH) {
          // 仍然超限，降低尺寸重绘
          targetW = Math.round(targetW * 0.75)
          targetH = Math.round(targetH * 0.75)
          canvas.width = targetW
          canvas.height = targetH
          ctx.drawImage(video, 0, 0, targetW, targetH)
          dataUrl = canvas.toDataURL('image/jpeg', 0.6)
        }

        // 提取纯 base64 数据
        const commaIdx = dataUrl.indexOf(',')
        const base64Data = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl

        window.electronAPI.chromeDesktop.sendFrameResponse({
          controlId: req.controlId,
          width: targetW,
          height: targetH,
          capturedAt: Date.now(),
          data: base64Data,
        })
      } catch (err: any) {
        console.error('[ChromeDesktopCaptureHost] 截帧失败:', err)
        window.electronAPI.chromeDesktop.sendFrameResponse({
          controlId: req.controlId,
          width: 0,
          height: 0,
          capturedAt: Date.now(),
          data: '',
          error: `CHROME_CAPTURE_FAILED: ${err.message}`,
        })
      }
    })

    return () => {
      unsubscribe()
    }
  }, [])

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
