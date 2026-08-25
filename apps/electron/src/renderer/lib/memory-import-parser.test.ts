import { describe, expect, test } from 'bun:test'
import {
  parseJsonImport,
  parseMarkdownImport,
  parseMemoryImportFile,
} from './memory-import-parser'

describe('Memory Import Parser 测试', () => {
  test('Given 标准导出 JSON When 解析 Then 提取完整条目与标签', () => {
    const jsonStr = JSON.stringify({
      schemaVersion: 1,
      exportedAt: 1700000000000,
      entries: [
        {
          title: '前端架构',
          content: 'Vue 3 + Vite',
          kind: 'project',
          tags: ['vue', 'frontend'],
        },
        {
          title: '设计决策',
          content: '采用 SQLite 管理本地数据',
          kind: 'decision',
          tags: ['db', 'sqlite'],
        },
      ],
    })

    const items = parseJsonImport(jsonStr)
    expect(items).toHaveLength(2)
    expect(items[0]!).toEqual({
      title: '前端架构',
      content: 'Vue 3 + Vite',
      kind: 'project',
      tags: ['vue', 'frontend'],
    })
    expect(items[1]!.kind).toBe('decision')
  })

  test('Given 带分级标题和标签的 Markdown When 解析 Then 拆分为结构化原子条目', () => {
    const mdStr = `
# [project] 项目规范
前端必须采用 Vue 3 构建。
Tags: vue,规范

## [decision] 状态管理方案
我们全部采用 Jotai 来实现。 #jotai #state

### 临时笔记
当前还在评估新的 UI 方案。
Tags: ui
`

    const items = parseMarkdownImport(mdStr)
    expect(items).toHaveLength(3)
    expect(items[0]!).toEqual({
      title: '项目规范',
      content: '前端必须采用 Vue 3 构建。',
      kind: 'project',
      tags: ['vue', '规范'],
    })
    expect(items[1]!.kind).toBe('decision')
    expect(items[1]!.tags).toContain('jotai')
    expect(items[1]!.tags).toContain('state')
    expect(items[2]!.kind).toBe('fact')
    expect(items[2]!.tags).toContain('ui')
  })

  test('Given QM Bullet 列表 Markdown When 解析 Then 逐行抽取事实与标签', () => {
    const mdStr = `
- [fact] 部署端口：本地开发默认固定为 5173 #dev #port
- [preference] 编码偏好：优先使用中文注释和日志
- [decision] 记忆存储：采用 SQLite 本地存储
`

    const items = parseMarkdownImport(mdStr)
    expect(items).toHaveLength(3)
    expect(items[0]!.title).toBe('部署端口')
    expect(items[0]!.content).toBe('本地开发默认固定为 5173')
    expect(items[0]!.kind).toBe('fact')
    expect(items[0]!.tags).toEqual(['dev', 'port'])

    expect(items[1]!.title).toBe('编码偏好')
    expect(items[1]!.content).toBe('优先使用中文注释和日志')
    expect(items[1]!.kind).toBe('preference')

    expect(items[2]!.kind).toBe('decision')
  })

  test('Given 文件名后缀 When 使用 parseMemoryImportFile Then 正确分发到对应解析器', () => {
    const jsonStr = JSON.stringify([{ title: '测试', content: '内容', kind: 'fact' }])
    const jsonItems = parseMemoryImportFile(jsonStr, 'export.json')
    expect(jsonItems).toHaveLength(1)

    const mdStr = '## 标题\n内容'
    const mdItems = parseMemoryImportFile(mdStr, 'notes.md')
    expect(mdItems).toHaveLength(1)
  })
})
