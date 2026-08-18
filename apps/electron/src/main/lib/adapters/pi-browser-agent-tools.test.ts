import { describe, expect, test } from 'bun:test'
import { BROWSER_AGENT_TOOL_NAMES } from '../agent-rpc-protocol'
import { buildBuiltinToolDefinitions } from './pi-agent-adapter'
import { buildPiBrowserAgentTools } from './pi-browser-agent-tools'

interface CapturedConsoleLogs {
  info: unknown[][]
  warn: unknown[][]
  error: unknown[][]
}

async function withCapturedConsoleLogs(run: (logs: CapturedConsoleLogs) => Promise<void>): Promise<void> {
  const logs: CapturedConsoleLogs = { info: [], warn: [], error: [] }
  const originalInfo = console.info
  const originalWarn = console.warn
  const originalError = console.error
  console.info = (...args: Parameters<typeof console.info>): void => { logs.info.push(args) }
  console.warn = (...args: Parameters<typeof console.warn>): void => { logs.warn.push(args) }
  console.error = (...args: Parameters<typeof console.error>): void => { logs.error.push(args) }
  try {
    await run(logs)
  } finally {
    console.info = originalInfo
    console.warn = originalWarn
    console.error = originalError
  }
}

function serializedLogs(logs: CapturedConsoleLogs): string {
  return JSON.stringify(logs)
}

