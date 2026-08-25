import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const richTextInputSource = readFileSync(
  new URL('./rich-text-input.tsx', import.meta.url),
  'utf8',
)

describe('RichTextInput 上下箭头历史记录唤起契约测试 (BDD)', () => {
  test('Given 输入历史列表 When 按下 ArrowUp 且输入框为空 Then 唤起最新一条历史记录', () => {
    // 检查是否有 ArrowUp 历史导航逻辑
    expect(richTextInputSource).toContain("event.key === 'ArrowUp'")
    expect(richTextInputSource).toContain("event.key === 'ArrowDown'")
    expect(richTextInputSource).toContain('historyIndexRef.current === null')
    expect(richTextInputSource).toContain('targetIndex = history.length - 1')
    expect(richTextInputSource).toContain('applyHistoryContentRef.current?.(targetItem)')
  })

  test('Given 正在历史导航中 When 连续按 ArrowUp/ArrowDown Then 支持多级回溯并在越过最新一条时恢复草稿', () => {
    expect(richTextInputSource).toContain('historyIndexRef.current > 0')
    expect(richTextInputSource).toContain('targetIndex = historyIndexRef.current - 1')
    expect(richTextInputSource).toContain('targetIndex = historyIndexRef.current + 1')
    expect(richTextInputSource).toContain('applyDraftContentRef.current?.(draft, draftHtml)')
  })

  test('Given 正在历史导航中 When 按 Escape 键 Then 退出历史导航并恢复草稿', () => {
    expect(richTextInputSource).toContain("event.key === 'Escape'")
    expect(richTextInputSource).toContain('historyIndexRef.current !== null')
  })

  test('Given Suggestion 补全菜单处于激活状态 When 按 ArrowUp/ArrowDown Then 避让补全菜单不触发历史替换', () => {
    expect(richTextInputSource).toContain("!view.dom.querySelector('[data-decoration-id]')")
  })

  test('Given 处于 IME 输入法组合状态或带有修饰键 When 按 ArrowUp/ArrowDown Then 不触发历史替换', () => {
    expect(richTextInputSource).toContain('!isComposingRef.current &&')
    expect(richTextInputSource).toContain('!event.isComposing &&')
    expect(richTextInputSource).toContain('!event.shiftKey &&')
    expect(richTextInputSource).toContain('!event.metaKey &&')
    expect(richTextInputSource).toContain('!event.ctrlKey &&')
    expect(richTextInputSource).toContain('!event.altKey &&')
  })

  test('Given 用户手动修改了唤起的内容 When onUpdate 触发 Then 退出历史导航模式', () => {
    expect(richTextInputSource).toContain('if (isNavigatingHistoryRef.current) {')
    expect(richTextInputSource).toContain('isNavigatingHistoryRef.current = false')
    expect(richTextInputSource).toContain('historyIndexRef.current = null')
  })
})
