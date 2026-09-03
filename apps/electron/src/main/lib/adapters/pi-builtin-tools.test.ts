import { describe, expect, mock, test } from 'bun:test'
import { memoryToolNamesForPolicy } from './memory-tool-policy'

const executeDirect = mock(async () => ({ kind: 'json' as const, value: { source: 'dispatcher' } }))
let browserAgentContext: { tabId: string } | undefined = { tabId: 'tab-1' }

mock.module('electron', () => ({
  app: { isPackaged: true, getPath: () => '/tmp/copis-pi-builtin-tools-test' },
  BrowserWindow: class {},
  WebContentsView: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: { openExternal: async () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}))

mock.module('../browser-agent-tool-service', () => ({
  browserAgentToolService: { executeDirect },
}))
mock.module('../browser-workflow-service', () => ({
  getBrowserAgentContext: () => browserAgentContext,
  isBrowserPageAdvancedAuthorizationEnabled: () => false,
  sanitizeBrowserWorkflowUrl: (url: string) => url,
  getBrowserPageControlMode: () => 'authorized',
  getBrowserWorkflowDraft: () => undefined,
  getBrowserWorkflowRecording: async () => undefined,
  getBrowserWorkflowStatus: () => ({ sessionId: 'browser-session', state: 'idle' }),
  startBrowserWorkflowRecording: async () => ({ sessionId: 'browser-session', state: 'recording' }),
  stopBrowserWorkflowRecording: async () => ({ sessionId: 'browser-session', state: 'awaiting_summary' }),
  submitBrowserWorkflowDraft: () => undefined,
  submitBrowserWorkflowRepairDraft: () => undefined,
  approveBrowserWorkflowDraft: () => undefined,
  renderBrowserRecording: (val: unknown) => JSON.stringify(val),
}))
mock.module('../browser-page-control-runtime', () => ({ browserPageControl: {} }))
mock.module('../browser-workflow-runner', () => ({ runBrowserWorkflow: async () => undefined, stopBrowserWorkflowRun: () => {} }))
mock.module('../browser-workflow-store', () => ({ getBrowserWorkflow: () => undefined, listBrowserWorkflows: () => [] }))
mock.module('../settings-service', () => ({
  getSettings: () => ({ browserWorkflowEnabled: true }),
  updateSettings: () => ({}),
}))

const nanoBananaUserEnabled = mock(() => false)
const nanoBananaToolState = mock(() => ({ enabled: false }))
const nanoBananaAvailable = mock(() => false)
const executeNanoBanana = mock(async () => ({
  toolCallId: 'call-1',
  content: '图片已成功生成（1 张）',
  generatedAttachments: [{
    id: 'attachment-1',
    filename: 'nano-banana-1.png',
    mediaType: 'image/png',
    localPath: '/tmp/nano-banana-1.png',
    size: 1024,
  }],
}))
const readAttachmentBase64 = mock(() => 'base64-image-data')

mock.module('../builtin-mcp/settings', () => ({
  isBuiltinMcpUserEnabled: nanoBananaUserEnabled,
  isBuiltinMcpDefaultDisabled: (id: string) => id === 'nano-banana',
  setBuiltinMcpUserEnabled: () => {},
}))
mock.module('../agent-tool-config', () => ({
  getAgentToolState: nanoBananaToolState,
  getAgentToolCredentials: () => ({}),
}))
mock.module('../agent-tools/image-generation-tool', () => ({
  isNanoBananaAvailable: nanoBananaAvailable,
  executeNanoBananaTool: executeNanoBanana,
  isNanoBananaToolCall: () => false,
  NANO_BANANA_TOOL_META: { id: 'nano-banana' },
  NANO_BANANA_TOOL_DEFINITIONS: [],
}))
mock.module('../attachment-service', () => ({
  readAttachmentAsBase64: readAttachmentBase64,
}))

const { buildPiBuiltinTools } = await import('./pi-builtin-tools')

describe('Pi Memory 工具策略矩阵', () => {
  test('Given off policy Then不注册任何 Memory tool', () => {
    expect(memoryToolNamesForPolicy('off')).toEqual([])
  })

  test('Given visible policy Then只注册 recall/read', () => {
    expect(memoryToolNamesForPolicy('visible')).toEqual(['memory_recall', 'memory_read'])
  })

  test('Given writable policy Then注册读写四个 typed tools', () => {
    expect(memoryToolNamesForPolicy('writable')).toEqual([
      'memory_recall',
      'memory_read',
      'memory_capture',
      'memory_rewrite',
    ])
  })
})

describe('Pi Browser 工具复用主进程 dispatcher', () => {
  test('Given direct Pi BrowserPageObserve When executed Then forwards the high-level request to dispatcher', async () => {
    const sdk = {
      defineTool: <T>(definition: T): T => definition,
    } as unknown as typeof import('@earendil-works/pi-coding-agent')
    const result = await buildPiBuiltinTools(sdk, {
      sessionId: 'browser-session',
      channelId: 'channel-1',
      workspaceId: 'workspace-1',
      memoryPolicy: 'off',
      triggeredBy: 'user',
    })
    const observe = result.tools.find((tool) => tool.name === 'BrowserPageObserve') as unknown as {
      execute: (toolCallId: string, input: Record<string, unknown>) => Promise<unknown>
    }

    await expect(observe.execute('call-1', {})).resolves.toMatchObject({
      details: { source: 'dispatcher' },
    })
    expect(executeDirect).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'browser-session',
      toolCallId: 'call-1',
      toolName: 'BrowserPageObserve',
      toolInput: {},
      workspaceId: 'workspace-1',
    }))
  })

  test('Given direct Pi BrowserPageOpenTab When executed Then forwards the high-level request to dispatcher', async () => {
    const sdk = {
      defineTool: <T>(definition: T): T => definition,
    } as unknown as typeof import('@earendil-works/pi-coding-agent')
    const result = await buildPiBuiltinTools(sdk, {
      sessionId: 'browser-session',
      channelId: 'channel-1',
      workspaceId: 'workspace-1',
      memoryPolicy: 'off',
      triggeredBy: 'user',
    })
    const openTab = result.tools.find((tool) => tool.name === 'BrowserPageOpenTab') as unknown as {
      execute: (toolCallId: string, input: Record<string, unknown>) => Promise<unknown>
    }

    await expect(openTab.execute('call-2', { url: 'https://www.xiaohongshu.com/' })).resolves.toMatchObject({
      details: { source: 'dispatcher' },
    })
    expect(executeDirect).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'browser-session',
      toolCallId: 'call-2',
      toolName: 'BrowserPageOpenTab',
      toolInput: { url: 'https://www.xiaohongshu.com/' },
      workspaceId: 'workspace-1',
    }))
  })

  test('Given direct Pi BrowserPageOpenTab schema When incognito is supplied Then it accepts an optional boolean', async () => {
    const sdk = {
      defineTool: <T>(definition: T): T => definition,
    } as unknown as typeof import('@earendil-works/pi-coding-agent')
    const result = await buildPiBuiltinTools(sdk, {
      sessionId: 'browser-session',
      channelId: 'channel-1',
      workspaceId: 'workspace-1',
      memoryPolicy: 'off',
      triggeredBy: 'user',
    })
    const openTab = result.tools.find((tool) => tool.name === 'BrowserPageOpenTab') as unknown as {
      description?: string
      promptSnippet?: string
      parameters?: { properties?: Record<string, unknown> }
    }

    expect(openTab.parameters?.properties?.incognito).toBeDefined()
    expect(openTab.description).toContain('incognito: true')
    expect(openTab.promptSnippet).toContain('不复用普通页签登录态')
  })

  test('Given Pi has no Browser Context When tools are built Then it still exposes BrowserPageOpenTab for a user to create the first tab', async () => {
    browserAgentContext = undefined
    const sdk = {
      defineTool: <T>(definition: T): T => definition,
    } as unknown as typeof import('@earendil-works/pi-coding-agent')

    try {
      const result = await buildPiBuiltinTools(sdk, {
        sessionId: 'browser-session',
        channelId: 'channel-1',
        workspaceId: 'workspace-1',
        memoryPolicy: 'off',
        triggeredBy: 'user',
      })

      expect(result.tools.some((tool) => tool.name === 'BrowserPageOpenTab')).toBe(true)
      expect(result.tools.some((tool) => tool.name === 'BrowserPageObserve')).toBe(true)
    } finally {
      browserAgentContext = { tabId: 'tab-1' }
    }
  })

  test('Given Composer 高级授权 When direct Pi BrowserPageType is built Then its input permits the user-requested sensitive value', async () => {
    const sdk = {
      defineTool: <T>(definition: T): T => definition,
    } as unknown as typeof import('@earendil-works/pi-coding-agent')
    const result = await buildPiBuiltinTools(sdk, {
      sessionId: 'browser-session',
      channelId: 'channel-1',
      workspaceId: 'workspace-1',
      memoryPolicy: 'off',
      triggeredBy: 'user',
    })
    const text = (result.tools.find((tool) => tool.name === 'BrowserPageType') as unknown as {
      parameters?: { properties?: { text?: { description?: string } } }
    } | undefined)?.parameters?.properties?.text?.description

    expect(text).toContain('高级授权开启时可包含敏感值')
    expect(text).not.toContain('不得包含')
  })

  test('Given BrowserWorkflowDraft When direct Pi tools are built Then it exposes the same structured workflow draft contract', async () => {
    const sdk = {
      defineTool: <T>(definition: T): T => definition,
    } as unknown as typeof import('@earendil-works/pi-coding-agent')
    const result = await buildPiBuiltinTools(sdk, {
      sessionId: 'browser-session',
      channelId: 'channel-1',
      workspaceId: 'workspace-1',
      memoryPolicy: 'off',
      triggeredBy: 'user',
    })
    const draft = result.tools.find((tool) => tool.name === 'BrowserWorkflowDraft') as unknown as {
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
    } | undefined
    const workflow = draft?.parameters?.properties?.workflow

    expect(workflow?.properties?.schemaVersion?.const).toBe(1)
    expect(workflow?.properties?.start?.properties).toMatchObject({ tabAlias: {}, url: {}, origin: {} })
    expect(workflow?.properties?.variables?.type).toBe('array')
    expect(workflow?.properties?.steps).toMatchObject({ type: 'array', minItems: 1 })
    expect(workflow?.properties?.steps?.items?.anyOf).toBeArray()
    expect(draft?.promptSnippet).toContain('不得传 workflowId')
    expect(draft?.promptSnippet).toContain('target.locator')
    expect(draft?.promptSnippet).toContain('submit 事件不生成独立步骤')
  })

  test('Given BrowserWorkflowRun When direct Pi tools are built Then it forbids bypassing the main-process Playwright runner', async () => {
    const sdk = {
      defineTool: <T>(definition: T): T => definition,
    } as unknown as typeof import('@earendil-works/pi-coding-agent')
    const result = await buildPiBuiltinTools(sdk, {
      sessionId: 'browser-session',
      channelId: 'channel-1',
      workspaceId: 'workspace-1',
      memoryPolicy: 'off',
      triggeredBy: 'user',
    })
    const run = result.tools.find((tool) => tool.name === 'BrowserWorkflowRun') as unknown as { promptSnippet?: string }

    expect(run.promptSnippet).toContain('已校验的 Playwright 脚本')
    expect(run.promptSnippet).toContain('只能调用 `BrowserWorkflowRun`')
    expect(run.promptSnippet).toContain('不得通过 `bash`、Node.js')
  })
})

