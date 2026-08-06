import { describe, expect, test } from 'bun:test'
import type { AgentSendInput } from '@copis/shared'
import { AgentRpcGateway } from './agent-rpc-gateway'

const input: AgentSendInput = {
  sessionId: 'session-1',
  userMessage: '生成周报',
  channelId: 'channel-1',
  agentRuntime: 'pi',
  startedAt: 100,
}

function sse(frame: object): string {
  return `data: ${JSON.stringify(frame)}\n\n`
}

describe('AgentRpcGateway', () => {
  test('Given Rust Worker SSE When主进程无头入口运行 Then转发事件、标题和完成状态', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const gateway = new AgentRpcGateway({
      baseUrl: 'http://127.0.0.1:51730',
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init })
        return new Response([
          sse({
            type: 'event',
            sessionId: 'session-1',
            payload: { kind: 'sdk_message', message: { type: 'assistant', content: '结果' } },
          }),
          sse({
            type: 'event',
            sessionId: 'session-1',
            payload: { kind: 'copis_event', event: { type: 'title_updated', title: '周报' } },
          }),
          sse({
            type: 'complete',
            sessionId: 'session-1',
            stoppedByUser: false,
            startedAt: 100,
            resultSubtype: 'success',
          }),
        ].join(''), { status: 200 })
      },
    })
    const events: string[] = []
    const titles: string[] = []
    const complete: string[] = []

    await gateway.run(input, {
      onEvent: (event) => events.push(event.payload.kind),
      onError: (error) => { throw new Error(error) },
      onTitleUpdated: (title) => titles.push(title),
      onComplete: (_messages, payload) => complete.push(`${payload?.sessionId}:${payload?.resultSubtype}`),
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('http://127.0.0.1:51730/api/agent/sessions/session-1/messages')
    expect(events).toEqual(['sdk_message', 'copis_event'])
    expect(titles).toEqual(['周报'])
    expect(complete).toEqual(['session-1:success'])
  })

  test('Given Rust Pi Worker lifecycle state When queried or stopped Then gateway does not keep an Electron state mirror', async () => {
    const requests: string[] = []
    const gateway = new AgentRpcGateway({
      baseUrl: 'http://127.0.0.1:51730',
      fetchImpl: async (url) => {
        const target = String(url)
        requests.push(target)
        if (target.endsWith('/workers/status')) return Response.json({ activeSessionIds: ['session-1', 'session-2'] })
        if (target.endsWith('/status')) return Response.json({ active: true })
        if (target.endsWith('/workers/stop-all')) return Response.json({ stopped: 2 })
        return new Response(null, { status: 404 })
      },
    })

    await expect(gateway.isActive('session-1')).resolves.toBe(true)
    await expect(gateway.activeSessionIds()).resolves.toEqual(['session-1', 'session-2'])
    await expect(gateway.hasActiveSessions()).resolves.toBe(true)
    await expect(gateway.stopAll()).resolves.toBeUndefined()
    expect(requests).toEqual([
      'http://127.0.0.1:51730/api/agent/sessions/session-1/status',
      'http://127.0.0.1:51730/api/agent/workers/status',
      'http://127.0.0.1:51730/api/agent/workers/status',
      'http://127.0.0.1:51730/api/agent/workers/stop-all',
    ])
  })

  test('Given 正在运行的会话 When queue、stop 或更新权限模式 Then仅调用 Rust API', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const gateway = new AgentRpcGateway({
      baseUrl: 'http://127.0.0.1:51730',
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init })
        if (String(url).endsWith('/queue')) {
          return Response.json({ accepted: true, uuid: 'queue-1' }, { status: 202 })
        }
        if (String(url).endsWith('/permission-mode')) return Response.json({ updated: true })
        return new Response(null, { status: 204 })
      },
    })

    await expect(gateway.queue({ sessionId: 'session-1', userMessage: '继续', uuid: 'queue-1' })).resolves.toBe('queue-1')
    await gateway.stop('session-1')
    await gateway.updatePermissionMode('session-1', 'plan', 'internal-token')

    expect(requests.map((request) => request.url)).toEqual([
      'http://127.0.0.1:51730/api/agent/sessions/session-1/queue',
      'http://127.0.0.1:51730/api/agent/sessions/session-1/stop',
      'http://127.0.0.1:51730/api/internal/agent/files/permission-mode',
    ])
    expect(requests[2]?.init?.headers).toMatchObject({ 'X-Copis-Internal-Token': 'internal-token' })
    expect(requests[2]?.init?.body).toBe(JSON.stringify({ sessionId: 'session-1', permissionMode: 'plan' }))
  })
})
