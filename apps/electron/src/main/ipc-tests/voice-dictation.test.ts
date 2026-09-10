import { expect, mock, test } from 'bun:test'
import { VOICE_DICTATION_IPC_CHANNELS as C } from '../../types'
import { createIpcHarness } from './t2-harness'

const h = createIpcHarness()
const volume = mock(() => undefined)
const transcript = mock(() => undefined)
let destroyed = false
const order: string[] = []
mock.module('electron', () => ({ ipcMain: h.ipcMain, BrowserWindow: { fromWebContents: () => null } }))
mock.module('../index', () => ({ getMainWindow: () => ({ isDestroyed: () => destroyed, webContents: { id: 7 } }) }))
mock.module('../lib/voice-dictation-window', () => ({ updateVoiceDictationIndicatorVolume: volume, updateVoiceDictationIndicatorTranscript: transcript }))
mock.module('../lib/doubao-asr-service', () => ({ cancelDoubaoAsrSession: (id: string) => { order.push('cancel:' + id) } }))
mock.module('../lib/text-output-service', () => ({ clearVoiceDictationPreview: (id: string) => { order.push('clear:' + id) } }))
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

test('Given 语音状态上报 When 来源非主窗口或已销毁 Then 拒绝更新', async () => {
  const { registerVoiceDictationIpcHandlers } = await import('../ipc/voice-dictation.ipc')
  registerVoiceDictationIpcHandlers()
  h.emit(C.REPORT_VOLUME, { sender: { id: 8 } }, 0.5)
  h.emit(C.REPORT_TRANSCRIPT, { sender: { id: 8 } }, '拒绝')
  await flush()
  expect(volume).not.toHaveBeenCalled()
  expect(transcript).not.toHaveBeenCalled()
  h.emit(C.REPORT_VOLUME, { sender: { id: 7 } }, 'invalid')
  h.emit(C.REPORT_TRANSCRIPT, { sender: { id: 7 } }, 'a'.repeat(4001))
  await flush()
  expect(volume).toHaveBeenCalledWith(0)
  expect(transcript).toHaveBeenCalledWith('a'.repeat(4000))
  destroyed = true
  h.emit(C.REPORT_VOLUME, { sender: { id: 7 } }, 0.8)
  await flush()
  expect(volume).toHaveBeenCalledTimes(1)
})

test('Given 语音预览 When 取消 Then 先清理预览再取消识别会话', async () => {
  const { registerVoiceDictationIpcHandlers } = await import('../ipc/voice-dictation.ipc')
  registerVoiceDictationIpcHandlers()
  await h.invoke(C.CANCEL, {}, { sessionId: 'voice', previewSessionId: 'preview' })
  expect(order).toEqual(['clear:preview', 'cancel:voice'])
})