describe('主 Agent 专家团队工具边界', () => {
  const sdk = {
    defineTool: <T>(definition: T): T => definition,
  } as unknown as typeof import('@earendil-works/pi-coding-agent')

  test('Given user 主会话 When 构建内置工具 Then 暴露专家团队调度工具', async () => {
    const result = await buildPiBuiltinTools(sdk, {
      sessionId: 'parent-session',
      channelId: 'channel-1',
      workspaceId: 'workspace-1',
      workspaceSlug: 'workspace-1',
      memoryPolicy: 'off',
      triggeredBy: 'user',
    })

    expect(result.expertTeamAvailable).toBe(true)
    expect(result.tools.some((tool) => tool.name === 'expert_team_run')).toBe(true)
  })

  test('Given delegation 子会话 When 构建内置工具 Then 不暴露专家团队调度工具', async () => {
    const result = await buildPiBuiltinTools(sdk, {
      sessionId: 'child-session',
      channelId: 'channel-1',
      workspaceId: 'workspace-1',
      workspaceSlug: 'workspace-1',
      memoryPolicy: 'off',
      triggeredBy: 'delegation',
    })

    expect(result.expertTeamAvailable).toBe(false)
    expect(result.tools.some((tool) => tool.name === 'expert_team_run')).toBe(false)
  })

  test('Given automation 子会话 When 构建内置工具 Then 不暴露专家团队调度工具', async () => {
    const result = await buildPiBuiltinTools(sdk, {
      sessionId: 'automation-session',
      channelId: 'channel-1',
      workspaceId: 'workspace-1',
      workspaceSlug: 'workspace-1',
      memoryPolicy: 'off',
      triggeredBy: 'automation',
    })

    expect(result.expertTeamAvailable).toBe(false)
    expect(result.tools.some((tool) => tool.name === 'expert_team_run')).toBe(false)
  })
})

