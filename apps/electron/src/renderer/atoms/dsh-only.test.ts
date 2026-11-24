import { expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { appModeAtom, normalizeAppMode, setAppModeAndRuntimeAtom } from './app-mode'
import { agentRuntimeAtom } from './agent-atoms'

test('Given 旧模式或未知值 When 恢复或切换 Then 只进入 DSH', () => {
  for (const mode of ['agent', 'creation', 'dsh', null, 'invalid']) expect(normalizeAppMode(mode)).toBe('creation')
  const store = createStore()
  store.set(appModeAtom, 'agent')
  expect(store.get(appModeAtom)).toBe('creation')
  store.set(setAppModeAndRuntimeAtom, 'agent')
  expect(store.get(agentRuntimeAtom)).toBe('dsh')
})
