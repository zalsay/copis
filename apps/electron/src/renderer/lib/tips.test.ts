import { expect, test } from 'bun:test'
import { TIPS } from './tips'

test('Cmd/Ctrl+K 提示与 Agent 上下文压缩语义一致', () => {
  expect(TIPS.find((tip) => tip.id === 'mac-shortcut-clear')?.text).toBe('按 ⌘K 压缩当前 Agent 会话上下文')
  expect(TIPS.find((tip) => tip.id === 'win-shortcut-clear')?.text).toBe('按 Ctrl+K 压缩当前 Agent 会话上下文')
})