describe('Pi Copis 图片生成工具', () => {
  const sdk = {
    defineTool: <T>(definition: T): T => definition,
  } as unknown as typeof import('@earendil-works/pi-coding-agent')

  test('Given 用户未启用内置生图 Then 不注入 generate_image 工具', async () => {
    nanoBananaUserEnabled.mockReturnValue(false)
    const result = await buildPiBuiltinTools(sdk, {
      sessionId: 'session-1',
      channelId: 'channel-1',
      memoryPolicy: 'off',
      triggeredBy: 'user',
    })
    expect(result.tools.find((tool) => tool.name === 'generate_image')).toBeUndefined()
    expect(executeNanoBanana).not.toHaveBeenCalled()
  })

  test('Given 内置生图已启用且 API Key 已配置 When 执行 generate_image Then 回传文本与图片内容', async () => {
    nanoBananaUserEnabled.mockReturnValue(true)
    nanoBananaToolState.mockReturnValue({ enabled: true })
    nanoBananaAvailable.mockReturnValue(true)

    const result = await buildPiBuiltinTools(sdk, {
      sessionId: 'session-1',
      channelId: 'channel-1',
      memoryPolicy: 'off',
      triggeredBy: 'user',
    })
    const tool = result.tools.find((item) => item.name === 'generate_image') as unknown as {
      execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>
    }
    expect(tool).toBeDefined()

    const executed = await tool.execute('call-1', { prompt: '一只戴着帽子的猫' })
    expect(executeNanoBanana).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'call-1' }),
      expect.objectContaining({ conversationId: 'session-1' }),
    )
    const executedRecord = executed as { content: Array<Record<string, unknown>>; details: unknown }
    expect(executedRecord.details).toEqual({
      generatedAttachments: [{
        filename: 'nano-banana-1.png',
        path: '/tmp/nano-banana-1.png',
        mediaType: 'image/png',
      }],
    })
    expect(executedRecord.content.some((block) => block.type === 'image' && block.data === 'base64-image-data')).toBe(true)
    expect(executedRecord.content.some((block) => block.type === 'text' && String(block.text).includes('<generated_images>'))).toBe(true)
  })

  test('Given 生图执行失败 When 工具被调用 Then 抛出错误而不是返回成功', async () => {
    nanoBananaUserEnabled.mockReturnValue(true)
    nanoBananaToolState.mockReturnValue({ enabled: true })
    nanoBananaAvailable.mockReturnValue(true)
    executeNanoBanana.mockResolvedValue({
      toolCallId: 'call-1',
      content: '图片模型请求失败 (401): unauthorized',
      isError: true,
    } as unknown as Awaited<ReturnType<typeof executeNanoBanana>>)

    const result = await buildPiBuiltinTools(sdk, {
      sessionId: 'session-1',
      channelId: 'channel-1',
      memoryPolicy: 'off',
      triggeredBy: 'user',
    })
    const tool = result.tools.find((item) => item.name === 'generate_image') as unknown as {
      execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>
    }
    await expect(tool.execute('call-1', { prompt: '测试' })).rejects.toThrow('图片模型请求失败')
  })
})
