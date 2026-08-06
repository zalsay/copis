import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentWorkspace, MemoryStats } from '@copis/shared'
import { Provider } from 'jotai'
import {
  buildMemoryExportInput,
  countAllMemoryExportEntries,
  countMemoryExportEntries,
  MemoryExportView,
} from './MemoryExportView'

const workspace: AgentWorkspace = {
  id: 'workspace-a',
  slug: 'project-a',
  name: 'Copis',
  createdAt: 1,
  updatedAt: 1,
}

describe('Memory 导出页面 BDD', () => {
  test('Given 当前项目 When 打开导出页面 Then 提供范围、格式、归档和历史选项', () => {
    const html = renderToStaticMarkup(
      <Provider>
        <MemoryExportView workspaceSlug="project-a" workspaces={[workspace]} />
      </Provider>,
    )

    expect(html).toContain('当前项目')
    expect(html).toContain('全部项目')
    expect(html).toContain('用户记忆')
    expect(html).toContain('JSON')
    expect(html).toContain('Markdown')
    expect(html).toContain('包含归档条目')
    expect(html).toContain('包含 revision history')
  })

  test('Given 项目有显示名称 When 构造导出请求 Then 同时保留 slug 标识和项目名称', () => {
    expect(buildMemoryExportInput({
      scope: 'current-workspace',
      format: 'markdown',
      includeArchived: false,
      includeHistory: true,
      workspaceSlug: 'project-a',
      workspaces: [workspace],
    })).toEqual({
      scope: 'current-workspace',
      workspaceSlug: 'project-a',
      format: 'markdown',
      includeArchived: false,
      includeHistory: true,
      workspaceNames: { 'project-a': 'Copis' },
    })
  })

  test('Given 统计包含归档条目 When 选择包含归档 Then 预览数量包含归档', () => {
    const stats: MemoryStats = { userCount: 2, workspaceCount: 3, archivedCount: 4 }
    expect(countMemoryExportEntries(stats, false)).toBe(5)
    expect(countMemoryExportEntries(stats, true)).toBe(9)
    expect(countAllMemoryExportEntries(
      { userCount: 2, workspaceCount: 0, archivedCount: 1 },
      [{ userCount: 2, workspaceCount: 3, archivedCount: 3 }],
      true,
    )).toBe(8)
  })
})
