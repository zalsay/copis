import { beforeEach, expect, mock, test } from 'bun:test'
const focus = mock(() => {})
const setBounds = mock((_bounds: { x: number; y: number; width: number; height: number }) => {})
const setVisible = mock((_visible: boolean) => {})
let zoomFactor = 1
let contentWidth = 900
let contentHeight = 600
const mainFrame = { url:'http://127.0.0.1:53080/',send:mock(() => {}) }
const contents = { mainFrame, isDestroyed: () => false, focus, session: { protocol: { handle: () => {} } }, setWindowOpenHandler: () => {}, on: () => {}, send: () => {}, loadURL: async () => {}, close: () => {} }
mock.module('electron', () => ({ WebContentsView: class { webContents = contents; setBounds = setBounds; setVisible = setVisible }, nativeTheme: { shouldUseDarkColors: false }, shell: {} }))
mock.module('./settings-service', () => ({ getSettings: () => ({ themeMode: 'light' }) }))
mock.module('./local-file-protocol', () => ({ handleCopisFileRequest: () => {} }))
const { setDshHostWindow, ensureDshView, updateDshViewBounds, dispatchToDshClient, destroyDshView } = await import('./dsh-view-manager')
beforeEach(() => {
  destroyDshView()
  focus.mockClear()
  setBounds.mockClear()
  setVisible.mockClear()
  zoomFactor = 1
  contentWidth = 900
  contentHeight = 600
  setDshHostWindow({
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 100, y: 100, width: contentWidth, height: contentHeight }),
    webContents: { getZoomFactor: () => zoomFactor },
    contentView: { addChildView: () => {}, removeChildView: () => {} },
  } as any)
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

test('Given 主窗口页面缩小 When DSH 占满页签下方 Then 原生视图底边不超出窗口内容区', () => {
  zoomFactor = 0.8
  updateDshViewBounds({ x: 0, y: 40, width: 1125, height: 710, visible: true })
  expect(setBounds).toHaveBeenLastCalledWith({ x: 0, y: 32, width: 900, height: 568 })
})

test('Given 窗口收窄且宿主旧尺寸尚未更新 When 应用 DSH 位置 Then 不裁掉视图内的底部菜单', () => {
  contentWidth = 800
  contentHeight = 580
  updateDshViewBounds({ x: 0, y: 32, width: 900, height: 568, visible: true })
  expect(setBounds).toHaveBeenLastCalledWith({ x: 0, y: 32, width: 800, height: 548 })
})

test('Given 主窗口页面放大 When 打开 Copis 子视图 Then 只按缩放后的实际侧栏宽度保留 DSH', () => {
  zoomFactor = 1.25
  updateDshViewBounds({ x: 0, y: 32, width: 280, height: 448, visible: true })
  expect(setBounds).toHaveBeenLastCalledWith({ x: 0, y: 40, width: 350, height: 560 })
  updateDshViewBounds({ x: 0, y: 480, width: 280, height: 40, visible: true })
  expect(setVisible).toHaveBeenLastCalledWith(false)
})


test('群目录快照只发给当前仍在 DSH 源站的主 frame', () => {
  const snapshot = {type:'COPIS_SHARED_ROOM_SIDEBAR',rooms:[{id:'r',name:'测试群'}]}
  const trusted = 'http://127.0.0.1:53080/'
  mainFrame.send.mockClear()
  mainFrame.url = 'https://example.invalid/'
  expect(dispatchToDshClient(snapshot,trusted)).toBe(false)
  expect(mainFrame.send).not.toHaveBeenCalled()
  mainFrame.url = trusted
  expect(dispatchToDshClient(snapshot,trusted)).toBe(true)
  expect(mainFrame.send).toHaveBeenCalledTimes(1)
})
