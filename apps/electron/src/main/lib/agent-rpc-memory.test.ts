import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@copis/shared'
import {
  buildRpcMemoryTurn,
  shouldCaptureRpcRun,
} from './agent-rpc-memory'

function assistantMessage(text: string): SDKMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  } as unknown as SDKMessage
}

const baseRun = {
  sessionId: 'session-1',
  userMessage: '以后项目都使用中文注释',
  workspaceSlug: 'project-a',
  memoryPolicy: 'writable' as const,
  triggeredBy: 'user' as const,
}

describe('Agent RPC Memory 回合判定', () => {
  test('Given RPC 成功回合 When读取已持久化消息 Then构造可捕获的 workspace turn', () => {
    expect(shouldCaptureRpcRun({ stoppedByUser: false, resultSubtype: 'success' })).toBe(true)
    expect(buildRpcMemoryTurn(baseRun, [assistantMessage('收到，后续按此约定执行。')])).toEqual({
      sessionId: 'session-1',
      workspaceSlug: 'project-a',
      userInput: '以后项目都使用中文注释',
      assistantReply: '收到，后续按此约定执行。',
      autonomous: false,
      memoryPolicy: 'writable',
    })
  })

  test('Given RPC 错误/中止/compact/无工作区 When判断 Then不进入自动捕获', () => {
    expect(shouldCaptureRpcRun({ stoppedByUser: true, resultSubtype: 'success' })).toBe(false)
    expect(shouldCaptureRpcRun({ stoppedByUser: false, resultSubtype: 'error_during_execution' })).toBe(false)
    expect(shouldCaptureRpcRun({ stoppedByUser: false, resultSubtype: 'success', compactRequest: true })).toBe(false)
    expect(buildRpcMemoryTurn({ ...baseRun, workspaceSlug: undefined }, [assistantMessage('不应写入')])).toBeUndefined()
    expect(buildRpcMemoryTurn(baseRun, [{ type: 'result', subtype: 'success' } as unknown as SDKMessage])).toBeUndefined()
  })

  test('Given自动任务成功回合 When构造捕获 turn Then标记为 autonomous', () => {
    expect(buildRpcMemoryTurn({ ...baseRun, triggeredBy: 'automation' }, [assistantMessage('任务已完成。')])).toMatchObject({
      autonomous: true,
    })
  })
})
