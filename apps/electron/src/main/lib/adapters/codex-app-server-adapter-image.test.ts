import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { WebSocketServer, WebSocket, type RawData } from 'ws'

const IMAGE_SERVER_NAME = 'copis_image'
const bridgeConfig = {
  url: 'http://127.0.0.1:43210/mcp',
  http_headers: { Authorization: 'Bearer test-image-mcp-secret' },
  required: true,
  tool_timeout_sec: 360,
  enabled: true,
  default_tools_approval_mode: 'approve',
}

const bridgeStarts: Array<Record<string, unknown>> = []
let bridgeCloseCount = 0
let bridgeStartGate: Promise<void> | undefined

mock.module('./codex-image-tools-mcp', () => ({
  CODEX_IMAGE_MCP_SERVER_NAME: IMAGE_SERVER_NAME,
  startCodexImageToolsMcp: async (options: Record<string, unknown>) => {
    bridgeStarts.push(options)
    if (bridgeStartGate) await bridgeStartGate
    return {
      config: bridgeConfig,
      close: async () => { bridgeCloseCount += 1 },
    }
  },
}))

const { CodexAppServerAdapter } = await import('./codex-app-server-adapter')

interface MockCodexServer {
  server: WebSocketServer
  port: number
  messages: Array<Record<string, unknown>>
  close: () => Promise<void>
}

async function createMockCodexAppServer(
  onMessage: (ws: WebSocket, message: Record<string, unknown>) => void,
): Promise<MockCodexServer> {
  const httpServer = createServer()
  const server = new WebSocketServer({ server: httpServer })
  const messages: Array<Record<string, unknown>> = []
  const clients = new Set<WebSocket>()
  const sockets = new Set<Socket>()
  httpServer.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('connection', (ws) => {
    clients.add(ws)
    ws.once('close', () => clients.delete(ws))
    ws.on('message', (raw: RawData) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>
      messages.push(message)
      onMessage(ws, message)
    })
  })

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const address = httpServer.address()
  if (!address || typeof address === 'string') throw new Error('Mock Codex server did not bind a port')
  return {
    server,
    port: address.port,
    messages,
    close: () => new Promise<void>((resolve) => {
      for (const client of clients) client.terminate()
      for (const socket of sockets) socket.destroy()
      httpServer.close()
      resolve()
    }),
  }
}

function sendResponse(ws: WebSocket, message: Record<string, unknown>, result: Record<string, unknown>): void {
  ws.send(JSON.stringify({ id: message.id, result }))
}

function sendCompletedTurn(ws: WebSocket, message: Record<string, unknown>): void {
  sendResponse(ws, message, { turn: { id: 'turn-image-test' } })
  setTimeout(() => ws.send(JSON.stringify({ method: 'turn/completed', params: { turn: { status: 'completed' } } })), 5)
}

const baseOptions = {
  sessionId: 'copis-session-image',
  agentRuntime: 'codex' as const,
  prompt: '帮我生成一张插画',
  cwd: '/tmp/copis-image-test',
  apiKey: '',
  provider: 'openai-codex' as const,
  permissionMode: 'bypassPermissions' as const,
  advancedAuthorization: true,
  systemPrompt: '保持上下文安全。',
  piAgentDir: '/tmp',
  piSessionDir: '/tmp/sessions',
}

