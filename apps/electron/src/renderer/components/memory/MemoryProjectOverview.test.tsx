import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { AgentWorkspace } from '@copis/shared'
import { memoryDefaultPolicyAtom, memoryProjectStatsAtom } from '@/atoms/memory-atoms'
import { MemoryProjectOverview } from './MemoryProjectOverview'

const workspace: AgentWorkspace = {
  id: 'workspace-a',
  slug: 'project-a',
  name: 'Copis',
  createdAt: 1,
  updatedAt: 1,
}

describe('Memory 全部项目概览 BDD', () => {
  test('Given 项目存在归档条目 When 展示概览 Then 显示归档数量', () => {
    const store = createStore()
    store.set(memoryDefaultPolicyAtom, 'writable')
    store.set(memoryProjectStatsAtom, {
      [workspace.id]: { userCount: 2, workspaceCount: 3, archivedCount: 4 },
    })

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <MemoryProjectOverview workspaces={[workspace]} selectedWorkspaceId={workspace.id} onSelectWorkspace={() => undefined} />
      </Provider>,
    )

    expect(html).toContain('用户 2 · 项目 3 · 归档 4')
  })
})
