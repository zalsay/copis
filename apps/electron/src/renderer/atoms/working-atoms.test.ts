import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { agentWorkspacesAtom } from './agent-atoms'
import {
  createWorkspaceDialogOpenAtom,
  openCreateWorkspaceDialogAtom,
  workingAuthStateAtom,
} from './working-atoms'
import { workingPaymentStateAtom } from './working-payment-atoms'

describe('Working 创建工作区入口', () => {
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
