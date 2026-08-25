import { describe, expect, test } from 'bun:test'
import { buildPiAgentMailTools, PiAgentMailToolClient } from './pi-agent-mail-tool'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function testSdk(): {
  sdk: typeof import('@earendil-works/pi-coding-agent')
  definitions: Array<{ name?: string; parameters?: unknown; execute?: (toolCallId: string, params: unknown) => Promise<unknown> }>
} {
  const definitions: Array<{ name?: string; parameters?: unknown; execute?: (toolCallId: string, params: unknown) => Promise<unknown> }> = []
  const sdk = {
    defineTool: <T>(definition: T): T => {
      definitions.push(definition as typeof definitions[number])
      return definition
    },
  } as unknown as typeof import('@earendil-works/pi-coding-agent')
  return { sdk, definitions }
}

describe('Pi agent-mail tool capability', () => {
  test('Given a Worker token When agent_mail executes auth.status Then it sends request to Rust HTTP API endpoint', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const client = new PiAgentMailToolClient({
      sessionId: 'mail-session-1',
      token: 'file-token-123',
      baseUrl: 'http://127.0.0.1:51730',
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init })
        return jsonResponse({ ok: true, data: { logged_in: true } })
      },
    })

    const result = await client.execute({ action: 'auth.status' })

    expect(requests[0]?.url).toBe('http://127.0.0.1:51730/api/internal/agent/agent-mail')
    expect(requests[0]?.init?.headers).toEqual({
      'Content-Type': 'application/json',
      'x-copis-agent-file-token': 'file-token-123',
    })
    expect(result).toEqual({ ok: true, data: { logged_in: true } })
  })

  test('Given defined tool When execute is called Then result is formatted as AgentToolResult', async () => {
    const { sdk, definitions } = testSdk()

    buildPiAgentMailTools(sdk, {
      sessionId: 'session-1',
      token: 'worker-secret',
      baseUrl: 'http://127.0.0.1:51730',
      fetchImpl: async (_url, _init) => {
        return jsonResponse({
          ok: true,
          data: {
            aliases: [{ email: 'test@agent.qq.com', is_primary: true }],
          },
        })
      },
    })

    expect(definitions).toHaveLength(1)
    expect(definitions[0]?.name).toBe('agent_mail')

    const executeResult = (await definitions[0]!.execute!('call-1', {
      action: 'me',
    })) as { content: Array<{ text: string }> }

    expect(executeResult.content[0]?.text).toContain('test@agent.qq.com')
  })
})
