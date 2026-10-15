/**
 * ChromeDesktopCaptureHost — 全局 Chrome 窗口采集宿主
 *
 * 挂载于主窗口根节点，负责持有当前授权的 MediaStream，并在接收到主进程的
 * 截帧请求时利用隐藏的 `<video>` 与 `<canvas>` 按规格提取单帧 JPEG base64。
 *
 * 规范约束与审查改进：
 * - 单帧按需提取，最长边不超过 1600px，JPEG 编码且不超过 1 MiB。
 * - 多阶梯度降质与降采样，确保编码绝对不突破 1 MiB，仍超限则明确报错而非外发违规大图。
 * - 绑定 requestId 严格串行化与关联，防止旧请求迟到帧干扰新 Observe。
 * - 结合 requestVideoFrameCallback 校验视频源帧呈现新鲜度。
 * - 捕获轨道异常终止（track.onended）、暂停（paused）、停止（stopped）时彻底释放资源并重置帧状态。
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
const COMPRESSION_QUALITIES = [0.85, 0.7, 0.55, 0.4]
const COMPRESSION_SCALES = [1.0, 0.8, 0.6]

export function ChromeDesktopCaptureHost(): React.ReactElement | null {
  const mediaStream = useAtomValue(chromeDesktopMediaStreamAtom)
  const setSessionState = useSetAtom(chromeDesktopSessionStateAtom)
  const cleanupStream = useSetAtom(cleanupChromeDesktopStreamAtom)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  streamRef.current = mediaStream

  // 跟踪当前活跃的 requestId，防止迟到帧串入新请求
  const activeRequestIdRef = useRef<string | null>(null)
  const lastPresentedTimeRef = useRef<number>(0)

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
        activeRequestIdRef.current = null
        lastPresentedTimeRef.current = 0
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
      activeRequestIdRef.current = null
      lastPresentedTimeRef.current = 0
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
      // stopped, error 或 paused 均立即断开活动流与帧引用，不持有陈旧截屏
      if (state.state === 'stopped' || state.state === 'error' || state.state === 'paused') {
        activeRequestIdRef.current = null
        lastPresentedTimeRef.current = 0
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
      const { controlId, requestId } = req
      activeRequestIdRef.current = requestId

      const video = videoRef.current
      if (!video || !streamRef.current) {
        if (activeRequestIdRef.current === requestId) {
          window.electronAPI.chromeDesktop.sendFrameResponse({
            controlId,
            requestId,
            width: 0,
            height: 0,
            capturedAt: Date.now(),
            data: '',
            error: 'CHROME_CAPTURE_FAILED: 采集视频流不可用',
          })
        }
        return
      }

      // 等待视频元数据就绪（最多 300ms）
      if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
        let retries = 0
        while ((video.readyState < 2 || video.videoWidth === 0) && retries < 6) {
          await new Promise((r) => setTimeout(r, 50))
          retries++
          if (activeRequestIdRef.current !== requestId) return
        }
        if (video.readyState < 2 || video.videoWidth === 0) {
          if (activeRequestIdRef.current === requestId) {
            window.electronAPI.chromeDesktop.sendFrameResponse({
              controlId,
              requestId,
              width: 0,
              height: 0,
              capturedAt: Date.now(),
              data: '',
              error: 'CHROME_CAPTURE_FAILED: 视频帧尚未准备就绪',
            })
          }
          return
        }
      }

      // 结合 requestVideoFrameCallback 等待源帧刷新（最多 350ms）
      let captureTimestamp = Date.now()
      if (typeof (video as any).requestVideoFrameCallback === 'function') {
        await new Promise<void>((resolve) => {
          let done = false
          const timer = setTimeout(() => {
            if (!done) {
              done = true
              resolve()
            }
          }, 350)

          ;(video as any).requestVideoFrameCallback((now: number, metadata: any) => {
            if (!done) {
              done = true
              clearTimeout(timer)
              const frameTime = metadata.presentedFrames ? metadata.presentedFrames : now
              lastPresentedTimeRef.current = frameTime
              captureTimestamp = Date.now()
              resolve()
            }
          })
        })
      }

      if (activeRequestIdRef.current !== requestId) {
        // 请求已被新请求取代，丢弃本次中间结果
        return
      }

      try {
        const origW = video.videoWidth
        const origH = video.videoHeight

        // 计算最长边不超过 1600px 的基础缩放尺寸
        let baseW = origW
        let baseH = origH
        if (baseW > MAX_FRAME_DIMENSION || baseH > MAX_FRAME_DIMENSION) {
          if (baseW >= baseH) {
            baseH = Math.round((baseH * MAX_FRAME_DIMENSION) / baseW)
            baseW = MAX_FRAME_DIMENSION
          } else {
            baseW = Math.round((baseW * MAX_FRAME_DIMENSION) / baseH)
            baseH = MAX_FRAME_DIMENSION
          }
        }

        if (!canvasRef.current) {
          canvasRef.current = document.createElement('canvas')
        }
        const canvas = canvasRef.current
        const ctx = canvas.getContext('2d', { alpha: false })
        if (!ctx) {
          throw new Error('无法创建 Canvas 2D 绘图上下文')
        }

        let chosenBase64: string | null = null
        let chosenW = baseW
        let chosenH = baseH

        // 梯度压缩循环：递减分辨率与质量，保证最终产物绝对不超过 1 MiB
        outerLoop: for (const scale of COMPRESSION_SCALES) {
          const curW = Math.max(100, Math.round(baseW * scale))
          const curH = Math.max(100, Math.round(baseH * scale))
          canvas.width = curW
          canvas.height = curH
          ctx.drawImage(video, 0, 0, curW, curH)

          for (const quality of COMPRESSION_QUALITIES) {
            const dataUrl = canvas.toDataURL('image/jpeg', quality)
            const commaIdx = dataUrl.indexOf(',')
            const rawBase64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl

            if (rawBase64.length <= MAX_BASE64_LENGTH) {
              chosenBase64 = rawBase64
              chosenW = curW
              chosenH = curH
              break outerLoop
            }
          }
        }

        if (!chosenBase64) {
          throw new Error('CHROME_CAPTURE_FAILED: 单帧编码大小超过 1 MiB 上限，已达最低压缩阈值')
        }

        if (activeRequestIdRef.current === requestId) {
          window.electronAPI.chromeDesktop.sendFrameResponse({
            controlId,
            requestId,
            width: chosenW,
            height: chosenH,
            capturedAt: captureTimestamp,
            data: chosenBase64,
          })
        }
      } catch (err: any) {
        console.error('[ChromeDesktopCaptureHost] 截帧失败:', err)
        if (activeRequestIdRef.current === requestId) {
          window.electronAPI.chromeDesktop.sendFrameResponse({
            controlId,
            requestId,
            width: 0,
            height: 0,
            capturedAt: Date.now(),
            data: '',
            error: err.message.startsWith('CHROME_') ? err.message : `CHROME_CAPTURE_FAILED: ${err.message}`,
          })
        }
      }
    })

    return () => {
      unsubscribe()
    }
  }, [cleanupStream])

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
