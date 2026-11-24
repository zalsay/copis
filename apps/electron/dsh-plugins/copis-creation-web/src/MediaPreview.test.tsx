import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { parseHTML } from 'linkedom'
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MediaPreview, registerMediaPreview, type MediaPreviewProps } from './MediaPreview'
const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act
let root: Root | null
let controller: AbortController
const release = mock(async (_url: string) => true)
const prepare = mock(async (path: string) => ({ success: true as const, url: 'copis-file://opaque-'+path.slice(-3), kind: path.endsWith('mp4') ? 'video' as const : 'audio' as const, mimeType: path.endsWith('mp4') ? 'video/mp4' : 'audio/mpeg' }))
const loaded = mock((_version: string) => {})
const failed = mock(() => {})
const pause = mock(() => {})
const load = mock(() => {})
let props: MediaPreviewProps
beforeEach(() => {
  const { window: win } = parseHTML('<html><body><div id="root"></div></body></html>')
  Object.assign(globalThis, { window: win, document: win.document, navigator: win.navigator, Event: win.Event, IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(win.HTMLElement.prototype, { pause, load })
  root = createRoot(document.getElementById('root')!)
  controller = new AbortController()
  for (const fn of [release, prepare, loaded, failed, pause, load]) fn.mockClear()
  props = { resourceAddress: 'file://fixture', content: { kind: 'renderer', revision: 1, loaded, failed, reload() {} },
    useResource: () => ({ status: 'live', value: { absolutePath: '/tmp/中文 sample.mp4', version: 'v1' } }),
    useTabInfo: () => ({ tab: { visible: true, signal: controller.signal } }), bridge: { prepareMediaPreview: prepare, releaseMediaPreview: release } }
})
afterEach(async () => { await act(async () => root?.unmount()); root = null })
const render = async () => { await act(async () => { root!.render(<MediaPreview {...props} />); await Promise.resolve() }) }

test('Given MP4 When 官方预览挂载 Then 使用原生播放器、只预载元数据且不自动播放', async () => {
  await render()
  const video = document.querySelector('video')!
  expect(!!video).toBe(true); expect(video.hasAttribute('controls')).toBe(true)
  expect(video.getAttribute('preload')).toBe('metadata'); expect(video.hasAttribute('autoplay')).toBe(false)
  expect(video.getAttribute('src')).toBe('copis-file://opaque-mp4')
  await act(async () => video.dispatchEvent(new window.Event('loadedmetadata', { bubbles: true })))
  expect(loaded).toHaveBeenCalledWith('v1')
})
test('Given MP3 When 预览 Then 使用音频而不是视频或文本', async () => {
  props.useResource = () => ({ status: 'live', value: { absolutePath: '/tmp/试听.mp3', version: 'v1' } })
  await render()
  expect(!!document.querySelector('audio[controls]')).toBe(true); expect(document.querySelector('video')).toBeNull()
})
test('Given 正在播放 When 页签隐藏或组件卸载 Then 暂停、清空 src 并撤销媒体令牌', async () => {
  await render()
  props.useTabInfo = () => ({ tab: { visible: false, signal: controller.signal } })
  await render()
  expect(pause).toHaveBeenCalled(); expect(load).toHaveBeenCalled()
  expect(release).toHaveBeenCalledWith('copis-file://opaque-mp4')
  expect(document.querySelector('video')).toBeNull()
})
test('Given 路径切换 When 同一预览组件展示另一个文件 Then 先释放旧 URL 并加载新文件', async () => {
  await render()
  props.useResource = () => ({ status: 'live', value: { absolutePath: '/tmp/next.mp3', version: 'v2' } })
  await render()
  expect(release).toHaveBeenCalledWith('copis-file://opaque-mp4'); expect(!!document.querySelector('audio')).toBe(true)
})
test('Given 请求返回前关闭页签 When 令牌随后到达 Then 立即释放且不挂载过期播放器', async () => {
  let resolve!: (value: any) => void
  props.bridge = { prepareMediaPreview: () => new Promise(r => { resolve = r }), releaseMediaPreview: release }
  await render()
  await act(async () => root!.unmount()); root = null
  await act(async () => resolve({ success: true, url: 'copis-file://late', kind: 'audio', mimeType: 'audio/mpeg' }))
  expect(release).toHaveBeenCalledWith('copis-file://late')
})
test('Given 文件或编码不能播放 When 收到 error Then 给出中文错误、不再占用流并结束加载', async () => {
  await render()
  await act(async () => document.querySelector('video')!.dispatchEvent(new window.Event('error')))
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('无法播放')
  expect(failed).toHaveBeenCalled(); expect(release).toHaveBeenCalledWith('copis-file://opaque-mp4')
})
test('Given 不在桌面或文件不存在 When 打开预览 Then 友好失败而不抛出 React 错误', async () => {
  props.bridge = undefined; await render()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Copis')
  props.bridge = { prepareMediaPreview: async () => ({ success: false, error: '文件不存在' }), releaseMediaPreview: release }
  await render()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('文件不存在')
})
test('Given 已失效桥同步抛错 When 挂载或清理 Then 友好失败且不产生 React 生命周期异常', async () => {
  props.bridge = { prepareMediaPreview: () => { throw new Error('released frame') }, releaseMediaPreview: release }
  await render()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('读取失败')
  expect(failed).toHaveBeenCalled()
})
test('Given 官方 tab signal 结束 When body 尚未卸载 Then 仍立即停止并释放令牌', async () => {
  await render(); await act(async () => controller.abort())
  expect(pause).toHaveBeenCalled(); expect(release).toHaveBeenCalledWith('copis-file://opaque-mp4')
})
test('Given Copis 插件注册 When 扩展官方文档预览 Then 仅注册二进制 MP4/MP3 renderer 且具备销毁回收', () => {
  const definitions: any[] = [], slots: any[] = [], disposers: any[] = []
  registerMediaPreview({ effect: fn => { disposers.push(fn()) }, documentPreviews: { register: d => { definitions.push(d); return () => definitions.pop() } }, slots: { inject: (_n, fn) => fn(), register: d => { slots.push(d); return () => slots.pop() } } }, () => undefined)
  expect(definitions[0]).toMatchObject({ extensions: ['mp4', 'mp3'], binaryExtensions: ['mp4', 'mp3'], loading: 'renderer', priority: 'extension' })
  expect(slots[0].name).toBe('sidebar.right.tab.document'); expect(slots[0].key).toBe(definitions[0].id)
  for (const dispose of disposers.reverse()) dispose?.()
  expect(definitions).toHaveLength(0); expect(slots).toHaveLength(0)
})
