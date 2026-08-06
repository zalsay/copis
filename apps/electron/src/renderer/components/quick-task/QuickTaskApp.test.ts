import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const quickTaskSource = readFileSync(new URL('./QuickTaskApp.tsx', import.meta.url), 'utf8')

function getSubmitSection(): string {
  const start = quickTaskSource.indexOf('submitQuickTask')
  const end = quickTaskSource.indexOf('setText', start)
  return quickTaskSource.slice(start, end === -1 ? undefined : end)
}

describe('快速任务 Agent-only 契约', () => {
  test('Given 快速任务窗口 When 查看模式入口 Then 不提供 Chat 模式切换或 Chat 快捷键', () => {
    expect(quickTaskSource).not.toContain(['type Task', "Mode = 'chat' | 'agent'"].join(''))
    expect(quickTaskSource).not.toContain(['set', "Mode('chat')"].join(''))
    expect(quickTaskSource).not.toContain(['⌘1', ' Chat'].join(''))
    expect(quickTaskSource).not.toContain(['⌘2', ' Agent'].join(''))
    expect(quickTaskSource).not.toContain('copis-selected-model')
    expect(quickTaskSource).not.toContain('localStorage')
    expect(quickTaskSource).toContain('settings.agentChannelId')
    expect(quickTaskSource).toContain('settings.agentModelId')
  })

  test('Given 快速任务提交 When 检查 payload Then 不携带 Chat mode', () => {
    expect(getSubmitSection()).not.toMatch(/\bmode\b/)
  })

  test('Given 大附件 When 快速任务收集文件 Then 保留 Agent sourcePath 引用', () => {
    const largeFileSection = quickTaskSource.slice(
      quickTaskSource.indexOf('if (file.size > MAX_ATTACHMENT_SIZE)'),
      quickTaskSource.indexOf('// 移除附件'),
    )
    expect(largeFileSection).toContain('getPathForFile(file)')
    expect(largeFileSection).toContain('sourcePath,')
    expect(getSubmitSection()).toContain('sourcePath')
  })
})
