import { describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { AgentWorkspace, MemoryEntry, MemoryStats } from '@copis/shared'
import { agentWorkspacesAtom, currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import {
  memoryDefaultPolicyAtom,
  memoryEntriesAtom,
  memoryMaintenanceStateAtom,
  memoryPolicyAtom,
  memoryStatsAtom,
  memoryWorkspaceSlugAtom,
} from '@/atoms/memory-atoms'

mock.module('./MemoryList', () => ({
  MemoryList: () => <div data-testid="memory-list" />,
}))
mock.module('./MemoryEditor', () => ({
  MemoryEditor: () => <div data-testid="memory-editor" />,
}))
mock.module('@/lib/memory-api', () => ({
  MemoryApiError: class MemoryApiError extends Error {},
  memoryApi: {
    list: async () => ({ entries: [], total: 0, limit: 50 }),
    stats: async (): Promise<MemoryStats> => ({ userCount: 0, workspaceCount: 0, archivedCount: 0 }),
    maintenanceState: async () => null,
  },
}))
mock.module('sonner', () => ({
  toast: { error: () => undefined, success: () => undefined },
}))

const { MemoryView } = await import('./MemoryView')

function renderMemory(input: {
  workspace?: AgentWorkspace
  memoryWorkspaceSlug: string | null
  policy: 'off' | 'visible' | 'writable'
  maintenance?: { workspaceSlug: string; captureCount: number; lastConsolidatedCaptureCount: number }
}): string {
  const store = createStore()
  store.set(agentWorkspacesAtom, input.workspace ? [input.workspace] : [])
  store.set(currentAgentWorkspaceIdAtom, input.workspace?.id ?? null)
  store.set(memoryWorkspaceSlugAtom, input.memoryWorkspaceSlug)
  store.set(memoryPolicyAtom, input.policy)
  store.set(memoryDefaultPolicyAtom, input.policy)
  store.set(memoryEntriesAtom, [] as MemoryEntry[])
  store.set(memoryStatsAtom, { userCount: 0, workspaceCount: 0, archivedCount: 0 })
  if (input.maintenance) store.set(memoryMaintenanceStateAtom, input.maintenance)

  return renderToStaticMarkup(
    <Provider store={store}>
      <MemoryView />
    </Provider>,
  )
}

describe('Memory 页面 BDD', () => {
  test('Given 当前工作区 When 打开 Memory 页面 Then 显示工作区范围、策略和维护状态', () => {
    const html = renderMemory({
      workspace: { id: 'workspace-a', slug: 'workspace-a', name: 'A 项目', createdAt: 1, updatedAt: 1 },
      memoryWorkspaceSlug: 'workspace-a',
      policy: 'writable',
      maintenance: { workspaceSlug: 'workspace-a', captureCount: 10, lastConsolidatedCaptureCount: 10 },
    })

    expect(html).toContain('当前工作区：workspace-a')
    expect(html).toContain('记忆：可写')
    expect(html).toContain('维护 10/10')
  })

  test('Given 没有工作区 When 打开 Memory 页面 Then 只显示用户记忆并可关闭自动记忆', () => {
    const html = renderMemory({ memoryWorkspaceSlug: null, policy: 'off' })

    expect(html).toContain('当前仅显示用户记忆')
    expect(html).toContain('记忆：关闭')
    expect(html).not.toContain('当前工作区：')
  })
})
