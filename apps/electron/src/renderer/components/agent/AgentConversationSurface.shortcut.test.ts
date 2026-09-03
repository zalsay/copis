import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./AgentConversationSurface.tsx', import.meta.url), 'utf8')

test('Given Cmd/Ctrl+K When Agent 会话激活 Then 使用 Pi compact 处理上下文', () => {
  const listener = "window.addEventListener('copis:clear-context', handler)"
  const listenerIndex = source.indexOf(listener)

  expect(listenerIndex).toBeGreaterThan(-1)
  expect(source.slice(Math.max(0, listenerIndex - 300), listenerIndex)).toContain('handleCompact()')
})

test('Given 会话曾切换到 DeepSeek When 选择内置模型 Then 覆盖 per-session 渠道 Map 并持久化渠道/模型', () => {
  const channelMapWrite = 'map.set(sessionId, COPIS_WORKING_CHANNEL_ID)'
  const noopGuard = 'if (nextMode === workingMode && agentChannelId === COPIS_WORKING_CHANNEL_ID) return'
  const persistentCall = 'window.electronAPI.updateSessionWorkingMode(sessionId, nextMode, option.channelId, option.modelId)'

  const channelMapIndex = source.indexOf(channelMapWrite)
  const noopGuardIndex = source.indexOf(noopGuard)
  const persistentCallIndex = source.indexOf(persistentCall)

  expect(channelMapIndex).toBeGreaterThan(-1)
  expect(noopGuardIndex).toBeGreaterThan(channelMapIndex)
  expect(persistentCallIndex).toBeGreaterThan(noopGuardIndex)
})

test('Given AI浏览器中的紧凑 Composer When 渲染工具栏 Then 保留高级授权开关', () => {
  const compactConditionStart = source.indexOf('...(compact ? [] : [')
  const compactConditionEnd = source.indexOf(']),', compactConditionStart)
  const advancedAuthorizationStart = source.indexOf("key: 'advanced-authorization'")

  expect(compactConditionStart).toBeGreaterThan(-1)
  expect(compactConditionEnd).toBeGreaterThan(compactConditionStart)
  expect(advancedAuthorizationStart).toBeGreaterThan(compactConditionEnd)
})

test('Given AgentConversationSurface When 渲染 Composer Then 绑定 inputHistory 并支持记录输入历史', () => {
  expect(source).toContain('composerInputHistory')
  expect(source).toContain('inputHistory={composerInputHistory}')
  expect(source).toContain('setGlobalInputHistory((prev) => appendHistoryEntry(prev, effectiveText))')
})

test('Given hideStarterChips 为 true（如 Agent 问答） When 渲染 Composer Then 抑制快捷入口 NewSessionFeatureChips', () => {
  expect(source).toContain('hideStarterChips?: boolean')
  expect(source).toContain('!streaming && !hideStarterChips ?')

  const questionViewSource = readFileSync(new URL('./AgentQuestionView.tsx', import.meta.url), 'utf8')
  expect(questionViewSource).toContain('hideStarterChips')
})