describe('CodexAppServerAdapter image MCP', () => {
  beforeEach(() => {
    bridgeStarts.length = 0
    bridgeCloseCount = 0
    bridgeStartGate = undefined
  })

  test('Given 生图能力开启的新会话 When Codex 调用图片工具 Then 注册会话 MCP 并输出可持久化 tool_use、图片结果和附件详情', async () => {
    const mockServer = await createMockCodexAppServer((ws, message) => {
      if (message.method === 'initialize') sendResponse(ws, message, {})
      else if (message.method === 'thread/start') sendResponse(ws, message, { thread: { id: 'thread-image-new' } })
      else if (message.method === 'turn/start') {
        sendResponse(ws, message, { turn: { id: 'turn-image-new' } })
        setTimeout(() => {
          const bridge = bridgeStarts[0]!
          const onToolStart = bridge.onToolStart as (call: Record<string, unknown>) => void
          const onToolResult = bridge.onToolResult as (result: Record<string, unknown>) => void
          onToolStart({ callId: 'image-call-1', name: 'generate_image', arguments: { prompt: 'a watercolor fox' } })
          onToolResult({
            callId: 'image-call-1',
            name: 'generate_image',
            arguments: { prompt: 'a watercolor fox' },
            content: [
              { type: 'text', text: '图片已成功生成\n\n<generated_images>\n[{"filename":"fox.png","path":"session/fox.png","mediaType":"image/png"}]\n</generated_images>' },
              { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
            ],
            details: { generatedAttachments: [{ filename: 'fox.png', path: 'session/fox.png', mediaType: 'image/png' }] },
            isError: false,
          })
          ws.send(JSON.stringify({ method: 'turn/completed', params: { turn: { status: 'completed' } } }))
        }, 5)
      }
    })

    const adapter = new CodexAppServerAdapter()
    const messages: Array<Record<string, unknown>> = []
    for await (const message of adapter.query({ ...baseOptions, codexAppServerPort: mockServer.port, imageGenerationEnabled: true })) {
      messages.push(message as unknown as Record<string, unknown>)
    }

    expect(bridgeStarts).toHaveLength(1)
    expect(bridgeStarts[0]).toMatchObject({ sessionId: baseOptions.sessionId, cwd: baseOptions.cwd })
    const start = mockServer.messages.find(message => message.method === 'thread/start')!
    const startParams = start.params as Record<string, unknown>
    expect((startParams.config as Record<string, unknown>).mcp_servers).toEqual({ [IMAGE_SERVER_NAME]: bridgeConfig })
    expect(startParams.developerInstructions).toBe(baseOptions.systemPrompt)
    expect(String(startParams.developerInstructions)).not.toContain('test-image-mcp-secret')

    const toolAssistant = messages.find(message => message.type === 'assistant'
      && (message.message as Record<string, unknown>).stop_reason === 'tool_use')!
    expect(toolAssistant).toBeDefined()
    expect(toolAssistant._partial).toBeUndefined()
    const toolUse = ((toolAssistant.message as Record<string, unknown>).content as Array<Record<string, unknown>>)[0]!
    expect(toolUse).toEqual({ type: 'tool_use', id: 'image-call-1', name: 'generate_image', input: { prompt: 'a watercolor fox' } })

    const toolResultMessage = messages.find(message => message.type === 'user')!
    expect(toolResultMessage.uuid).toBeString()
    expect(toolResultMessage.tool_use_result).toEqual({
      generatedAttachments: [{ filename: 'fox.png', path: 'session/fox.png', mediaType: 'image/png' }],
    })
    const toolResult = ((toolResultMessage.message as Record<string, unknown>).content as Array<Record<string, unknown>>)[0]!
    expect(toolResult).toMatchObject({ type: 'tool_result', tool_use_id: 'image-call-1', is_error: false })
    expect(toolResult.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('<generated_images>') }),
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    ]))
    expect(bridgeCloseCount).toBe(1)

    adapter.dispose()
    await mockServer.close()
  })

  test('Given 已加载的旧 thread When 新 MCP 配置变更 Then 分页检测并 fork 完整历史后回写新 thread ID', async () => {
    const mockServer = await createMockCodexAppServer((ws, message) => {
      if (message.method === 'initialize') sendResponse(ws, message, {})
      else if (message.method === 'thread/loaded/list') {
        const params = message.params as Record<string, unknown>
        sendResponse(ws, message, params.cursor ? { data: ['thread-loaded-image'], nextCursor: null } : { data: ['other-thread'], nextCursor: 'page-2' })
      } else if (message.method === 'thread/fork') sendResponse(ws, message, { thread: { id: 'thread-image-fork' } })
      else if (message.method === 'turn/start') sendCompletedTurn(ws, message)
    })

    const adapter = new CodexAppServerAdapter()
    let savedThreadId: string | undefined
    for await (const _ of adapter.query({
      ...baseOptions,
      codexAppServerPort: mockServer.port,
      resumeSessionId: 'thread-loaded-image',
      imageGenerationEnabled: true,
      onSessionId: id => { savedThreadId = id },
    })) { /* consume */ }

    const loadedCalls = mockServer.messages.filter(message => message.method === 'thread/loaded/list')
    expect(loadedCalls).toHaveLength(2)
    expect((loadedCalls[1]!.params as Record<string, unknown>).cursor).toBe('page-2')
    const fork = mockServer.messages.find(message => message.method === 'thread/fork')!
    expect(fork.params).toMatchObject({
      threadId: 'thread-loaded-image',
      deferGoalContinuation: true,
      config: { mcp_servers: { [IMAGE_SERVER_NAME]: bridgeConfig } },
    })
    expect(mockServer.messages.some(message => message.method === 'thread/resume' || message.method === 'thread/start')).toBe(false)
    expect(savedThreadId).toBe('thread-image-fork')
    expect(bridgeCloseCount).toBe(1)

    adapter.dispose()
    await mockServer.close()
  })

  test('Given 已卸载的旧 thread When 生图能力启用 Then resume 使用当轮随机 MCP 地址和授权配置', async () => {
    const mockServer = await createMockCodexAppServer((ws, message) => {
      if (message.method === 'initialize') sendResponse(ws, message, {})
      else if (message.method === 'thread/loaded/list') sendResponse(ws, message, { data: [] })
      else if (message.method === 'thread/resume') sendResponse(ws, message, { thread: { id: 'thread-cold-resume' } })
      else if (message.method === 'turn/start') sendCompletedTurn(ws, message)
    })

    const adapter = new CodexAppServerAdapter()
    for await (const _ of adapter.query({
      ...baseOptions,
      codexAppServerPort: mockServer.port,
      resumeSessionId: 'thread-cold-resume',
      imageGenerationEnabled: true,
    })) { /* consume */ }

    const resume = mockServer.messages.find(message => message.method === 'thread/resume')!
    expect(resume.params).toMatchObject({ config: { mcp_servers: { [IMAGE_SERVER_NAME]: bridgeConfig } } })
    expect(mockServer.messages.some(message => message.method === 'thread/fork' || message.method === 'thread/start')).toBe(false)
    expect(bridgeCloseCount).toBe(1)
    adapter.dispose()
    await mockServer.close()
  })

  test('Given 计划模式或 chatroom 会话 When 恢复已加载 thread Then 不启动图片桥接并在 fork 配置中明确关闭 MCP', async () => {
    for (const scenario of [
      { sessionId: 'session-image-plan', permissionMode: 'plan' as const, capabilityProfile: 'default' as const },
      { sessionId: 'session-image-chatroom', permissionMode: 'bypassPermissions' as const, capabilityProfile: 'chatroom' as const },
    ]) {
      const mockServer = await createMockCodexAppServer((ws, message) => {
        if (message.method === 'initialize') sendResponse(ws, message, {})
        else if (message.method === 'thread/loaded/list') sendResponse(ws, message, { data: ['thread-old-image-capability'] })
        else if (message.method === 'thread/fork') sendResponse(ws, message, { thread: { id: `fork-${scenario.sessionId}` } })
        else if (message.method === 'turn/start') sendCompletedTurn(ws, message)
      })
      const adapter = new CodexAppServerAdapter()
      for await (const _ of adapter.query({
        ...baseOptions,
        ...scenario,
        codexAppServerPort: mockServer.port,
        resumeSessionId: 'thread-old-image-capability',
        imageGenerationEnabled: true,
      })) { /* consume */ }

      expect(bridgeStarts).toHaveLength(0)
      const fork = mockServer.messages.find(message => message.method === 'thread/fork')!
      const config = (fork.params as Record<string, unknown>).config as Record<string, unknown>
      expect((config.mcp_servers as Record<string, Record<string, unknown>>)[IMAGE_SERVER_NAME]).toMatchObject({
        enabled: false,
        required: false,
        url: expect.any(String),
      })
      expect(bridgeCloseCount).toBe(0)
      adapter.dispose()
      await mockServer.close()
    }
  })

  test('Given 生图工具恢复错误含 task_id When 形成 SDK 工具结果 Then 原文及恢复详情不丢失', async () => {
    const mockServer = await createMockCodexAppServer((ws, message) => {
      if (message.method === 'initialize') sendResponse(ws, message, {})
      else if (message.method === 'thread/start') sendResponse(ws, message, { thread: { id: 'thread-image-error' } })
      else if (message.method === 'turn/start') {
        sendResponse(ws, message, { turn: { id: 'turn-image-error' } })
        setTimeout(() => {
          const onToolStart = bridgeStarts[0]!.onToolStart as (call: Record<string, unknown>) => void
          const onToolResult = bridgeStarts[0]!.onToolResult as (result: Record<string, unknown>) => void
          const call = { callId: 'image-error-call', name: 'get_image_task', arguments: { task_id: 'task-123' } }
          onToolStart(call)
          onToolResult({ ...call, content: [{ type: 'text', text: '任务暂不可用（task_id=task-123，可使用 get_image_task 查询原任务）' }], details: { taskId: 'task-123' }, isError: true })
          ws.send(JSON.stringify({ method: 'turn/completed', params: { turn: { status: 'completed' } } }))
        }, 5)
      }
    })

    const adapter = new CodexAppServerAdapter()
    const messages: Array<Record<string, unknown>> = []
    for await (const message of adapter.query({ ...baseOptions, codexAppServerPort: mockServer.port, imageGenerationEnabled: true })) {
      messages.push(message as unknown as Record<string, unknown>)
    }
    const toolResult = messages.find(message => message.type === 'user')!
    expect(toolResult.tool_use_result).toEqual({ taskId: 'task-123' })
    expect(((toolResult.message as Record<string, unknown>).content as Array<Record<string, unknown>>)[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'image-error-call',
      content: [{ type: 'text', text: '任务暂不可用（task_id=task-123，可使用 get_image_task 查询原任务）' }],
      is_error: true,
    })
    adapter.dispose()
    await mockServer.close()
  })

  test('Given 生图工具运行期间 abort、dispose 或 WebSocket 断开 When query 清理 Then 关闭 MCP bridge 且不泄漏工具服务器', async () => {
    for (const action of ['abort', 'dispose', 'disconnect'] as const) {
      const closeCountBefore = bridgeCloseCount
      let toolCallId = 0
      const mockServer = await createMockCodexAppServer((ws, message) => {
        if (message.method === 'initialize') sendResponse(ws, message, {})
        else if (message.method === 'thread/start') sendResponse(ws, message, { thread: { id: `thread-image-${action}` } })
        else if (message.method === 'turn/start') {
          sendResponse(ws, message, { turn: { id: `turn-image-${action}` } })
          const onToolStart = bridgeStarts[bridgeStarts.length - 1]!.onToolStart as (call: Record<string, unknown>) => void
          onToolStart({ callId: `pending-image-call-${++toolCallId}`, name: 'generate_image', arguments: { prompt: 'pending' } })
          if (action === 'disconnect') setTimeout(() => ws.close(), 5)
        } else if (message.method === 'turn/interrupt') {
          ws.send(JSON.stringify({ method: 'turn/completed', params: { turn: { status: 'interrupted' } } }))
        }
      })

      const adapter = new CodexAppServerAdapter()
      const iterator = adapter.query({
        ...baseOptions,
        sessionId: `session-image-${action}`,
        codexAppServerPort: mockServer.port,
        imageGenerationEnabled: true,
      })
      const first = await iterator.next()
      expect(first.done).toBe(false)
      if (action === 'abort') adapter.abort(`session-image-${action}`)
      if (action === 'dispose') adapter.dispose()
      while (!(await iterator.next()).done) { /* drain */ }
      expect(bridgeCloseCount).toBe(closeCountBefore + 1)
      if (action === 'abort') {
        expect(mockServer.messages.some(message => message.method === 'turn/interrupt')).toBe(true)
      }

      adapter.dispose()
      await mockServer.close()
    }
  })

  test('Given loaded-list 返回非法状态或非缺失类 resume 错误 When 续接会话 Then 失败关闭且不 start 丢失历史', async () => {
    const invalidLoaded = await createMockCodexAppServer((ws, message) => {
      if (message.method === 'initialize') sendResponse(ws, message, {})
      else if (message.method === 'thread/loaded/list') sendResponse(ws, message, { data: 'invalid' })
    })
    const adapter = new CodexAppServerAdapter()
    await expect((async () => {
      for await (const _ of adapter.query({ ...baseOptions, codexAppServerPort: invalidLoaded.port, resumeSessionId: 'thread-id' })) { /* consume */ }
    })()).rejects.toThrow('无法确认 Codex 会话是否已加载')
    expect(invalidLoaded.messages.some(message => message.method === 'thread/start')).toBe(false)
    adapter.dispose()
    await invalidLoaded.close()

    const resumeFailure = await createMockCodexAppServer((ws, message) => {
      if (message.method === 'initialize') sendResponse(ws, message, {})
      else if (message.method === 'thread/loaded/list') sendResponse(ws, message, { data: [] })
      else if (message.method === 'thread/resume') ws.send(JSON.stringify({ id: message.id, error: { message: 'MCP initialization failed' } }))
    })
    const secondAdapter = new CodexAppServerAdapter()
    await expect((async () => {
      for await (const _ of secondAdapter.query({ ...baseOptions, codexAppServerPort: resumeFailure.port, resumeSessionId: 'thread-id' })) { /* consume */ }
    })()).rejects.toThrow('Codex 恢复会话失败')
    expect(resumeFailure.messages.some(message => message.method === 'thread/start')).toBe(false)
    secondAdapter.dispose()
    await resumeFailure.close()
  })

  test('Given abort 发生在图片 bridge 启动期间 When bridge 返回 Then 立即清理且不建立 WebSocket 或启动 Turn', async () => {
    let releaseBridgeStart!: () => void
    bridgeStartGate = new Promise<void>(resolve => { releaseBridgeStart = resolve })
    const adapter = new CodexAppServerAdapter()
    const pendingQuery = adapter.query({
      ...baseOptions,
      sessionId: 'session-image-start-cancel',
      codexAppServerPort: 65534,
      imageGenerationEnabled: true,
    }).next()

    expect(bridgeStarts).toHaveLength(1)
    adapter.abort('session-image-start-cancel')
    releaseBridgeStart()
    await expect(pendingQuery).rejects.toThrow('桥接启动期间取消')
    expect(bridgeCloseCount).toBe(1)
    adapter.dispose()
  })
})
