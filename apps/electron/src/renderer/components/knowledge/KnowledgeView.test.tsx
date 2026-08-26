import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider } from 'jotai'
import { TooltipProvider } from '@/components/ui/tooltip'
import { KnowledgeNav } from './KnowledgeNav'
import { KnowledgeView } from './KnowledgeView'
import { agentWorkspacesAtom } from '@/atoms/agent-atoms'

describe('知识库独立功能页面 BDD', () => {
  test('Given 知识库左侧分栏 When 渲染 KnowledgeNav Then 显示智能摄取、项目知识库、全局知识库与导出导航', () => {
    const html = renderToStaticMarkup(
      <KnowledgeNav page="ingest" onPageChange={() => undefined} />,
    )

    expect(html).toContain('资料智能摄取')
    expect(html).toContain('项目知识库')
    expect(html).toContain('全局知识库')
    expect(html).toContain('导出知识库')
  })

  test('Given 打开知识库视图 When 初始渲染 Then 默认呈现资料智能摄取并支持三大模式', () => {
    const html = renderToStaticMarkup(
      <Provider>
        <TooltipProvider>
          <KnowledgeView />
        </TooltipProvider>
      </Provider>,
    )

    expect(html).toContain('知识库')
    expect(html).toContain('资料智能摄取')
    expect(html).toContain('文档智能抽取 (PDF/Word/Office)')
    expect(html).toContain('网页链接抓取 (URL)')
    expect(html).toContain('结构化文件导入 (JSON/Markdown)')
  })
})
