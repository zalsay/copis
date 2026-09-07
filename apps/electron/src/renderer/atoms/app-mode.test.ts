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
})
