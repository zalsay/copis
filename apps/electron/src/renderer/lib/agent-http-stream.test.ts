import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { AgentQueueMessageInput } from '@copis/shared'
import { AgentHttpStreamClient } from './agent-http-stream'
import { setHttpApiWebToken } from './http-api-web-token'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  setHttpApiWebToken('')
})

function installFetch(fetchMock: typeof originalFetch): void {
  globalThis.fetch = fetchMock
}

function queueInput(): AgentQueueMessageInput {
  return {
    sessionId: 'session/1',
    userMessage: '继续处理',
    rawUserMessage: '/skill:automation 继续处理',
    uuid: 'message-1',
    mentionedSkills: ['automation'],
  }
}

describe('AgentHttpStreamClient queue', () => {
  test('preload 注入令牌后 Agent 请求携带认证头', async () => {
    setHttpApiWebToken('preload-agent-token')
    installFetch(Object.assign(
      mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get('x-copis-web-token')).toBe('preload-agent-token')
        return new Response(JSON.stringify({ accepted: true, uuid: 'message-1' }), { status: 202 })
      }),
      { preconnect: originalFetch.preconnect },
    ))
    await expect(new AgentHttpStreamClient().queue(queueInput())).resolves.toBe('message-1')
  })
  test('Given queue 请求成功 When服务端确认 Then返回消息 UUID 并发送正确请求', async () => {
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://127.0.0.1:4321/api/agent/sessions/session%2F1/queue')
      expect(init?.method).toBe('POST')
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json', Accept: 'application/json' })
      expect(JSON.parse(String(init?.body))).toEqual(queueInput())
      return new Response(JSON.stringify({ accepted: true, uuid: 'message-1' }), { status: 202 })
    })
    installFetch(Object.assign(fetchMock, { preconnect: originalFetch.preconnect }))

    const client = new AgentHttpStreamClient()
    client.setBaseUrl('http://127.0.0.1:4321/')

    await expect(client.queue(queueInput())).resolves.toBe('message-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('Given queue 服务端返回错误 When调用 Then抛出服务端错误', async () => {
    installFetch(Object.assign(
      mock(async () => new Response(JSON.stringify({ error: 'Agent 会话未运行' }), { status: 409 })),
      { preconnect: originalFetch.preconnect },
    ))

    const client = new AgentHttpStreamClient()
    await expect(client.queue(queueInput())).rejects.toThrow('Agent 会话未运行')
  })

  test('Given queue 响应缺少确认字段 When调用 Then拒绝非法响应', async () => {
    installFetch(Object.assign(
      mock(async () => new Response(JSON.stringify({ uuid: 'message-1' }), { status: 202 })),
      { preconnect: originalFetch.preconnect },
    ))

    const client = new AgentHttpStreamClient()
    await expect(client.queue(queueInput())).rejects.toThrow('Agent queue 响应不正确')
  })
})
