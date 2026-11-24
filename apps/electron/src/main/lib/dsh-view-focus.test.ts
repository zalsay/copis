import { beforeEach, expect, mock, test } from 'bun:test'
const focus = mock(() => {})
const contents = { isDestroyed: () => false, focus, session: { protocol: { handle: () => {} } }, setWindowOpenHandler: () => {}, on: () => {}, send: () => {}, loadURL: async () => {}, close: () => {} }
mock.module('electron', () => ({ WebContentsView: class { webContents = contents; setBounds() {}; setVisible() {} }, nativeTheme: { shouldUseDarkColors: false }, shell: {} }))
mock.module('./settings-service', () => ({ getSettings: () => ({ themeMode: 'light' }) }))
mock.module('./local-file-protocol', () => ({ handleCopisFileRequest: () => {} }))
const { setDshHostWindow, ensureDshView, updateDshViewBounds, dispatchToDshClient, destroyDshView } = await import('./dsh-view-manager')
beforeEach(() => {
  destroyDshView(); focus.mockClear()
  setDshHostWindow({ isDestroyed: () => false, contentView: { addChildView: () => {}, removeChildView: () => {} } } as any)
  ensureDshView('http://127.0.0.1:53080/')
  updateDshViewBounds({ x: 0, y: 0, width: 800, height: 600, visible: false })
})

test('Given DSH 隐藏在 Agent 模式后 When 点击通知再显示 DSH Then 焦点在实际显示后交给 DSH 并且只交付一次', () => {
  dispatchToDshClient({ type: 'COPIS_DSH_OPEN_SESSION', sessionId: 'a' })
  expect(focus).not.toHaveBeenCalled()
  updateDshViewBounds({ x: 0, y: 0, width: 800, height: 600, visible: true })
  expect(focus).toHaveBeenCalledTimes(1)
  updateDshViewBounds({ x: 0, y: 0, width: 900, height: 600, visible: true })
  expect(focus).toHaveBeenCalledTimes(1)
})

test('Given DSH 已可见 When 点击通知 Then 立即聚焦，而普通主题事件不抢焦点', () => {
  updateDshViewBounds({ x: 0, y: 0, width: 800, height: 600, visible: true })
  dispatchToDshClient({ type: 'COPIS_THEME_CHANGED' })
  expect(focus).not.toHaveBeenCalled()
  dispatchToDshClient({ type: 'COPIS_DSH_OPEN_SESSION', sessionId: 'a' })
  expect(focus).toHaveBeenCalledTimes(1)
})
