import { afterEach, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { atom, createStore, Provider } from 'jotai'
import { parseHTML } from 'linkedom'
import type { DshClientEvent } from '@copis/shared'
import { unviewedDshSessionIdsAtom } from '../atoms/dsh-notifications'
import { dockBadgeCountAtom, unviewedCompletedSessionIdsAtom } from '../atoms/agent-atoms'
import { appModeAtom } from '../atoms/app-mode'
import { activeViewAtom } from '../atoms/active-view'
import { activeWebTabIdAtom } from '../atoms/web-tabs'
import { workingSettingsOpenAtom } from '../atoms/working-atoms'

const enabled = atom(true), sound = atom(true), sounds = atom({})
const notify = mock((_title: string, _body: string, _enabled: boolean, _options: { onNavigate?: () => void; playSound?: boolean }) => {})
mock.module('../atoms/notifications', () => ({ notificationsEnabledAtom: enabled, notificationSoundEnabledAtom: sound, notificationSoundsAtom: sounds, sendDesktopNotification: notify }))
const { useGlobalDshNotifications } = await import('./useGlobalDshNotifications')
const act = (React as typeof React & { act: typeof import('react-dom/test-utils').act }).act
let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; notify.mockClear() })

async function fixture() {
  const { window: win } = parseHTML('<html><body><div id="root"></div></body></html>')
  Object.assign(globalThis, { window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true })
  let focused = false
  Object.assign(win.document, { hasFocus: () => focused })
  const listeners = new Set<(event: DshClientEvent) => void>()
  const activate = mock(async (_id: string | null) => ({ tabs: [], activeTabId: null }))
  const dispatch = mock(async (_event: unknown) => true)
  Object.assign(win, { electronAPI: { webTabs: { activate }, updateSettings: async () => {}, dshCordis: { onClientEvent: (callback: (event: DshClientEvent) => void) => { listeners.add(callback); return () => { listeners.delete(callback) } }, dispatchToClient: dispatch } } })
  const store = createStore()
  const Hook = () => { useGlobalDshNotifications(); return null }
  root = createRoot(document.getElementById('root')!)
  await act(async () => root!.render(<Provider store={store}><Hook /></Provider>))
  const emit = (overrides = {}) => {
    for (const listener of listeners) listener({ type: 'COPIS_DSH_SESSION_COMPLETED', sessionId: 'dsh-a', title: '创造任务', completionSeq: 10, viewed: false, windowFocused: false, ...overrides })
  }
  return { store, emit, listeners, dispatch, activate, focus: (value: boolean) => { focused = value } }
}

test('Given 已切回 Agent 模式 When DSH 完成 Then 汇总 APP 角标且通知仅一次，查看后保留 Agent 角标', async () => {
  const f = await fixture()
  f.store.set(appModeAtom, 'agent')
  f.store.set(unviewedCompletedSessionIdsAtom, new Set(['agent-a']))
  f.emit(); f.emit()
  expect(f.store.get(dockBadgeCountAtom)).toBe(2)
  expect(notify).toHaveBeenCalledTimes(1)
  expect(notify.mock.calls[0]!.slice(0, 3)).toEqual(['创造模式任务完成', '[创造任务] 任务已完成', true])
  for (const listener of f.listeners) listener({ type: 'COPIS_DSH_SESSION_VIEWED', sessionId: 'dsh-a' })
  expect(f.store.get(dockBadgeCountAtom)).toBe(1)
  expect(f.store.get(unviewedDshSessionIdsAtom).size).toBe(0)
  await act(async () => root!.unmount()); root = undefined
  expect(f.listeners.size).toBe(0)
})

test('Given 主页面或 DSH View 在前台，或通知关闭 When 完成 Then 沿用通知与提示音开关', async () => {
  const f = await fixture()
  f.focus(true); f.emit(); expect(notify.mock.calls.at(-1)![2]).toBe(false)
  f.focus(false); f.emit({ completionSeq: 11, windowFocused: true }); expect(notify.mock.calls.at(-1)![2]).toBe(false)
  f.store.set(enabled, false); f.emit({ completionSeq: 12 });
  expect(notify.mock.calls.at(-1)![2]).toBe(false)
  expect(notify.mock.calls.at(-1)![3].playSound).toBe(false)
})

test('Given 用户点击系统完成通知 When 跳转 Then 回到创造模式对应会话并关闭遮挡页面', async () => {
  const f = await fixture()
  f.store.set(activeViewAtom, 'memory'); f.store.set(activeWebTabIdAtom, 'web-a'); f.store.set(workingSettingsOpenAtom, true)
  f.emit(); notify.mock.calls[0]![3].onNavigate!()
  expect(f.store.get(appModeAtom)).toBe('creation')
  expect(f.store.get(activeViewAtom)).toBe('conversations')
  expect(f.store.get(activeWebTabIdAtom)).toBeNull()
  expect(f.activate).toHaveBeenCalledWith(null)
  expect(f.store.get(workingSettingsOpenAtom)).toBe(false)
  expect(f.dispatch).toHaveBeenCalledWith({ type: 'COPIS_DSH_OPEN_SESSION', sessionId: 'dsh-a' })
})
