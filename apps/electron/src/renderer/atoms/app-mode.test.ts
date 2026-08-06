import { describe, expect, test } from 'bun:test'
import { normalizeAppMode } from './app-mode'
import { sanitizePersistedTabs } from './tab-atoms'

describe('仅 Agent 模式', () => {
  test('旧 localStorage 值 chat 规范化为 agent', () => {
    expect(normalizeAppMode('chat')).toBe('agent')
    expect(normalizeAppMode('agent')).toBe('agent')
    expect(normalizeAppMode(undefined)).toBe('agent')
  })

  test('持久化状态丢弃 Chat Tab，并保留有效 Agent Tab', () => {
    const result = sanitizePersistedTabs([
      { id: 'chat-1', type: 'chat', sessionId: 'chat-1', title: '旧 Chat' },
      { id: 'agent-1', type: 'agent', sessionId: 'agent-1', title: 'Agent' },
      { id: '__preview__:agent-1', type: 'preview', sessionId: 'agent-1', title: '预览' },
    ], new Set(['agent-1']))

    expect(result).toEqual([
      { id: 'agent-1', type: 'agent', sessionId: 'agent-1', title: 'Agent' },
    ])
  })
})
