import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { appModeAtom, creationModeSkipConfirmAtom, dshCordisStatusAtom, normalizeAppMode, setAppModeAndRuntimeAtom } from './app-mode'
import { agentRuntimeAtom } from './agent-atoms'

describe('DSH 会话模式', () => {
  test('Given 旧模式或异常值 When 恢复 Then 均归一为 creation', () => {
    for (const value of ['agent', 'creation', 'dsh', 'ptc', 'unknown', null, undefined, 123]) {
      expect(normalizeAppMode(value)).toBe('creation')
    }
  })
  test('Given 旧调用尝试切换 Agent When 写入模式 Then 保持 DSH 并持久化', () => {
    const store = createStore()
    const calls: unknown[] = []
    const originalWindow = globalThis.window
    ;(globalThis as any).window = { electronAPI: { updateSettings: async (updates: unknown) => { calls.push(updates) } } }
    try {
      store.set(setAppModeAndRuntimeAtom, 'agent')
      expect(store.get(appModeAtom)).toBe('creation')
      expect(store.get(agentRuntimeAtom)).toBe('dsh')
      expect(calls).toEqual([{ appMode: 'creation' }])
    } finally {
      ;(globalThis as any).window = originalWindow
    }
  })
  test('Given 新配置 When 初始化 Then DSH 未运行且确认偏好关闭', () => {
    const store = createStore()
    expect(store.get(dshCordisStatusAtom).running).toBe(false)
    expect(store.get(creationModeSkipConfirmAtom)).toBe(false)
  })
})
