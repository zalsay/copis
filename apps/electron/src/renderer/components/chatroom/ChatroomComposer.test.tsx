import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./ChatroomComposer.tsx', import.meta.url), 'utf8')

describe('聊天室输入行为契约', () => {
  test('消息只提交结构化 Agent ID 和客户端消息 ID', () => {
    expect(source).toContain('mentionAgentIds')
    expect(source).toContain('clientMessageId')
    expect(source).not.toContain('traceId:')
    expect(source).not.toContain('parentMessageId:')
    expect(source).not.toContain('depth:')
  })
  test('离线 Agent 不会进入提及候选，也不会排队发送', () => {
    expect(source).toContain("agent.status === 'offline'")
    expect(source).toContain('消息不会排队')
  })
})
