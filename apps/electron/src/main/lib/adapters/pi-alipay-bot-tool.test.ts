import { describe, expect, test } from 'bun:test'
import { buildBuiltinToolDefinitions } from './pi-agent-adapter'
import { buildPiAlipayBotTools, PiAlipayBotToolClient } from './pi-alipay-bot-tool'

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

describe('Pi alipay-bot capability', () => {
  test('Given payment Worker capability When client executes Then it only sends the dedicated payment header', async () => {
    const requests: Array<{ init?: RequestInit }> = []
    const client = new PiAlipayBotToolClient({
      sessionId: 'payment-session-1',
      token: 'payment-secret',
      capabilityHeader: 'x-copis-payment-capability',
      fetchImpl: async (_url, init) => {
        requests.push({ init })
        return jsonResponse({ ok: true })
      },
    })

    await client.execute({ action: 'wallet.check' })

    expect(requests[0]?.init?.headers).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-copis-payment-capability': 'payment-secret',
    })
  })

  test('Given a Worker token When alipay_bot executes Then it posts the fixed capability request without exposing token in the result', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const { sdk, definitions } = testSdk()

    buildPiAlipayBotTools(sdk, {
      sessionId: 'session-1',
      token: 'worker-secret',
      baseUrl: 'http://127.0.0.1:51730',
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init })
        return jsonResponse({ ok: true, code: 200, message: '已开启支付宝支付功能' })
      },
    })

    const tool = definitions.find((definition) => definition.name === 'alipay_bot')
    const result = await tool?.execute?.('call-1', { action: 'wallet.check' })

    expect(result).toMatchObject({ details: { ok: true, code: 200 } })
    expect(JSON.stringify(result)).not.toContain('worker-secret')
    expect(requests).toHaveLength(1)
    expect(new URL(requests[0]!.url).pathname).toBe('/api/internal/agent/alipay-bot')
    expect(requests[0]!.init).toMatchObject({
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-copis-agent-file-token': 'worker-secret',
      },
    })
    expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({
      sessionId: 'session-1',
      action: 'wallet.check',
    })
  })

  test('Given payment inputs When alipay_bot starts payment Then it sends structured headers and never builds a shell command', async () => {
    const requests: Array<{ init?: RequestInit }> = []
    const { sdk, definitions } = testSdk()

    buildPiAlipayBotTools(sdk, {
      sessionId: 'session-1',
      token: 'worker-secret',
      fetchImpl: async (_url, init) => {
        requests.push({ init })
        return jsonResponse({ ok: true, status: 'pending_user_pay', tradeNo: 'trade-1' })
      },
    })

    const tool = definitions.find((definition) => definition.name === 'alipay_bot')
    await tool?.execute?.('call-2', {
      action: 'payment.start',
      paymentNeeded: '{"protocol":{"amount":"0.01"}}',
      resourceUrl: 'https://seller.example/prepare',
      method: 'POST',
      data: '{"resource_id":"R-1"}',
      headers: [{ name: 'Content-Type', value: 'application/json' }],
    })

    const body = JSON.parse(String(requests[0]!.init?.body)) as Record<string, unknown>
    expect(body).toEqual({
      sessionId: 'session-1',
      action: 'payment.start',
      paymentNeeded: '{"protocol":{"amount":"0.01"}}',
      resourceUrl: 'https://seller.example/prepare',
      method: 'POST',
      data: '{"resource_id":"R-1"}',
      headers: [['Content-Type', 'application/json']],
    })
    expect(JSON.stringify(body)).not.toContain(' && ')
    expect(JSON.stringify(body)).not.toContain(';')
  })

  test('Given a confirmed payment When alipay_bot acknowledges fulfillment Then it sends the trade number to Rust', async () => {
    const requests: Array<{ init?: RequestInit }> = []
    const { sdk, definitions } = testSdk()

    buildPiAlipayBotTools(sdk, {
      sessionId: 'session-1',
      token: 'worker-secret',
      fetchImpl: async (_url, init) => {
        requests.push({ init })
        return jsonResponse({ ok: true, status: 'resource_ready' })
      },
    })

    const tool = definitions.find((definition) => definition.name === 'alipay_bot')
    await tool?.execute?.('call-ack', { action: 'payment.ack', tradeNo: 'trade-1' })

    expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({
      sessionId: 'session-1',
      action: 'payment.ack',
      tradeNo: 'trade-1',
    })
  })

  test('Given Rust rejects the capability When alipay_bot executes Then the model receives the service code without token data', async () => {
    const { sdk, definitions } = testSdk()

    buildPiAlipayBotTools(sdk, {
      sessionId: 'session-1',
      token: 'worker-secret',
      fetchImpl: async () => jsonResponse({ error: 'Agent 文件能力令牌无效', code: 'agent_file_token_invalid' }, 403),
    })

    const tool = definitions.find((definition) => definition.name === 'alipay_bot')
    await expect(tool?.execute?.('call-3', { action: 'wallet.check' })).rejects.toMatchObject({
      code: 'agent_file_token_invalid',
      message: expect.stringContaining('令牌无效'),
    })
    await expect(tool?.execute?.('call-4', { action: 'wallet.check' })).rejects.not.toThrow('worker-secret')
  })

  test('Given the built-in tool factory When a Worker starts Then alipay_bot is registered with the other Copis tools', () => {
    const { sdk } = testSdk()
    const sdkWithBuiltinDefinitions = {
      ...sdk,
      createReadToolDefinition: () => ({ name: 'Read' }),
      createBashToolDefinition: () => ({ name: 'Bash' }),
      createEditToolDefinition: () => ({ name: 'Edit' }),
      createWriteToolDefinition: () => ({ name: 'Write' }),
      createGrepToolDefinition: () => ({ name: 'Grep' }),
      createFindToolDefinition: () => ({ name: 'Find' }),
      createLsToolDefinition: () => ({ name: 'Ls' }),
    } as unknown as typeof import('@earendil-works/pi-coding-agent')
    const definitions = buildBuiltinToolDefinitions(
      sdkWithBuiltinDefinitions,
      '/workspace',
      undefined,
      undefined,
      { sessionId: 'session-1', useRustFileApi: false },
    )

    expect(definitions.map((definition) => definition.name)).toContain('alipay_bot')
    const alipayTool = definitions.find((definition) => definition.name === 'alipay_bot')
    expect(JSON.stringify(alipayTool?.parameters)).toContain('payment.ack')
  })
})
