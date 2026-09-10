import { expect, mock, test } from 'bun:test'
import { SETTINGS_IPC_CHANNELS as C } from '../../types'
import { createIpcHarness } from './t2-harness'

const h = createIpcHarness()
const ownSend = mock(() => undefined)
const otherSend = mock(() => undefined)
const nativeOn = mock(() => undefined)
let fail = false
const updateSettings = mock((updates: object) => {
  if (fail) throw new Error('写入失败')
  return updates
})
const filtered = { hiddenSidebarMenuItems: ['test'] }
const filter = mock(() => filtered)
mock.module('electron', () => ({ ipcMain: h.ipcMain, app: {}, nativeTheme: { on: nativeOn }, BrowserWindow: { getAllWindows: () => [
  { webContents: { id: 1, send: ownSend } }, { webContents: { id: 2, send: otherSend } },
] } }))
mock.module('../lib/settings-service', () => ({ getSettings: () => ({}), updateSettings }))
mock.module('../lib/user-profile-service', () => ({ getUserProfile: () => ({}), updateUserProfile: () => ({}) }))
mock.module('../lib/dsh-cordis-service', () => ({ syncCopisModelConfigToDsh: async () => {} }))
mock.module('../lib/dsh-view-manager', () => ({ syncThemeToDshView: () => {}, syncHiddenSidebarMenuItemsToDshView: () => {} }))
mock.module('../lib/theme-sync', () => ({ syncNativeThemeSource: () => {}, resolveIsDark: () => false }))
mock.module('../lib/dsh-model-config', () => ({ shouldSyncDshCopisDefaults: () => false }))
mock.module('../lib/tutorial-service', () => ({ getTutorialContent: () => '' }))
mock.module('../lib/dock-badge-service', () => ({ setDockBadgeCount: () => true }))
mock.module('../lib/feishu-sleep-blocker', () => ({ syncFeishuSyncSleepBlocker: () => {} }))
mock.module('../lib/working-model-catalog-access', () => ({ getWorkingModelCatalogAccess: () => ({ isVip: false, ownerId: 'owner' }) }))
mock.module('../lib/working-model-catalog', () => ({ filterWorkingModelCatalogUpdate: filter, redactWorkingModelCatalog: (value: unknown) => value }))

test('Given 同步设置保存 When 更新 Then 先过滤权限并同步返回，仅向其他窗口广播', async () => {
  const { registerSettingsIpcHandlers } = await import('../ipc/settings.ipc')
  registerSettingsIpcHandlers()
  const event = { sender: { id: 1 }, returnValue: undefined as unknown }
  const updates = { hiddenSidebarMenuItems: ['test'], workingCustomModels: ['secret'] }
  expect(h.emit(C.UPDATE_SYNC, event, updates)).toBeUndefined()
  expect(event.returnValue).toBe(true)
  expect(filter).toHaveBeenCalledWith(updates, false, 'owner')
  expect(updateSettings).toHaveBeenCalledWith(filtered)
  expect(ownSend).not.toHaveBeenCalled()
  expect(otherSend).toHaveBeenCalledWith(C.ON_HIDDEN_SIDEBAR_MENU_ITEMS_CHANGED, ['test'])
  expect(nativeOn).toHaveBeenCalledTimes(1)
  fail = true
  h.emit(C.UPDATE_SYNC, event, updates)
  expect(event.returnValue).toBe(false)
})
