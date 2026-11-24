import { beforeEach, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { DSH_CORDIS_IPC_CHANNELS as C } from '@copis/shared'
import { createIpcHarness } from './t2-harness'
const h = createIpcHarness()
const prepare = mock((_path: string, _owner: number) => ({ success: true, url: 'copis-file://opaque', kind: 'video', mimeType: 'video/mp4' }))
const revoke = mock((_url: string, _owner: number) => true)
const revokeAll = mock((_owner: number) => 1)
mock.module('electron', () => ({ ipcMain: h.ipcMain, BrowserWindow: { getAllWindows: () => [] } }))
mock.module('../lib/dsh-cordis-service', () => ({ getDshCordisStatus: () => ({ running: true, url: 'http://127.0.0.1:53080/' }), reloadDshCordisPlugins: async () => {}, startDshCordisServer: async () => {}, stopDshCordisServerAndWait: async () => {}, setDshStatusChangeBroadcaster: () => {} }))
mock.module('../lib/dsh-view-manager', () => ({ isDshViewSender: (id: number) => id === 42, ensureDshView: () => {}, updateDshViewBounds: () => {}, dispatchToDshClient: () => {} }))
mock.module('../lib/dsh-media-service', () => ({ prepareDshMediaPreview: prepare }))
mock.module('../lib/local-file-protocol', () => ({ revokeCopisFileUrl: revoke, revokeCopisFilesForOwner: revokeAll }))
const { registerDshIpcHandlers } = await import('../ipc/dsh.ipc')
let sender: EventEmitter & { id: number; mainFrame: { url: string } }
beforeEach(() => {
  for (const fn of [prepare, revoke, revokeAll]) fn.mockClear()
  sender = Object.assign(new EventEmitter(), { id: 42, mainFrame: { url: 'http://127.0.0.1:53080/' } })
  registerDshIpcHandlers()
})
const event = () => ({ sender, senderFrame: sender.mainFrame })

test('Given 当前 DSH 主 frame When 申请或释放媒体 Then 保留 owner 标识且仅注册一次销毁回收', async () => {
  await h.invoke(C.PREPARE_MEDIA_PREVIEW, event(), '/tmp/a.mp4')
  await h.invoke(C.PREPARE_MEDIA_PREVIEW, event(), '/tmp/b.mp3')
  expect(prepare).toHaveBeenCalledWith('/tmp/a.mp4', 42)
  expect(sender.listenerCount('destroyed')).toBe(1)
  expect(sender.listenerCount('render-process-gone')).toBe(1)
  expect(sender.listenerCount('did-start-navigation')).toBe(1)
  await h.invoke(C.RELEASE_MEDIA_PREVIEW, event(), 'copis-file://opaque')
  expect(revoke).toHaveBeenCalledWith('copis-file://opaque', 42)
  sender.emit('did-start-navigation', {}, 'http://127.0.0.1:53080/#view', true, true)
  expect(revokeAll).not.toHaveBeenCalled()
  sender.emit('did-start-navigation', {}, 'http://127.0.0.1:53080/', false, true)
  expect(revokeAll).toHaveBeenCalledWith(42)
  sender.emit('destroyed'); expect(revokeAll).toHaveBeenCalledWith(42)
})
test('Given 普通窗口、跨源导航或子 frame When 申请媒体 Then 拒绝且不调用文件服务', async () => {
  sender.id = 43
  await expect(Promise.resolve(h.invoke(C.PREPARE_MEDIA_PREVIEW, event(), '/tmp/a.mp4'))).rejects.toThrow('仅允许当前创造模式')
  sender.id = 42; sender.mainFrame.url = 'https://example.com/'
  await expect(Promise.resolve(h.invoke(C.PREPARE_MEDIA_PREVIEW, event(), '/tmp/a.mp4'))).rejects.toThrow('仅允许当前创造模式')
  sender.mainFrame.url = 'http://127.0.0.1:53080/'
  await expect(Promise.resolve(h.invoke(C.PREPARE_MEDIA_PREVIEW, { sender, senderFrame: { url: sender.mainFrame.url } }, '/tmp/a.mp4'))).rejects.toThrow('仅允许当前创造模式')
  expect(prepare).not.toHaveBeenCalled()
})
