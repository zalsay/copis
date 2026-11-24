import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { MediaPreview } from '../MediaPreview'

const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

// 仅在隔离测试窗口生成无声素材，不依赖用户文件、摄像头、FFmpeg 或外部网络。
async function createVideo(width: number, height: number): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const stream = canvas.captureStream(10)
  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' })
  const chunks: BlobPart[] = []
  try {
    const recording = new Promise<Blob>((resolve, reject) => {
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
      recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }))
      recorder.onerror = () => reject(new Error('测试视频生成失败'))
    })
    recorder.start()
    canvas.getContext('2d')!.fillRect(0, 0, width, height)
    await new Promise(resolve => setTimeout(resolve, 180))
    recorder.stop()
    return URL.createObjectURL(await recording)
  } finally {
    if (recorder.state !== 'inactive') recorder.stop()
    stream.getTracks().forEach(track => track.stop())
  }
}

async function runLayoutCases() {
  const pane = document.getElementById('pane')!
  const body = document.getElementById('body')!
  const root = createRoot(body)
  const cases = []
  const controller = new AbortController()
  let currentUrl: string | undefined
  try {
    for (const [width, height] of [[160, 288], [288, 160]]) {
      currentUrl = await createVideo(width, height)
      const url = currentUrl
      const ready = new Promise<void>((resolve, reject) => {
        root.render(<MediaPreview
          resourceAddress={`file://test/${width}x${height}.mp4`}
          content={{ kind: 'renderer', revision: width, loaded: () => resolve(), failed: () => reject(new Error('测试素材未加载')), reload() {} }}
          useResource={() => ({ status: 'live', value: { absolutePath: `/test/${width}.mp4`, version: String(width) } })}
          useTabInfo={() => ({ tab: { visible: true, signal: controller.signal } })}
          bridge={{ prepareMediaPreview: async () => ({ success: true, url, kind: 'video', mimeType: 'video/webm' }), releaseMediaPreview: async value => { URL.revokeObjectURL(value); return true } }}
        />)
      })
      await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('测试元数据超时')), 8000))])
      const media = body.querySelector('video')!
      if (media.videoWidth !== width || media.videoHeight !== height) throw new Error('测试素材原始比例不一致')
      for (const [paneWidth, paneHeight] of [[640, 720], [280, 200], [900, 180], [280, 540]]) {
        pane.style.width = `${paneWidth}px`
        pane.style.height = `${paneHeight}px`
        await tick()
        const container = body.getBoundingClientRect()
        const preview = body.querySelector<HTMLElement>('[data-copis-media-preview]')!.getBoundingClientRect()
        const video = media.getBoundingClientRect()
        cases.push({
          source: [width, height], pane: [paneWidth, paneHeight],
          body: [container.width, container.height], preview: [preview.width, preview.height],
          video: [video.width, video.height],
          inside: video.left >= container.left && video.top >= container.top && video.right <= container.right + 1 && video.bottom <= container.bottom + 1,
          noOverflow: body.scrollWidth <= body.clientWidth + 1 && body.scrollHeight <= body.clientHeight + 1,
          fit: getComputedStyle(media).objectFit,
          sameElement: body.querySelector('video') === media, sameSource: media.getAttribute('src') === url,
          controls: media.controls, paused: media.paused,
        })
      }
    }
    return cases
  } finally {
    root.unmount()
    controller.abort()
    if (currentUrl) URL.revokeObjectURL(currentUrl)
  }
}

Object.assign(window, { runLayoutCases })
