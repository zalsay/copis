import { describe, expect, test } from 'bun:test'
import { buildPiAutomationTools } from './pi-automation-tools'

describe('Pi 定时任务工具桥', () => {
  test('Given Rust automation capability When building tools Then exposes list and create through the scoped endpoint', async () => {
    const definitions: Array<{ name: string; execute: (id: string, input: unknown) => Promise<unknown> }> = []
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const sdk = {
      defineTool: <T>(definition: T): T => {
        definitions.push(definition as typeof definitions[number])
        return definition
      },
    } as unknown as typeof import('@earendil-works/pi-coding-agent')

    buildPiAutomationTools(sdk, {
      sessionId: 'session-1',
      capability: { endpoint: '/api/internal/agent/automation-tool', token: 'capability-1' },
      baseUrl: 'http://127.0.0.1:51730',
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init })
        return new Response(JSON.stringify({ automations: [] }), { status: 200 })
      },
    })

    expect(definitions.map((definition) => definition.name)).toContain('mcp__automation__list_automations')
    expect(definitions.map((definition) => definition.name)).toContain('mcp__automation__create_automation')
    const list = definitions.find((definition) => definition.name === 'mcp__automation__list_automations')
    await list?.execute('call-1', {})
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('http://127.0.0.1:51730/api/internal/agent/automation-tool')
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      sessionId: 'session-1',
      capabilityToken: 'capability-1',
      action: 'list',
      input: {},
    })
  })
})