describe('Pi Browser Agent tool client', () => {
  test('Given BrowserPageOpenTab schema When incognito is supplied Then the optional boolean is accepted and documented', () => {
    const definitions: Array<{ name: string; description?: string; promptSnippet?: string; parameters?: { properties?: Record<string, unknown> } }> = []
    const sdk = {
      defineTool: <T>(definition: T): T => {
        definitions.push(definition as typeof definitions[number])
        return definition
      },
    } as unknown as typeof import('@earendil-works/pi-coding-agent')

    buildPiBrowserAgentTools(sdk, {
      sessionId: 'session-1',
      capability: { endpoint: '/api/internal/agent/browser-tool', token: 'capability-1' },
    })

    const openTab = definitions.find((definition) => definition.name === 'BrowserPageOpenTab')
    expect(openTab?.parameters?.properties?.incognito).toBeDefined()
    expect(openTab?.description).toContain('incognito: true')
    expect(openTab?.promptSnippet).toContain('不复用普通页签登录态')
  })

  test('Given opaque capability When BrowserPageObserve executes Then it posts only the fixed bridge request shape', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const definitions: Array<{ name: string; execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<unknown> }> = []
    const sdk = {
      defineTool: <T>(definition: T): T => {
        definitions.push(definition as typeof definitions[number])
        return definition
      },
    } as unknown as typeof import('@earendil-works/pi-coding-agent')

    buildPiBrowserAgentTools(sdk, {
      sessionId: 'session-1',
      capability: { endpoint: '/api/internal/agent/browser-tool', token: 'capability-1' },
      baseUrl: 'http://127.0.0.1:51730',
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init })
        return new Response(JSON.stringify({ kind: 'json', value: { kind: 'untrusted_browser_page', text: '页面内容' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    })

    const observe = definitions.find((definition) => definition.name === 'BrowserPageObserve')
    await withCapturedConsoleLogs(async (logs) => {
      await expect(observe?.execute('tool-call-1', {})).resolves.toMatchObject({
        details: { kind: 'untrusted_browser_page', text: '页面内容' },
      })
      const output = serializedLogs(logs)
      expect(output).toContain('HTTP bridge 开始')
      expect(output).toContain('HTTP bridge 响应')
      expect(output).toContain('工具完成')
      expect(output).not.toContain('capability-1')
    })
    expect(definitions.map((definition) => definition.name)).toEqual([...BROWSER_AGENT_TOOL_NAMES])
    expect(requests).toHaveLength(1)
    expect(new URL(requests[0]!.url).pathname).toBe('/api/internal/agent/browser-tool')
    expect(requests[0]!.init).toMatchObject({
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    })
    expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({
      sessionId: 'session-1',
      capabilityToken: 'capability-1',
      toolCallId: 'tool-call-1',
      toolName: 'BrowserPageObserve',
      toolInput: {},
    })
  })

  test('Given bridge denial When tool executes Then it preserves the service error code for the model and logs', async () => {
    const definitions: Array<{ name: string; execute: (toolCallId: string, params: unknown) => Promise<unknown> }> = []
    const sdk = {
      defineTool: <T>(definition: T): T => {
        definitions.push(definition as typeof definitions[number])
        return definition
      },
    } as unknown as typeof import('@earendil-works/pi-coding-agent')

    buildPiBrowserAgentTools(sdk, {
      sessionId: 'session-1',
      capability: { endpoint: '/api/internal/agent/browser-tool', token: 'capability-1' },
      fetchImpl: async () => new Response(JSON.stringify({
        error: '当前页面处于询问模式',
        code: 'browser_page_policy_refused',
      }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
    })

    const click = definitions.find((definition) => definition.name === 'BrowserPageClick')
    await withCapturedConsoleLogs(async (logs) => {
      await expect(click?.execute('tool-call-2', { ref: 'e1' })).rejects.toMatchObject({
        code: 'browser_page_policy_refused',
        message: expect.stringContaining('询问模式'),
      })
      const output = serializedLogs(logs)
      expect(output).toContain('HTTP bridge 响应')
      expect(output).toContain('main_policy_refused')
      expect(output).not.toContain('capability-1')
    })
  })

  test('Given opaque capability When BrowserPageUpload executes Then it forwards only ref and paths through the fixed bridge', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const definitions: Array<{ name: string; execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<unknown> }> = []
    const sdk = {
      defineTool: <T>(definition: T): T => {
        definitions.push(definition as typeof definitions[number])
        return definition
      },
    } as unknown as typeof import('@earendil-works/pi-coding-agent')

    buildPiBrowserAgentTools(sdk, {
      sessionId: 'session-1',
      capability: { endpoint: '/api/internal/agent/browser-tool', token: 'capability-1' },
      baseUrl: 'http://127.0.0.1:51730',
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init })
        return new Response(JSON.stringify({ kind: 'json', value: { ok: true } }), { status: 200 })
      },
    })

    const upload = definitions.find((definition) => definition.name === 'BrowserPageUpload')
    expect(upload).toBeDefined()
    await upload!.execute('upload-call-1', { ref: 'e-file', paths: ['/workspace/project/contract.pdf'] })

    expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({
      sessionId: 'session-1',
      capabilityToken: 'capability-1',
      toolCallId: 'upload-call-1',
      toolName: 'BrowserPageUpload',
      toolInput: { ref: 'e-file', paths: ['/workspace/project/contract.pdf'] },
    })
  })

  test('Given Composer 高级授权 When BrowserPageType is described Then its input permits the user-requested sensitive value', () => {
    const definitions: Array<{ name: string; parameters?: unknown }> = []
    const sdk = {
      defineTool: <T>(definition: T): T => {
        definitions.push(definition as typeof definitions[number])
        return definition
      },
    } as unknown as typeof import('@earendil-works/pi-coding-agent')

    buildPiBrowserAgentTools(sdk, {
      sessionId: 'session-1',
      capability: { endpoint: '/api/internal/agent/browser-tool', token: 'capability-1' },
    })

    const text = (definitions.find((definition) => definition.name === 'BrowserPageType')?.parameters as {
      properties?: { text?: { description?: string } }
    } | undefined)?.properties?.text?.description
    expect(text).toContain('高级授权开启时可包含敏感值')
    expect(text).not.toContain('不得包含')
  })

  test('Given BrowserWorkflowDraft When Browser Agent tools are built Then it requires a structured workflow draft instead of an unknown object', () => {
    const definitions: Array<{
      name: string
      promptSnippet?: string
      parameters?: {
        properties?: {
          workflow?: {
            properties?: {
              schemaVersion?: { const?: number }
              start?: { properties?: { tabAlias?: unknown; url?: unknown; origin?: unknown } }
              variables?: { type?: string }
              steps?: { type?: string; minItems?: number; items?: { anyOf?: unknown[] } }
            }
          }
        }
      }
    }> = []
    const sdk = {
      defineTool: <T>(definition: T): T => {
        definitions.push(definition as typeof definitions[number])
        return definition
      },
    } as unknown as typeof import('@earendil-works/pi-coding-agent')

    buildPiBrowserAgentTools(sdk, {
      sessionId: 'session-1',
      capability: { endpoint: '/api/internal/agent/browser-tool', token: 'capability-1' },
    })

    const draft = definitions.find((definition) => definition.name === 'BrowserWorkflowDraft')
    const workflow = draft?.parameters?.properties?.workflow
    expect(workflow?.properties?.schemaVersion?.const).toBe(1)
    expect(workflow?.properties?.start?.properties).toMatchObject({ tabAlias: {}, url: {}, origin: {} })
    expect(workflow?.properties?.variables?.type).toBe('array')
    expect(workflow?.properties?.steps).toMatchObject({ type: 'array', minItems: 1 })
    expect(workflow?.properties?.steps?.items?.anyOf).toBeArray()
    expect(draft?.promptSnippet).toContain('不得传 workflowId')
    expect(draft?.promptSnippet).toContain('target.locator')
    expect(draft?.promptSnippet).toContain('每个步骤都要填写 description')
    expect(draft?.promptSnippet).toContain('submit 事件不生成独立步骤')
  })

  test('Given 用户运行 Workflow When 工具定义提供执行提示 Then 失败后指引 Agent 基于当前页面重新分析', () => {
    const definitions: Array<{ name: string; promptSnippet?: string }> = []
    const sdk = {
      defineTool: <T>(definition: T): T => {
        definitions.push(definition as typeof definitions[number])
        return definition
      },
    } as unknown as typeof import('@earendil-works/pi-coding-agent')

    buildPiBrowserAgentTools(sdk, {
      sessionId: 'session-1',
      capability: { endpoint: '/api/internal/agent/browser-tool', token: 'capability-1' },
    })

    expect(definitions.find((definition) => definition.name === 'BrowserWorkflowRun')?.promptSnippet)
      .toContain('BrowserPageObserve')
    expect(definitions.find((definition) => definition.name === 'BrowserWorkflowRun')?.promptSnippet)
      .toContain('只能调用 `BrowserWorkflowRun`')
    expect(definitions.find((definition) => definition.name === 'BrowserWorkflowRun')?.promptSnippet)
      .toContain('不得通过 `bash`、Node.js')
  })

  test('Given fetch abort When browser tool executes Then logs the fetch abort stage without request values', async () => {
    const definitions: Array<{ name: string; execute: (toolCallId: string, params: unknown) => Promise<unknown> }> = []
    const sdk = {
      defineTool: <T>(definition: T): T => {
        definitions.push(definition as typeof definitions[number])
        return definition
      },
    } as unknown as typeof import('@earendil-works/pi-coding-agent')
    buildPiBrowserAgentTools(sdk, {
      sessionId: 'session-1',
      capability: { endpoint: '/api/internal/agent/browser-tool', token: 'capability-1' },
      fetchImpl: async () => {
        const error = new Error('The operation timed out')
        Object.defineProperty(error, 'name', { value: 'AbortError' })
        throw error
      },
    })

    const navigate = definitions.find((definition) => definition.name === 'BrowserPageNavigate')
    const sensitiveUrl = 'https://payments.example.test/pay?token=capability-1&code=123#otp=456'
    await withCapturedConsoleLogs(async (logs) => {
      await expect(navigate?.execute('tool-call-abort', { url: sensitiveUrl })).rejects.toThrow('工具调用失败')
      const output = serializedLogs(logs)
      expect(output).toContain('fetch_aborted')
      expect(output).toContain('HTTP bridge 失败')
      expect(output).not.toContain('capability-1')
      expect(output).not.toContain(sensitiveUrl)
      expect(output).not.toContain('123')
    })
  })

  test('Given invalid JSON bridge response When browser tool executes Then logs response parsing failure', async () => {
    const definitions: Array<{ name: string; execute: (toolCallId: string, params: unknown) => Promise<unknown> }> = []
    const sdk = {
      defineTool: <T>(definition: T): T => {
        definitions.push(definition as typeof definitions[number])
        return definition
      },
    } as unknown as typeof import('@earendil-works/pi-coding-agent')
    buildPiBrowserAgentTools(sdk, {
      sessionId: 'session-1',
      capability: { endpoint: '/api/internal/agent/browser-tool', token: 'capability-1' },
      fetchImpl: async () => new Response('not-json', { status: 200 }),
    })

    const observe = definitions.find((definition) => definition.name === 'BrowserPageObserve')
    await withCapturedConsoleLogs(async (logs) => {
      await expect(observe?.execute('tool-call-parse', {})).rejects.toThrow('响应不正确')
      expect(serializedLogs(logs)).toContain('响应解析失败')
    })
  })

  test('Given a Worker Browser capability When built-in tools are created Then registers the fixed Browser allowlist only for that capability', () => {
    const createSdk = (): {
      sdk: typeof import('@earendil-works/pi-coding-agent')
      definitions: Array<{ name?: string }>
    } => {
      const definitions: Array<{ name?: string }> = []
      const sdk = {
        defineTool: <T>(definition: T): T => {
          definitions.push(definition as { name?: string })
          return definition
        },
        createReadToolDefinition: () => ({ name: 'Read' }),
        createBashToolDefinition: () => ({ name: 'Bash' }),
        createEditToolDefinition: () => ({ name: 'Edit' }),
        createWriteToolDefinition: () => ({ name: 'Write' }),
        createGrepToolDefinition: () => ({ name: 'Grep' }),
        createFindToolDefinition: () => ({ name: 'Find' }),
        createLsToolDefinition: () => ({ name: 'Ls' }),
      } as unknown as typeof import('@earendil-works/pi-coding-agent')
      return { sdk, definitions }
    }
    const withCapability = createSdk()
    const withoutCapability = createSdk()

    const browserDefinitions = buildBuiltinToolDefinitions(
      withCapability.sdk,
      '/workspace',
      undefined,
      undefined,
      {
        sessionId: 'session-1',
        useRustFileApi: false,
        browserPageControl: { endpoint: '/api/internal/agent/browser-tool', token: 'capability-1' },
      },
    )
    const workspaceDefinitions = buildBuiltinToolDefinitions(
      withoutCapability.sdk,
      '/workspace',
      undefined,
      undefined,
      { sessionId: 'session-2', useRustFileApi: false },
    )

    expect(browserDefinitions.map((definition) => definition.name)).toEqual(expect.arrayContaining([...BROWSER_AGENT_TOOL_NAMES]))
    expect(workspaceDefinitions.map((definition) => definition.name)).not.toEqual(expect.arrayContaining([...BROWSER_AGENT_TOOL_NAMES]))
  })
})
