import { describe, expect, test } from 'bun:test'
import { createServer } from 'node:http'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import { CodexAppServerAdapter } from './codex-app-server-adapter'
import type { SDKAssistantMessage, SDKResultMessage } from '@copis/shared'
import type { PiWorkerQueryConfig } from '../agent-rpc-protocol'

function createMockCodexAppServer(): Promise<{
  server: WebSocketServer
  port: number
  close: () => Promise<void>
  messages: Array<Record<string, unknown>>
}> {
  return new Promise((resolve) => {
    const httpServer = createServer()
    const wss = new WebSocketServer({ server: httpServer })
    const messages: Array<Record<string, unknown>> = []

    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0

      resolve({
        server: wss,
        port,
        messages,
        close: () => new Promise<void>((done) => {
          wss.close(() => {
            httpServer.close(() => done())
          })
        }),
      })
    })
  })
}

describe('CodexAppServerAdapter', () => {
  test('Given 新会话 When 启动 query Then 完成 initialize、thread/start、turn/start 并接收流式回复与终态', async () => {
    const mock = await createMockCodexAppServer()
    let resolvedModel: string | undefined
    let recordedSessionId: string | undefined

    mock.server.on('connection', (ws: WebSocket) => {
      ws.on('message', (raw: RawData) => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>
        mock.messages.push(msg)

        if (msg.method === 'initialize') {
          ws.send(JSON.stringify({ id: msg.id, result: { serverInfo: { name: 'codex' } } }))
        } else if (msg.method === 'thread/start') {
          ws.send(JSON.stringify({ id: msg.id, result: { thread: { id: 'thread-mock-1' } } }))
        } else if (msg.method === 'turn/start') {
          ws.send(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn-mock-1' } } }))

          setTimeout(() => {
            ws.send(JSON.stringify({
              method: 'item/reasoning/textDelta',
              params: { delta: '正在分析问题...' },
            }))
            ws.send(JSON.stringify({
              method: 'item/agentMessage/delta',
              params: { delta: '你好，这是来自 Codex 的回复。' },
            }))
            ws.send(JSON.stringify({
              method: 'thread/tokenUsage/updated',
              params: { tokenUsage: { inputTokens: 120, outputTokens: 35 } },
            }))
            ws.send(JSON.stringify({
              method: 'turn/completed',
              params: { turn: { status: 'completed' } },
            }))
          }, 20)
        }
      })
    })

    const adapter = new CodexAppServerAdapter()
    const queryConfig: PiWorkerQueryConfig = {
      sessionId: 'session-codex-1',
      agentRuntime: 'codex',
      codexAppServerPort: mock.port,
      prompt: '你好测试',
      model: 'gpt-5-codex',
      thinkingLevel: 'high',
      cwd: '/tmp/test-project',
      apiKey: '',
      provider: 'openai-codex',
      permissionMode: 'bypassPermissions',
      systemPrompt: '系统指令',
      piAgentDir: '/tmp',
      piSessionDir: '/tmp/sessions',
    }

    const receivedMessages: Array<SDKAssistantMessage | SDKResultMessage> = []
    for await (const msg of adapter.query({
      ...queryConfig,
      onModelResolved: (model) => { resolvedModel = model },
      onSessionId: (id) => { recordedSessionId = id },
    })) {
      receivedMessages.push(msg as SDKAssistantMessage | SDKResultMessage)
    }

    expect(resolvedModel).toBe('gpt-5-codex')
    expect(recordedSessionId).toBe('thread-mock-1')

    const methods = mock.messages.map((m) => m.method)
    expect(methods).toContain('initialize')
    expect(methods).toContain('thread/start')
    expect(methods).toContain('turn/start')

    const threadStartMsg = mock.messages.find((m) => m.method === 'thread/start') as Record<string, unknown>
    const threadParams = threadStartMsg.params as Record<string, unknown>
    expect(threadParams.model).toBe('gpt-5-codex')
    expect(threadParams.modelProvider).toBe('copis')
    expect(threadParams.sandbox).toBe('danger-full-access')
    expect(threadParams.developerInstructions).toBe('系统指令')
    expect(threadParams.config).toMatchObject({
      model: 'gpt-5-codex',
      model_provider: 'copis',
      model_providers: {
        copis: {
          name: 'copis',
          wire_api: 'responses',
          http_headers: {
            'X-Working-Model-Source-Type': 'copis-agent-model',
          },
        },
      },
    })

    const turnStartMsg = mock.messages.find((m) => m.method === 'turn/start') as Record<string, unknown>
    const turnParams = turnStartMsg.params as Record<string, unknown>
    expect(turnParams.approvalPolicy).toBe('never')
    expect(turnParams.sandboxPolicy).toEqual({ type: 'dangerFullAccess' })
    expect(turnParams.model).toBe('gpt-5-codex')
    expect(turnParams.effort).toBe('high')

    const finalAssistant = receivedMessages.find((m) => m.type === 'assistant' && m.message.stop_reason === 'stop') as SDKAssistantMessage
    expect(finalAssistant).toBeDefined()
    expect((finalAssistant as unknown as { _partial?: boolean })._partial).toBeUndefined()

    const partialAssistants = receivedMessages.filter((m) => m.type === 'assistant' && (m as unknown as { _partial?: boolean })._partial === true)
    expect(partialAssistants.length).toBeGreaterThan(0)

    const textContent = finalAssistant.message.content.find((c) => c.type === 'text') as { type: 'text'; text: string }
    expect(textContent.text).toBe('你好，这是来自 Codex 的回复。')
    const thinkingContent = finalAssistant.message.content.find((c) => c.type === 'thinking') as { type: 'thinking'; thinking: string }
    expect(thinkingContent.thinking).toBe('正在分析问题...')

    const finalResult = receivedMessages.find((m) => m.type === 'result') as SDKResultMessage
    expect(finalResult).toBeDefined()
    expect(finalResult.subtype).toBe('success')
    expect(finalResult.usage.input_tokens).toBe(120)
    expect(finalResult.usage.output_tokens).toBe(35)

    adapter.dispose()
    await mock.close()
  })

  test('Given 已有 resumeSessionId When 启动 query Then 优先调用 thread/resume', async () => {
    const mock = await createMockCodexAppServer()
    let threadResumeCalled = false

    mock.server.on('connection', (ws: WebSocket) => {
      ws.on('message', (raw: RawData) => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>
        mock.messages.push(msg)

        if (msg.method === 'initialize') {
          ws.send(JSON.stringify({ id: msg.id, result: { serverInfo: { name: 'codex' } } }))
        } else if (msg.method === 'thread/resume') {
          threadResumeCalled = true
          ws.send(JSON.stringify({ id: msg.id, result: { thread: { id: 'thread-resumed' } } }))
        } else if (msg.method === 'turn/start') {
          ws.send(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn-2' } } }))
          setTimeout(() => {
            ws.send(JSON.stringify({
              method: 'item/agentMessage/delta',
              params: { delta: '续接回答' },
            }))
            ws.send(JSON.stringify({
              method: 'turn/completed',
              params: { turn: { status: 'completed' } },
            }))
          }, 10)
        }
      })
    })

    const adapter = new CodexAppServerAdapter()
    const queryConfig: PiWorkerQueryConfig = {
      sessionId: 'session-resume-1',
      resumeSessionId: 'thread-resumed',
      agentRuntime: 'codex',
      codexAppServerPort: mock.port,
      prompt: '续接会话',
      cwd: '/tmp/test-project',
      apiKey: '',
      provider: 'openai-codex',
      permissionMode: 'plan',
      systemPrompt: '系统指令',
      piAgentDir: '/tmp',
      piSessionDir: '/tmp/sessions',
    }

    for await (const _ of adapter.query(queryConfig)) {
      // 消费
    }

    expect(threadResumeCalled).toBe(true)
    const threadResumeMsg = mock.messages.find((m) => m.method === 'thread/resume') as Record<string, unknown>
    const threadResumeParams = threadResumeMsg.params as Record<string, unknown>
    expect(threadResumeParams.modelProvider).toBe('copis')
    expect(threadResumeParams.sandbox).toBe('read-only')
    expect(threadResumeParams.developerInstructions).toBe('系统指令')
    expect(threadResumeParams.config).toBeDefined()

    const turnStartMsg = mock.messages.find((m) => m.method === 'turn/start') as Record<string, unknown>
    const turnParams = turnStartMsg.params as Record<string, unknown>
    expect(turnParams.approvalPolicy).toBe('on-request')
    expect(turnParams.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false })

    adapter.dispose()
    await mock.close()
  })

  test('Given resume 失败时 When 执行 query Then 优雅回退到 thread/start', async () => {
    const mock = await createMockCodexAppServer()
    let threadStartCalled = false

    mock.server.on('connection', (ws: WebSocket) => {
      ws.on('message', (raw: RawData) => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>

        if (msg.method === 'initialize') {
          ws.send(JSON.stringify({ id: msg.id, result: {} }))
        } else if (msg.method === 'thread/resume') {
          ws.send(JSON.stringify({ id: msg.id, error: { message: 'no rollout found' } }))
        } else if (msg.method === 'thread/start') {
          threadStartCalled = true
          ws.send(JSON.stringify({ id: msg.id, result: { thread: { id: 'thread-fallback' } } }))
        } else if (msg.method === 'turn/start') {
          ws.send(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn-3' } } }))
          setTimeout(() => {
            ws.send(JSON.stringify({
              method: 'item/agentMessage/delta',
              params: { delta: 'fallback 成功' },
            }))
            ws.send(JSON.stringify({
              method: 'turn/completed',
              params: { turn: { status: 'completed' } },
            }))
          }, 10)
        }
      })
    })

    const adapter = new CodexAppServerAdapter()
    const queryConfig: PiWorkerQueryConfig = {
      sessionId: 'session-fallback-1',
      resumeSessionId: 'stale-thread-id',
      agentRuntime: 'codex',
      codexAppServerPort: mock.port,
      prompt: '重试消息',
      cwd: '/tmp/test-project',
      apiKey: '',
      provider: 'openai-codex',
      permissionMode: 'plan',
      systemPrompt: '系统指令',
      piAgentDir: '/tmp',
      piSessionDir: '/tmp/sessions',
    }

    for await (const _ of adapter.query(queryConfig)) {
      // 消费
    }

    expect(threadStartCalled).toBe(true)
    adapter.dispose()
    await mock.close()
  })

  test('Given 运行中调用 abort When 执行打断 Then 发送 turn/interrupt 并生成 aborted 终态', async () => {
    const mock = await createMockCodexAppServer()
    let interruptReceived = false

    mock.server.on('connection', (ws: WebSocket) => {
      ws.on('message', (raw: RawData) => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>

        if (msg.method === 'initialize') {
          ws.send(JSON.stringify({ id: msg.id, result: {} }))
        } else if (msg.method === 'thread/start') {
          ws.send(JSON.stringify({ id: msg.id, result: { thread: { id: 'thread-abort' } } }))
        } else if (msg.method === 'turn/start') {
          ws.send(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn-abort' } } }))
          ws.send(JSON.stringify({
            method: 'item/agentMessage/delta',
            params: { delta: '第一句...' },
          }))
        } else if (msg.method === 'turn/interrupt') {
          interruptReceived = true
          ws.send(JSON.stringify({
            method: 'turn/completed',
            params: { turn: { status: 'interrupted' } },
          }))
        }
      })
    })

    const adapter = new CodexAppServerAdapter()
    const queryConfig: PiWorkerQueryConfig = {
      sessionId: 'session-abort-1',
      agentRuntime: 'codex',
      codexAppServerPort: mock.port,
      prompt: '长回答',
      cwd: '/tmp/test-project',
      apiKey: '',
      provider: 'openai-codex',
      permissionMode: 'plan',
      systemPrompt: '系统指令',
      piAgentDir: '/tmp',
      piSessionDir: '/tmp/sessions',
    }

    const messages: SDKResultMessage[] = []
    const iterator = adapter.query(queryConfig)

    const first = await iterator.next()
    expect(first.done).toBe(false)
    adapter.abort('session-abort-1')

    while (true) {
      const next = await iterator.next()
      if (next.done) break
      if (next.value.type === 'result') {
        messages.push(next.value as SDKResultMessage)
      }
    }

    expect(interruptReceived).toBe(true)
    const resultMsg = messages[0]
    expect(resultMsg).toBeDefined()
    expect(resultMsg?.subtype).toBe('aborted')

    adapter.dispose()
    await mock.close()
  })

  test('Given Copis 虚拟模型与思考等级 When 调用 resolveCodexTurnModelAndEffort Then 正确规范化模型名并映射 effort', async () => {
    const { resolveCodexTurnModelAndEffort } = await import('./codex-app-server-adapter')

    // 默认渠道 fast 模式
    expect(resolveCodexTurnModelAndEffort('fast')).toEqual({ model: 'fast', effort: 'medium' })
    // 默认渠道 export / expert 模式
    expect(resolveCodexTurnModelAndEffort('export')).toEqual({ model: 'export', effort: 'high' })
    expect(resolveCodexTurnModelAndEffort('expert')).toEqual({ model: 'export', effort: 'high' })
    // codex / default 内部别名回退至 fast (effort 对应 medium)
    expect(resolveCodexTurnModelAndEffort('codex')).toEqual({ model: 'fast', effort: 'medium' })
    expect(resolveCodexTurnModelAndEffort('default')).toEqual({ model: 'fast', effort: 'medium' })
    expect(resolveCodexTurnModelAndEffort()).toEqual({ model: 'fast', effort: 'medium' })
    // 带有显式 thinkingLevel
    expect(resolveCodexTurnModelAndEffort('fast', 'low')).toEqual({ model: 'fast', effort: 'low' })
    // 真实原生模型
    expect(resolveCodexTurnModelAndEffort('gpt-5-codex', 'high')).toEqual({ model: 'gpt-5-codex', effort: 'high' })
    expect(resolveCodexTurnModelAndEffort('o3-mini')).toEqual({ model: 'o3-mini' })
  })

  test('Given Codex App Server error 通知包含 JSON 格式错误 When extractCodexErrorMessage Then 正确解包内层错误信息', async () => {
    const { extractCodexErrorMessage } = await import('./codex-app-server-adapter')

    const nestedError = {
      error: {
        message: JSON.stringify({
          type: 'error',
          status: 400,
          error: {
            type: 'invalid_request_error',
            message: "The 'fast' model is not supported when using Codex with a ChatGPT account.",
          },
        }),
      },
    }
    expect(extractCodexErrorMessage(nestedError)).toBe(
      "The 'fast' model is not supported when using Codex with a ChatGPT account."
    )

    const plainError = {
      error: {
        message: '连接远端模型超时',
      },
    }
    expect(extractCodexErrorMessage(plainError)).toBe('连接远端模型超时')
  })

  test('Given 自定义模型渠道 (copis-custom-*) When 执行 query Then 使用用户自定义 API 配置与 custom provider，且不携带内部计费头', async () => {
    const mock = await createMockCodexAppServer()
    let resolvedModel: string | undefined

    mock.server.on('connection', (ws: WebSocket) => {
      ws.on('message', (raw: RawData) => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>
        mock.messages.push(msg)

        if (msg.method === 'initialize') {
          ws.send(JSON.stringify({ id: msg.id, result: {} }))
        } else if (msg.method === 'thread/start') {
          ws.send(JSON.stringify({ id: msg.id, result: { thread: { id: 'thread-custom-1' } } }))
        } else if (msg.method === 'turn/start') {
          ws.send(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn-custom-1' } } }))
          setTimeout(() => {
            ws.send(JSON.stringify({
              method: 'item/agentMessage/delta',
              params: { delta: '自定义模型已响应' },
            }))
            ws.send(JSON.stringify({
              method: 'turn/completed',
              params: { turn: { status: 'completed' } },
            }))
          }, 10)
        }
      })
    })

    const adapter = new CodexAppServerAdapter()
    const queryConfig: PiWorkerQueryConfig = {
      sessionId: 'session-custom-1',
      agentRuntime: 'codex',
      codexAppServerPort: mock.port,
      channelId: 'copis-custom-gpt4o-preview',
      prompt: '自定义模型问答',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-user-custom-secret',
      provider: 'custom',
      permissionMode: 'bypassPermissions',
      systemPrompt: '系统指令',
      piAgentDir: '/tmp',
      piSessionDir: '/tmp/sessions',
    }

    const receivedMessages: Array<SDKAssistantMessage | SDKResultMessage> = []
    for await (const msg of adapter.query({
      ...queryConfig,
      onModelResolved: (model) => { resolvedModel = model },
    })) {
      receivedMessages.push(msg as SDKAssistantMessage | SDKResultMessage)
    }

    expect(resolvedModel).toBe('gpt-4o')

    const threadStartMsg = mock.messages.find((m) => m.method === 'thread/start') as Record<string, unknown>
    const threadParams = threadStartMsg.params as Record<string, unknown>
    expect(threadParams.model).toBe('gpt-4o')
    expect(threadParams.modelProvider).toBe('custom')
    expect(threadParams.config).toMatchObject({
      model: 'gpt-4o',
      model_provider: 'custom',
      model_providers: {
        custom: {
          name: 'custom',
          wire_api: 'responses',
          base_url: 'https://api.openai.com/v1',
          experimental_bearer_token: 'sk-user-custom-secret',
        },
      },
    })

    const customProvider = (threadParams.config as Record<string, unknown>).model_providers as Record<string, Record<string, unknown>>
    expect(customProvider.custom?.http_headers).toBeUndefined()

    const turnStartMsg = mock.messages.find((m) => m.method === 'turn/start') as Record<string, unknown>
    const turnParams = turnStartMsg.params as Record<string, unknown>
    expect(turnParams.model).toBe('gpt-4o')

    const finalAssistant = receivedMessages.find((m) => m.type === 'assistant' && m.message.stop_reason === 'stop') as SDKAssistantMessage
    expect(finalAssistant).toBeDefined()
    expect(finalAssistant.message.model).toBe('gpt-4o')
    expect(finalAssistant._channelModelId).toBe('gpt-4o')

    adapter.dispose()
    await mock.close()
  })

  test('Given 非自定义模型渠道 (copis-working) When 传入外部 baseUrl Then 严格忽略并强制使用本地 Rust HTTP API 网关与内部计费头', async () => {
    const mock = await createMockCodexAppServer()

    mock.server.on('connection', (ws: WebSocket) => {
      ws.on('message', (raw: RawData) => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>
        mock.messages.push(msg)

        if (msg.method === 'initialize') {
          ws.send(JSON.stringify({ id: msg.id, result: {} }))
        } else if (msg.method === 'thread/start') {
          ws.send(JSON.stringify({ id: msg.id, result: { thread: { id: 'thread-builtin-1' } } }))
        } else if (msg.method === 'turn/start') {
          ws.send(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn-builtin-1' } } }))
          setTimeout(() => {
            ws.send(JSON.stringify({
              method: 'turn/completed',
              params: { turn: { status: 'completed' } },
            }))
          }, 10)
        }
      })
    })

    const adapter = new CodexAppServerAdapter()
    const queryConfig: PiWorkerQueryConfig = {
      sessionId: 'session-builtin-1',
      agentRuntime: 'codex',
      codexAppServerPort: mock.port,
      channelId: 'copis-working',
      prompt: '内置模型问答',
      model: 'fast',
      baseUrl: 'https://unexpected-override-domain.com/v1',
      apiKey: 'test-capability-token',
      provider: 'openai-responses',
      permissionMode: 'bypassPermissions',
      systemPrompt: '系统指令',
      piAgentDir: '/tmp',
      piSessionDir: '/tmp/sessions',
    }

    for await (const _ of adapter.query(queryConfig)) {
      // 消费
    }

    const threadStartMsg = mock.messages.find((m) => m.method === 'thread/start') as Record<string, unknown>
    const threadParams = threadStartMsg.params as Record<string, unknown>
    expect(threadParams.model).toBe('fast')
    expect(threadParams.modelProvider).toBe('copis')

    const config = threadParams.config as Record<string, unknown>
    const modelProviders = config.model_providers as Record<string, Record<string, unknown>>
    const copisProvider = modelProviders.copis!

    expect(copisProvider.name).toBe('copis')
    expect(copisProvider.wire_api).toBe('responses')
    // 必须指向本地 127.0.0.1 端口网关，不能被外部 baseUrl 篡改
    expect(copisProvider.base_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/internal\/working-model\/v1$/)
    expect(copisProvider.base_url).not.toContain('unexpected-override-domain.com')
    expect(copisProvider.experimental_bearer_token).toBe('test-capability-token')
    expect(copisProvider.http_headers).toEqual({
      'X-Working-Model-Source-Type': 'copis-agent-model',
    })

    adapter.dispose()
    await mock.close()
  })

  test('Given Codex App Server 发送临时重试通知 (willRetry=true 或 Reconnecting...) When 执行 query Then 不应直接失败中断，在后续成功完成时正常返回结果', async () => {
    const mock = await createMockCodexAppServer()

    mock.server.on('connection', (ws: WebSocket) => {
      ws.on('message', (raw: RawData) => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>
        mock.messages.push(msg)

        if (msg.method === 'initialize') {
          ws.send(JSON.stringify({ id: msg.id, result: {} }))
        } else if (msg.method === 'thread/start') {
          ws.send(JSON.stringify({ id: msg.id, result: { thread: { id: 'thread-retry-1' } } }))
        } else if (msg.method === 'turn/start') {
          ws.send(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn-retry-1' } } }))

          setTimeout(() => {
            // 先发送一条临时重试通知
            ws.send(JSON.stringify({
              method: 'error',
              params: {
                error: { message: 'stream connection failed; waiting to retry: Reconnecting... 1/5' },
                willRetry: true,
              },
            }))

            // 随后重试成功，正常输出内容并完成
            setTimeout(() => {
              ws.send(JSON.stringify({
                method: 'item/agentMessage/delta',
                params: { delta: '重试成功后的回复' },
              }))
              ws.send(JSON.stringify({
                method: 'turn/completed',
                params: { turn: { status: 'completed' } },
              }))
            }, 20)
          }, 10)
        }
      })
    })

    const adapter = new CodexAppServerAdapter()
    const queryConfig: PiWorkerQueryConfig = {
      sessionId: 'session-retry-1',
      agentRuntime: 'codex',
      codexAppServerPort: mock.port,
      channelId: 'copis-working',
      prompt: '重试测试',
      model: 'fast',
      apiKey: '',
      provider: 'openai-responses',
      permissionMode: 'bypassPermissions',
      systemPrompt: '系统指令',
      piAgentDir: '/tmp',
      piSessionDir: '/tmp/sessions',
    }

    const receivedMessages: Array<SDKAssistantMessage | SDKResultMessage> = []
    for await (const msg of adapter.query(queryConfig)) {
      receivedMessages.push(msg as SDKAssistantMessage | SDKResultMessage)
    }

    const assistantMsg = receivedMessages.find((m) => m.type === 'assistant') as SDKAssistantMessage | undefined
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg?.message.content[0]).toEqual({
      type: 'text',
      text: '重试成功后的回复',
    })

    const resultMsg = receivedMessages.find((m) => m.type === 'result') as SDKResultMessage | undefined
    expect(resultMsg).toBeDefined()
    expect(resultMsg?.subtype).toBe('success')

    adapter.dispose()
    await mock.close()
  })

  test('Given 内置模型传入本地网关 baseUrl (如开发端口 51740) When 执行 query Then 保持该 baseUrl 端口配置', async () => {
    const mock = await createMockCodexAppServer()

    mock.server.on('connection', (ws: WebSocket) => {
      ws.on('message', (raw: RawData) => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>
        mock.messages.push(msg)

        if (msg.method === 'initialize') {
          ws.send(JSON.stringify({ id: msg.id, result: {} }))
        } else if (msg.method === 'thread/start') {
          ws.send(JSON.stringify({ id: msg.id, result: { thread: { id: 'thread-devport-1' } } }))
        } else if (msg.method === 'turn/start') {
          ws.send(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn-devport-1' } } }))
          setTimeout(() => {
            ws.send(JSON.stringify({
              method: 'turn/completed',
              params: { turn: { status: 'completed' } },
            }))
          }, 10)
        }
      })
    })

    const adapter = new CodexAppServerAdapter()
    const queryConfig: PiWorkerQueryConfig = {
      sessionId: 'session-devport-1',
      agentRuntime: 'codex',
      codexAppServerPort: mock.port,
      channelId: 'copis-working',
      prompt: '开发端口网关测试',
      model: 'fast',
      baseUrl: 'http://127.0.0.1:51740/api/internal/working-model/v1',
      apiKey: 'test-capability-token-51740',
      provider: 'openai-responses',
      permissionMode: 'bypassPermissions',
      systemPrompt: '系统指令',
      piAgentDir: '/tmp',
      piSessionDir: '/tmp/sessions',
    }

    for await (const _ of adapter.query(queryConfig)) {
      // 消费
    }

    const threadStartMsg = mock.messages.find((m) => m.method === 'thread/start') as Record<string, unknown>
    const threadParams = threadStartMsg.params as Record<string, unknown>
    const config = threadParams.config as Record<string, unknown>
    const modelProviders = config.model_providers as Record<string, Record<string, unknown>>
    const copisProvider = modelProviders.copis!

    expect(copisProvider.base_url).toBe('http://127.0.0.1:51740/api/internal/working-model/v1')
    expect(copisProvider.experimental_bearer_token).toBe('test-capability-token-51740')

    adapter.dispose()
    await mock.close()
  })

  test('Given 包含 additionalSkillPaths 的专业模式会话 When 启动 query Then 在 initialize 后自动向 Codex App Server 发送 skills/extraRoots/set 注册技能路径', async () => {
    const mock = await createMockCodexAppServer()
    const customSkillPath = '/workspace/custom/.agents/skills'

    mock.server.on('connection', (ws: WebSocket) => {
      ws.on('message', (raw: RawData) => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>
        mock.messages.push(msg)

        if (msg.method === 'initialize') {
          ws.send(JSON.stringify({ id: msg.id, result: {} }))
        } else if (msg.method === 'skills/extraRoots/set') {
          ws.send(JSON.stringify({ id: msg.id, result: {} }))
        } else if (msg.method === 'thread/start') {
          ws.send(JSON.stringify({ id: msg.id, result: { thread: { id: 'thread-skills-1' } } }))
        } else if (msg.method === 'turn/start') {
          ws.send(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn-skills-1' } } }))
          setTimeout(() => {
            ws.send(JSON.stringify({
              method: 'turn/completed',
              params: { turn: { status: 'completed' } },
            }))
          }, 10)
        }
      })
    })

    const adapter = new CodexAppServerAdapter()
    const queryConfig: PiWorkerQueryConfig = {
      sessionId: 'session-skills-1',
      agentRuntime: 'codex',
      codexAppServerPort: mock.port,
      channelId: 'copis-working',
      prompt: '技能测试',
      apiKey: 'test-key',
      provider: 'openai-responses',
      systemPrompt: '系统指令',
      additionalSkillPaths: [customSkillPath],
      permissionMode: 'bypassPermissions',
      piAgentDir: '/tmp',
      piSessionDir: '/tmp/sessions',
    }

    for await (const _ of adapter.query(queryConfig)) {
      // 消费流
    }

    const methods = mock.messages.map((m) => m.method)
    expect(methods).toContain('initialize')
    expect(methods).toContain('skills/extraRoots/set')
    expect(methods).toContain('thread/start')

    const skillReq = mock.messages.find((m) => m.method === 'skills/extraRoots/set') as Record<string, unknown>
    expect(skillReq).toBeDefined()
    const skillParams = skillReq.params as Record<string, unknown>
    expect(skillParams.extraRoots).toEqual([customSkillPath])

    adapter.dispose()
    await mock.close()
  })

  test('Given Codex App Server 发送审批请求 (item/commandExecution/requestApproval 与 applyPatchApproval) When bypassPermissions Then 自动回复允许决策', async () => {
    const mock = await createMockCodexAppServer()
    const receivedApprovals: Array<Record<string, unknown>> = []

    mock.server.on('connection', (ws: WebSocket) => {
      ws.on('message', (raw: RawData) => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>

        if (msg.method === 'initialize') {
          ws.send(JSON.stringify({ id: msg.id, result: {} }))
        } else if (msg.method === 'thread/start') {
          ws.send(JSON.stringify({ id: msg.id, result: { thread: { id: 'thread-approval' } } }))
        } else if (msg.method === 'turn/start') {
          ws.send(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn-approval' } } }))
          // 模拟服务端发起审批请求
          ws.send(JSON.stringify({
            id: 991,
            method: 'item/commandExecution/requestApproval',
            params: { command: 'powershell -Command "echo 1"' },
          }))
          ws.send(JSON.stringify({
            id: 992,
            method: 'applyPatchApproval',
            params: { callId: 'patch-1', fileChanges: {} },
          }))
        } else if (typeof msg.id === 'number' && msg.result) {
          // 记录客户端发回的审批响应
          receivedApprovals.push(msg)
          if (receivedApprovals.length === 2) {
            ws.send(JSON.stringify({
              method: 'turn/completed',
              params: { turn: { id: 'turn-approval', status: 'completed' } },
            }))
          }
        }
      })
    })

    const adapter = new CodexAppServerAdapter()
    const queryConfig: PiWorkerQueryConfig = {
      sessionId: 'session-approval-1',
      agentRuntime: 'codex',
      codexAppServerPort: mock.port,
      prompt: '审批测试',
      apiKey: 'test-key',
      provider: 'openai-codex',
      systemPrompt: '系统指令',
      permissionMode: 'bypassPermissions',
      piAgentDir: '/tmp',
      piSessionDir: '/tmp/sessions',
    }

    for await (const _ of adapter.query(queryConfig)) {
      // 消费流
    }

    expect(receivedApprovals.length).toBe(2)
    const cmdApproval = receivedApprovals.find((a) => a.id === 991)
    expect(cmdApproval?.result).toEqual({ decision: 'accept' })
    const patchApproval = receivedApprovals.find((a) => a.id === 992)
    expect(patchApproval?.result).toEqual({ decision: 'approved' })

    adapter.dispose()
    await mock.close()
  })
})

