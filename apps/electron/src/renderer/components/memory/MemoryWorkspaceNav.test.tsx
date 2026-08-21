import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryWorkspaceNav } from './MemoryWorkspaceNav'

describe('Memory 页面导航 BDD', () => {
  test('Given 打开 Memory 页面 When 查看侧栏 Then 不显示 MEMORY 分组标题并保留导航项', () => {
    const html = renderToStaticMarkup(
      <MemoryWorkspaceNav page="current" onPageChange={() => undefined} />,
    )

    expect(html).not.toMatch(/>Memory<\//)
    expect(html).toContain('当前项目')
    expect(html).toContain('全部项目')
    expect(html).toContain('全局设置')
    expect(html).toContain('导出记忆')
  })
})
