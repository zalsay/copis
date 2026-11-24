import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { DshMediaPreviewResult } from '@copis/shared'

export interface MediaPreviewBridge {
  prepareMediaPreview?: (path: string) => Promise<DshMediaPreviewResult>
  releaseMediaPreview?: (url: string) => Promise<boolean>
}
export interface MediaPreviewProps {
  resourceAddress: string
  content: { kind: 'renderer'; revision: number; loaded: (version: string) => void; failed: () => void; reload: () => void }
  useResource: (address: string) => { status: string; value?: { absolutePath?: string; version?: string } }
  useTabInfo: () => { tab: { visible: boolean; signal: AbortSignal } }
  bridge?: MediaPreviewBridge
}

type MediaState = { status: 'loading' } | { status: 'failed'; error: string } | { status: 'ready'; media: Extract<DshMediaPreviewResult, { success: true }> }

function stopMedia(element: HTMLMediaElement | null): void {
  if (!element?.hasAttribute('src')) return
  element.pause()
  element.removeAttribute('src')
  element.load()
}

/** 内容由当前 tab 的 Resource 定位，URL 只存在于组件生命周期中。 */
export function MediaPreview({ resourceAddress, content, useResource, useTabInfo, bridge }: MediaPreviewProps): ReactElement | null {
  const meta = useResource(resourceAddress)
  const { tab } = useTabInfo()
  const path = meta.value?.absolutePath
  const version = meta.value?.version
  const prepare = bridge?.prepareMediaPreview
  const release = bridge?.releaseMediaPreview
  const [state, setState] = useState<MediaState>({ status: 'loading' })
  const element = useRef<HTMLMediaElement | null>(null)
  const lease = useRef<{ url: string; version: string } | null>(null)
  const reported = useRef(false)
  const callbacks = useRef(content)
  callbacks.current = content
  const disposeRef = useRef<() => void>(() => {})
  const bindElement = useCallback((node: HTMLMediaElement | null) => {
    // React 会先清除 ref 再执行被动 effect 清理，因此在 ref 释放时也停止解码。
    if (element.current !== node) stopMedia(element.current)
    element.current = node
  }, [])

  useEffect(() => {
    setState({ status: 'loading' })
    reported.current = false
    disposeRef.current = () => {}
    if (!tab.visible || tab.signal.aborted) return
    const fail = (error: string) => { setState({ status: 'failed', error }); callbacks.current.failed() }
    if (!prepare || !release) { fail('音视频预览需要在 Copis 桌面应用中打开'); return }
    if (!path) {
      if (meta.status !== 'loading') fail('媒体文件不存在或无法定位')
      return
    }
    let active = true
    let url: string | undefined
    const releaseUrl = (value: string) => { void Promise.resolve().then(() => release(value)).catch(() => {}) }
    const dispose = () => {
      if (!active) return
      active = false
      stopMedia(element.current)
      if (url) {
        if (lease.current?.url === url) lease.current = null
        releaseUrl(url)
      }
    }
    disposeRef.current = dispose
    tab.signal.addEventListener('abort', dispose, { once: true })
    void Promise.resolve().then(() => prepare(path)).then(result => {
      if (!active) { if (result.success) releaseUrl(result.url); return }
      if (result.success === false) { fail(result.error); return }
      url = result.url
      lease.current = { url, version: version ?? String(content.revision) }
      setState({ status: 'ready', media: result })
    }).catch(() => { if (active) fail('媒体文件读取失败，请重试') })
    return () => { tab.signal.removeEventListener('abort', dispose); dispose() }
  }, [resourceAddress, content.revision, path, version, meta.status, tab.visible, tab.signal, prepare, release])

  useEffect(() => {
    const pauseWhenHidden = () => { if (document.hidden) element.current?.pause() }
    document.addEventListener('visibilitychange', pauseWhenHidden)
    return () => document.removeEventListener('visibilitychange', pauseWhenHidden)
  }, [])

  if (!tab.visible) return null
  const onLoadedMetadata = () => {
    if (state.status !== 'ready' || lease.current?.url !== state.media.url || reported.current) return
    reported.current = true
    callbacks.current.loaded(lease.current.version)
  }
  const onError = () => {
    disposeRef.current()
    setState({ status: 'failed', error: '无法播放此文件，文件可能已删除或媒体编码不受支持' })
    callbacks.current.failed()
  }
  // 以官方文档内容区为边界收缩，不能用整个窗口的 vh 限制侧栏播放器。
  return <div data-copis-media-preview style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, width: '100%', height: '100%', minWidth: 0, minHeight: 0, overflow: 'hidden', whiteSpace: 'normal', boxSizing: 'border-box', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)' }}>
    {state.status === 'loading' && <p role="status">正在加载媒体…</p>}
    {state.status === 'failed' && <><p role="alert">{state.error}</p><button type="button" onClick={() => callbacks.current.reload()}>重试</button></>}
    {state.status === 'ready' && (state.media.kind === 'video'
      ? <video key={state.media.url} ref={bindElement} src={state.media.url} controls playsInline preload="metadata" aria-label="MP4 视频预览" onLoadedMetadata={onLoadedMetadata} onError={onError} style={{ flex: '1 1 0', width: '100%', height: '100%', minWidth: 0, minHeight: 0, objectFit: 'contain', background: '#000', borderRadius: 8 }} />
      : <audio key={state.media.url} ref={bindElement} src={state.media.url} controls preload="metadata" aria-label="MP3 音频预览" onLoadedMetadata={onLoadedMetadata} onError={onError} style={{ width: '100%', minWidth: 0, flexShrink: 0 }} />)}
  </div>
}

export interface MediaPreviewContext {
  effect: (register: () => unknown) => unknown
  documentPreviews: { register: (definition: { id: string; extensions: string[]; binaryExtensions: string[]; priority: 'extension'; title: () => string; loading: 'renderer' }) => () => void }
  slots: {
    inject: (name: string, register: () => unknown) => unknown
    register: (definition: { name: string; key?: string }, component: (props: MediaPreviewProps) => ReactElement | null) => unknown
  }
}

/** 通过官方扩展点挂载，不改写 DSH bundle 或替换整个右侧栏。 */
export function registerMediaPreview(ctx: MediaPreviewContext, getBridge: () => MediaPreviewBridge | undefined): void {
  const id = '@copis-ext/creation-web/media'
  ctx.effect(() => ctx.documentPreviews.register({ id, extensions: ['mp4', 'mp3'], binaryExtensions: ['mp4', 'mp3'], priority: 'extension', title: () => '音视频', loading: 'renderer' }))
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
    { name: 'sidebar.right.tab.document', key: id }, props => <MediaPreview {...props} bridge={getBridge()} />,
  )))
}
