import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import {
  normalizeAppMode,
  appModeAtom,
  creationModeSkipConfirmAtom,
  setAppModeAndRuntimeAtom,
  dshCordisStatusAtom,
} from './app-mode'
import { agentRuntimeAtom } from './agent-atoms'

describe('appModeAtom & setAppModeAndRuntimeAtom 模式与底座状态管理', () => {
  test('Given normalizeAppMode When 传入 agent Then 返回 agent', () => {
    expect(normalizeAppMode('agent')).toBe('agent')
  })

  test('Given normalizeAppMode When 传入 creation、dsh 或 ptc Then 均归一化为 creation', () => {
    expect(normalizeAppMode('creation')).toBe('creation')
    expect(normalizeAppMode('dsh')).toBe('creation')
    expect(normalizeAppMode('ptc')).toBe('creation')
  })

  test('Given normalizeAppMode When 传入非法未知值 Then 安全回退为 agent', () => {
    expect(normalizeAppMode('unknown')).toBe('agent')
    expect(normalizeAppMode(null)).toBe('agent')
    expect(normalizeAppMode(undefined)).toBe('agent')
    expect(normalizeAppMode(123)).toBe('agent')
  })

  test('Given 模式切换到 creation When 写入 setAppModeAndRuntimeAtom Then appMode 为 creation 且 agentRuntime 自动同步为 dsh', () => {
    const store = createStore()
    store.set(setAppModeAndRuntimeAtom, 'creation')

    expect(store.get(appModeAtom)).toBe('creation')
    expect(store.get(agentRuntimeAtom)).toBe('dsh')
  })

  test('Given 模式切换到 agent When 写入 setAppModeAndRuntimeAtom Then appMode 为 agent 且 agentRuntime 自动同步为 pi', () => {
    const store = createStore()
    // 先设为 creation
    store.set(setAppModeAndRuntimeAtom, 'creation')
    expect(store.get(agentRuntimeAtom)).toBe('dsh')

    // 切回 agent
    store.set(setAppModeAndRuntimeAtom, 'agent')
    expect(store.get(appModeAtom)).toBe('agent')
    expect(store.get(agentRuntimeAtom)).toBe('pi')
  })

  test('Given dshCordisStatusAtom When 初始化 Then 状态为未运行', () => {
    const store = createStore()
    const status = store.get(dshCordisStatusAtom)
    expect(status.running).toBe(false)
  })

  test('Given creationModeSkipConfirmAtom When 初始化 Then 默认为 false 允许提醒', () => {
    const store = createStore()
    expect(store.get(creationModeSkipConfirmAtom)).toBe(false)

    store.set(creationModeSkipConfirmAtom, true)
    expect(store.get(creationModeSkipConfirmAtom)).toBe(true)
  })

  test('Given 模式切换 When 触发 setAppModeAndRuntimeAtom Then 自动调用 updateSettings 异步持久化配置', async () => {
    const store = createStore()
    const savedCalls: any[] = []
    const originalWindow = (globalThis as any).window

    ;(globalThis as any).window = {
      electronAPI: {
        updateSettings: async (updates: any) => {
          savedCalls.push(updates)
          return updates
        },
      },
    }

    try {
      store.set(setAppModeAndRuntimeAtom, 'creation')
      expect(store.get(appModeAtom)).toBe('creation')
      expect(savedCalls).toHaveLength(1)
      expect(savedCalls[0]).toEqual({ appMode: 'creation' })

      store.set(setAppModeAndRuntimeAtom, 'agent')
      expect(store.get(appModeAtom)).toBe('agent')
      expect(savedCalls).toHaveLength(2)
      expect(savedCalls[1]).toEqual({ appMode: 'agent' })
    } finally {
      ;(globalThis as any).window = originalWindow
    }
  })

  test('Given 应用启动恢复流程 When 上次持久化为 creation 模式 Then 即使历史活动标签页为 agent 也必须保留 creation 模式', () => {
    const store = createStore()
    // 模拟从 settings.json 读取到的配置
    const settings = {
      appMode: 'creation',
      tabState: {
        activeTabId: 'session-123',
        tabs: [{ id: 'session-123', type: 'agent', sessionId: 'session-123', title: '旧 Agent 会话' }],
      },
    }

    // 执行 main.tsx 中的启动恢复逻辑
    const persistedMode = normalizeAppMode(settings.appMode ?? store.get(appModeAtom))
    store.set(appModeAtom, persistedMode)
    if (persistedMode === 'creation') {
      store.set(agentRuntimeAtom, 'dsh')
    } else {
      store.set(agentRuntimeAtom, 'pi')
    }

    const activeTab = settings.tabState.tabs[0]
    if (activeTab?.type === 'agent') {
      if (persistedMode !== 'creation') {
        store.set(appModeAtom, 'agent')
      }
    }

    // 验证：不会被 activeTab.type === 'agent' 强制重置回 agent
    expect(store.get(appModeAtom)).toBe('creation')
    expect(store.get(agentRuntimeAtom)).toBe('dsh')
  })

  test('Given 应用启动恢复流程 When 上次持久化为 agent 模式 Then 正常进入 agent 模式与 pi 底座', () => {
    const store = createStore()
    const settings = {
      appMode: 'agent',
      tabState: {
        activeTabId: 'session-123',
        tabs: [{ id: 'session-123', type: 'agent', sessionId: 'session-123', title: 'Agent 会话' }],
      },
    }

    const persistedMode = normalizeAppMode(settings.appMode ?? store.get(appModeAtom))
    store.set(appModeAtom, persistedMode)
    if (persistedMode === 'creation') {
      store.set(agentRuntimeAtom, 'dsh')
    } else {
      store.set(agentRuntimeAtom, 'pi')
    }

    const activeTab = settings.tabState.tabs[0]
    if (activeTab?.type === 'agent') {
      if (persistedMode !== 'creation') {
        store.set(appModeAtom, 'agent')
      }
    }

    expect(store.get(appModeAtom)).toBe('agent')
    expect(store.get(agentRuntimeAtom)).toBe('pi')
  })
})
