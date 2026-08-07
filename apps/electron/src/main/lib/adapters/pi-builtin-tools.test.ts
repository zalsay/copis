import { describe, expect, mock, test } from 'bun:test'
import { memoryToolNamesForPolicy } from './memory-tool-policy'

const executeDirect = mock(async () => ({ kind: 'json' as const, value: { source: 'dispatcher' } }))

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
  getBrowserAgentContext: () => ({ tabId: 'tab-1' }),
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
}))
mock.module('../browser-page-control-runtime', () => ({ browserPageControl: {} }))
mock.module('../browser-workflow-runner', () => ({ runBrowserWorkflow: async () => undefined, stopBrowserWorkflowRun: () => {} }))
mock.module('../browser-workflow-store', () => ({ getBrowserWorkflow: () => undefined, listBrowserWorkflows: () => [] }))
mock.module('../settings-service', () => ({
  getSettings: () => ({ browserWorkflowEnabled: true }),
  updateSettings: () => ({}),
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
})
