import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { McpCard } from './McpCard'

describe('McpCard 内置来源标签与图标 BDD', () => {
  test('Given 内置 MCP When 展示来源标签 Then 使用与 Skill 卡片一致的 Copis 内置样式', () => {
    const html = renderToStaticMarkup(
      <McpCard
        name="图片生成"
        entry={{ type: 'stdio', command: 'Copis 运行时注入', enabled: true, isBuiltin: true }}
        onOpen={() => undefined}
      />,
    )

    expect(html).toContain('lucide-shield-check')
    expect(html).toContain('bg-primary/10')
    expect(html).toContain('text-primary')
    expect(html).toContain('Copis 内置')
    expect(html).not.toContain('bg-blue-500/10')
    expect(html).not.toContain('> 内置</span>')
  })

  test('Given MCP 卡片 When 渲染 Plug 图标 Then 采用主题色 bg-primary/10 text-primary 且不再使用蓝色', () => {
    const html = renderToStaticMarkup(
      <McpCard
        name="测试 MCP"
        entry={{ type: 'stdio', command: 'test-cmd', enabled: true }}
        onOpen={() => undefined}
      />,
    )

    expect(html).toContain('lucide-plug')
    expect(html).toContain('bg-primary/10')
    expect(html).toContain('text-primary')
    expect(html).not.toContain('bg-blue-500')
    expect(html).not.toContain('text-blue-500')
  })
})
