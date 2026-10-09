import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { agentWorkspacesAtom } from './agent-atoms'
import {
  createWorkspaceDialogOpenAtom,
  openCreateWorkspaceDialogAtom,
  workingAuthLifecycleEpochAtom,
  workingAuthStateAtom,
} from './working-atoms'
import { workingPaymentStateAtom } from './working-payment-atoms'

describe('Working 创建工作区入口', () => {
  test('auth atom同actor快照保持代次，身份A→B→A每次在写入边界递增', () => {
    const store = createStore()
    const accountA = { authenticated: true, backendUrl: 'https://edu-api.example.test', user: { id: 'a', isVip: false } }
    store.set(workingAuthStateAtom, accountA)
    const snapshotEpoch = store.get(workingAuthLifecycleEpochAtom)
    store.set(workingAuthStateAtom, { ...accountA, user: { id: 'a', isVip: true } })
    expect(store.get(workingAuthLifecycleEpochAtom)).toBe(snapshotEpoch)
    store.set(workingAuthStateAtom, { authenticated: true, backendUrl: 'https://edu-api.example.test', user: { id: 'b' } })
    expect(store.get(workingAuthLifecycleEpochAtom)).toBe(snapshotEpoch + 1)
    store.set(workingAuthStateAtom, accountA)
    expect(store.get(workingAuthStateAtom)?.user?.id).toBe('a')
    expect(store.get(workingAuthLifecycleEpochAtom)).toBe(snapshotEpoch + 2)
  })
  test('workingAuthStateAtom仍保留普通Jotai updater API', () => {
    const store = createStore()
    store.set(workingAuthStateAtom, { authenticated: true, backendUrl: 'https://edu-api.example.test', user: { id: 'a' } })
    store.set(workingAuthStateAtom, (current) => current?.user ? { ...current, user: { ...current.user, isVip: true } } : current)
    expect(store.get(workingAuthStateAtom)?.user?.isVip).toBe(true)
    expect(store.get(workingAuthLifecycleEpochAtom)).toBe(1)
  })
  test('Given 非 VIP 仍有可用工作区额度 When 请求创建工作区 Then 打开目录选择弹窗', () => {
    const store = createStore()
    store.set(workingAuthStateAtom, {
      authenticated: true,
      backendUrl: 'https://edu-api.example.test',
      user: { id: 7, isVip: false },
    })
    store.set(agentWorkspacesAtom, [
      { id: 'default', slug: 'default', name: '默认工作区', createdAt: 1, updatedAt: 1 },
    ])

    store.set(openCreateWorkspaceDialogAtom, 'sidebar')

    expect(store.get(createWorkspaceDialogOpenAtom)).toBe(true)
    expect(store.get(workingPaymentStateAtom).open).toBe(false)
  })

  test('Given 非 VIP 已达到工作区数量上限 When 请求创建工作区 Then 直接打开 VIP 支付弹窗', () => {
    const store = createStore()
    store.set(workingAuthStateAtom, {
      authenticated: true,
      backendUrl: 'https://edu-api.example.test',
      user: { id: 7, isVip: false },
    })
    store.set(agentWorkspacesAtom, [
      { id: 'default', slug: 'default', name: '默认工作区', createdAt: 1, updatedAt: 1 },
      { id: 'workspace-1', slug: 'workspace-1', name: '第一个项目', createdAt: 1, updatedAt: 1 },
    ])

    store.set(openCreateWorkspaceDialogAtom, 'sidebar')

    expect(store.get(createWorkspaceDialogOpenAtom)).toBe(false)
    expect(store.get(workingPaymentStateAtom)).toMatchObject({ open: true, mode: 'vip' })
  })
})
