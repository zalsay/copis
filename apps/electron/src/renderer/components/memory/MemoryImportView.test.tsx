import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentWorkspace } from '@copis/shared'
import { Provider } from 'jotai'
import { buildMemoryImportInput, MemoryImportView } from './MemoryImportView'

const workspace: AgentWorkspace = {
  id: 'workspace-a',
  slug: 'project-a',
  name: 'Copis',
  createdAt: 1,
  updatedAt: 1,
}

describe('Memory 导入页面 BDD', () => {
  test('Given 当前项目 When 打开导入页面 Then 渲染目标范围选择、分类和上传区', () => {
    const html = renderToStaticMarkup(
      <Provider>
        <MemoryImportView workspaceSlug="project-a" workspaces={[workspace]} />
      </Provider>,
    )

    expect(html).toContain('导入与沉淀知识库')
    expect(html).toContain('文档智能抽取 (PDF/Word/Office)')
    expect(html).toContain('网页链接抓取 (URL)')
    expect(html).toContain('结构化文件导入 (JSON/Markdown)')
    expect(html).toContain('当前项目（Copis）')
    expect(html).toContain('用户记忆（全局通用）')
    expect(html).toContain('事实 (fact)')
    expect(html).toContain('偏好 (preference)')
    expect(html).toContain('决策 (decision)')
    expect(html).toContain('项目 (project)')
    expect(html).toContain('点击或拖拽文档到此处（PDF / Word / Office / TXT）')
  })

  test('Given 构造工作区导入请求 When 执行 buildMemoryImportInput Then 返回符合规范的请求体', () => {
    const input = buildMemoryImportInput('current-workspace', 'project-a', [
      {
        title: '前端架构',
        content: 'Vue 3 + Vite',
        kind: 'project',
        tags: ['vue'],
      },
    ])

    expect(input).toEqual({
      scope: 'workspace',
      workspaceSlug: 'project-a',
      items: [
        {
          title: '前端架构',
          content: 'Vue 3 + Vite',
          kind: 'project',
          tags: ['vue'],
        },
      ],
    })
  })

  test('Given 构造全局用户导入请求 When 执行 buildMemoryImportInput Then scope 为 user 且无 workspaceSlug', () => {
    const input = buildMemoryImportInput('user', 'project-a', [
      {
        title: '个人偏好',
        content: '使用深色模式',
        kind: 'preference',
      },
    ])

    expect(input).toEqual({
      scope: 'user',
      workspaceSlug: undefined,
      items: [
        {
          title: '个人偏好',
          content: '使用深色模式',
          kind: 'preference',
        },
      ],
    })
  })
})
