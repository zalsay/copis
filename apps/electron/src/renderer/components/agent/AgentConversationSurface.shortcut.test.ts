import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./AgentConversationSurface.tsx', import.meta.url), 'utf8')

test('Given Cmd/Ctrl+K When Agent 会话激活 Then 使用 Pi compact 处理上下文', () => {
  const listener = "window.addEventListener('copis:clear-context', handler)"
  const listenerIndex = source.indexOf(listener)

  expect(listenerIndex).toBeGreaterThan(-1)
  expect(source.slice(Math.max(0, listenerIndex - 300), listenerIndex)).toContain('handleCompact()')
})
