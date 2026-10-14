/**
 * Codex App Server Adapter
 *
 * 负责在 RPC Worker 运行时中与本地 Codex App Server 守护进程进行 WebSocket JSON-RPC 通信：
 * - 握手 initialize；
 * - 会话 Thread 恢复/分叉 (thread/resume、thread/fork) 与新建 (thread/start)；
 * - Turn 发起与流式 delta 解析（正文 agentMessage/delta 与思考链 reasoning/textDelta）；
 * - 转换为 Copis 标准的 SDKAssistantMessage 与 SDKResultMessage；
 * - 支持 turn/interrupt 打断。
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'
import {
  isWorkingCustomModelChannelId,
  type AgentProviderAdapter,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessageInput,
  type SendQueuedMessageOptions,
} from '@copis/shared'
import { resolveCopisHttpApiPort } from '@copis/shared/config'
import type { PiWorkerQueryConfig } from '../agent-rpc-protocol'
import {
  CODEX_IMAGE_MCP_SERVER_NAME,
  startCodexImageToolsMcp,
  type CodexImageToolCall,
  type CodexImageToolResult,
} from './codex-image-tools-mcp'

const DEFAULT_CODEX_PORT = 54080
const WS_CONNECT_TIMEOUT_MS = 10_000
const RPC_TIMEOUT_MS = 30_000
const PARTIAL_THROTTLE_MS = 30

export interface CodexWebSocketClient {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: unknown) => void) | null
  onclose: ((ev: unknown) => void) | null
  terminate?: () => void
}

interface ActiveSessionEntry {
  ws?: CodexWebSocketClient
  threadId: string
  turnId?: string
  aborted: boolean
  closeImageBridge?: () => Promise<void>
}

/**
 * 辅助函数：将 Copis 模型与思考等级映射为 Codex App Server 的 turn/start 参数。
 *
 * 专业模式与普通模式 (pi-runtime) 一致，通过 Working Responses 接口转发至 edu-api。
 * 模型必须传递真实的 Copis 模型 ID（'fast'、'export' 或自定义模型名），不能置空；
 * 内部别名 'codex' 或 'default' 规范化为默认的 'fast' 模型。
 */
export function resolveCodexTurnModelAndEffort(
  model?: string,
  thinkingLevel?: string,
): { model: string; effort?: string } {
  const resolvedModel = (!model || model === 'codex' || model === 'default')
    ? 'fast'
    : (model === 'expert' ? 'export' : model)

  let resolvedEffort: string | undefined
  if (thinkingLevel) {
    const effortMap: Record<string, string> = {
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'high',
    }
    resolvedEffort = effortMap[thinkingLevel] ?? 'high'
  } else if (resolvedModel === 'fast') {
    resolvedEffort = 'medium'
  } else if (resolvedModel === 'export') {
    resolvedEffort = 'high'
  }

  return {
    model: resolvedModel,
    ...(resolvedEffort ? { effort: resolvedEffort } : {}),
  }
}

/**
 * 辅助函数：从 Codex App Server 的 error 通知中提取可读的友好错误信息。
 */
export function extractCodexErrorMessage(params: Record<string, unknown>): string {
  let rawMessage = ''
  if (typeof params.message === 'string' && params.message.trim().length > 0) {
    rawMessage = params.message
  } else if (params.error && typeof params.error === 'object') {
    const errorObj = params.error as Record<string, unknown>
    if (typeof errorObj.message === 'string' && errorObj.message.trim().length > 0) {
      rawMessage = errorObj.message
    } else if (typeof errorObj.additionalDetails === 'string' && errorObj.additionalDetails.trim().length > 0) {
      rawMessage = errorObj.additionalDetails
    }
  }

  if (!rawMessage) {
    return 'Codex App Server 服务端报错'
  }

  // 尝试反序列化 JSON 嵌套的 API 错误信息（例如 OpenAI API 错误）
  try {
    const parsed = JSON.parse(rawMessage) as Record<string, unknown>
    if (parsed.error && typeof parsed.error === 'object') {
      const innerErr = parsed.error as Record<string, unknown>
      if (typeof innerErr.message === 'string' && innerErr.message.trim().length > 0) {
        return innerErr.message
      }
    }
    if (typeof parsed.message === 'string' && parsed.message.trim().length > 0) {
      return parsed.message
    }
  } catch {
    // 非 JSON 字符串，直接返回 rawMessage
  }

  return rawMessage
}

function isCodexThreadNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /no rollout found|thread\s+(?:was\s+)?not found|thread does not exist|rollout.*not found/i.test(message)
}

class AsyncQueue<T> {
  private queue: T[] = []
  private resolvers: Array<(value: IteratorResult<T>) => void> = []
  private rejecters: Array<(error: unknown) => void> = []
  private closed = false
  private error: unknown = null

  push(value: T): void {
    if (this.closed || this.error) return
    const resolver = this.resolvers.shift()
    if (resolver) {
      resolver({ value, done: false })
    } else {
      this.queue.push(value)
    }
  }

  close(): void {
    this.closed = true
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()
      resolver?.({ value: undefined as unknown as T, done: true })
    }
  }

  fail(err: unknown): void {
    this.error = err
    while (this.rejecters.length > 0) {
      const rejecter = this.rejecters.shift()
      rejecter?.(err)
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.error) throw this.error
    if (this.queue.length > 0) {
      return { value: this.queue.shift()!, done: false }
    }
    if (this.closed) {
      return { value: undefined as unknown as T, done: true }
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.resolvers.push(resolve)
      this.rejecters.push(reject)
    })
  }
}

export type CodexAppServerQueryOptions = PiWorkerQueryConfig & {
  onSessionId?: (sdkSessionId: string, sessionFile?: string) => void
  onModelResolved?: (model: string) => void
}

export class CodexAppServerAdapter implements AgentProviderAdapter {
  private readonly activeSessions = new Map<string, ActiveSessionEntry>()

  /**
   * 执行单轮 Codex 问答，流式返回 SDKMessage
   */
  async *query(options: CodexAppServerQueryOptions): AsyncGenerator<SDKMessage> {
    const isCustomModel = isWorkingCustomModelChannelId(options.channelId)
    const { model: resolvedModel, effort: resolvedEffort } = resolveCodexTurnModelAndEffort(options.model, options.thinkingLevel)
    const targetModel = isCustomModel ? (options.model ?? resolvedModel) : resolvedModel
    options.onModelResolved?.(targetModel)
    const port = options.codexAppServerPort ?? DEFAULT_CODEX_PORT
    const wsUrl = `ws://127.0.0.1:${port}`
    const queue = new AsyncQueue<SDKMessage>()
    const assistantUuid = randomUUID()
    const startedAt = options.retryRunStartedAt ?? Date.now()

    const imageToolsEnabled = options.imageGenerationEnabled === true
      && options.capabilityProfile !== 'chatroom'
      && options.permissionMode !== 'plan'
    const toolCalls = new Set<string>()
    let imageBridge: Awaited<ReturnType<typeof startCodexImageToolsMcp>> | undefined
    let imageBridgeClosePromise: Promise<void> | undefined
    const closeImageBridge = (): Promise<void> => {
      if (!imageBridge) return Promise.resolve()
      imageBridgeClosePromise ??= imageBridge.close().catch(() => {
        console.warn('[Codex App Server] 关闭 Copis 图片工具桥接失败')
      })
      return imageBridgeClosePromise
    }
    const sessionEntry: ActiveSessionEntry = {
      threadId: '',
      aborted: false,
      closeImageBridge,
    }
    // 从桥接启动开始就登记 session，使 dispose/abort 可以取消整个准备阶段。
    this.activeSessions.set(options.sessionId, sessionEntry)

    const emitToolUse = (call: CodexImageToolCall) => {
      if (toolCalls.has(call.callId)) return
      toolCalls.add(call.callId)
      queue.push({
        type: 'assistant',
        uuid: randomUUID(),
        session_id: options.sessionId,
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          model: targetModel,
          content: [{
            type: 'tool_use',
            id: call.callId,
            name: call.name,
            input: call.arguments,
          }],
          stop_reason: 'tool_use',
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
        _channelModelId: targetModel,
        _createdAt: Date.now(),
      } as unknown as SDKAssistantMessage)
    }

    if (imageToolsEnabled) {
      try {
        imageBridge = await startCodexImageToolsMcp({
          sessionId: options.sessionId,
          cwd: options.cwd,
          onToolStart: emitToolUse,
          onToolResult: (result: CodexImageToolResult) => {
            emitToolUse(result)
            queue.push({
              type: 'user',
              uuid: randomUUID(),
              session_id: options.sessionId,
              parent_tool_use_id: null,
              message: {
                content: [{
                  type: 'tool_result',
                  tool_use_id: result.callId,
                  content: result.content,
                  is_error: result.isError,
                }],
              },
              tool_use_result: result.details,
            } as unknown as SDKMessage)
          },
        })
      } catch {
        this.activeSessions.delete(options.sessionId)
        throw new Error('Copis 图片工具桥接启动失败，未继续本轮会话')
      }
    }
    if (sessionEntry.aborted) {
      await closeImageBridge()
      this.activeSessions.delete(options.sessionId)
      throw new Error('Codex 会话已在图片工具桥接启动期间取消')
    }

    let ws: CodexWebSocketClient
    try {
      ws = await this.connectWebSocket(wsUrl)
    } catch (err) {
      await closeImageBridge()
      this.activeSessions.delete(options.sessionId)
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`连接 Codex App Server 失败 (${wsUrl}): ${msg}`)
    }
    sessionEntry.ws = ws
    if (sessionEntry.aborted) {
      await closeImageBridge()
      this.activeSessions.delete(options.sessionId)
      try { ws.close() } catch { /* 忽略关闭异常 */ }
      throw new Error('Codex 会话已在连接期间取消')
    }

    let nextRequestId = 1
    const pendingRequests = new Map<number, {
      resolve: (res: Record<string, unknown>) => void
      reject: (err: Error) => void
      timer: ReturnType<typeof setTimeout>
    }>()

    const sendRequest = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
      return new Promise((resolve, reject) => {
        if (ws.readyState !== 1 /* WebSocket.OPEN */) {
          return reject(new Error(`WebSocket 未处于打开状态 (readyState=${ws.readyState})`))
        }
        const id = nextRequestId++
        const timer = setTimeout(() => {
          pendingRequests.delete(id)
          reject(new Error(`Codex RPC 请求超时: method=${method}, id=${id}`))
        }, RPC_TIMEOUT_MS)

        pendingRequests.set(id, { resolve, reject, timer })
        ws.send(JSON.stringify({ method, id, params }))
      })
    }
    const rejectPendingRequests = (reason: string) => {
      for (const req of pendingRequests.values()) {
        clearTimeout(req.timer)
        req.reject(new Error(reason))
      }
      pendingRequests.clear()
    }

    let accumulatedText = ''
    let accumulatedThinking = ''
    const tokens = { input_tokens: 0, output_tokens: 0 }
    let lastPartialPushTime = 0
    let partialPushTimer: ReturnType<typeof setTimeout> | null = null

    const flushPartial = (force = false) => {
      const now = Date.now()
      if (!force && now - lastPartialPushTime < PARTIAL_THROTTLE_MS) {
        if (!partialPushTimer) {
          partialPushTimer = setTimeout(() => {
            partialPushTimer = null
            flushPartial(true)
          }, PARTIAL_THROTTLE_MS)
        }
        return
      }
      if (partialPushTimer) {
        clearTimeout(partialPushTimer)
        partialPushTimer = null
      }
      lastPartialPushTime = now

      const content: Array<{ type: 'thinking'; thinking: string } | { type: 'text'; text: string }> = []
      if (accumulatedThinking) {
        content.push({ type: 'thinking', thinking: accumulatedThinking })
      }
      if (accumulatedText) {
        content.push({ type: 'text', text: accumulatedText })
      }
      if (content.length === 0) return

      const partial: SDKAssistantMessage = {
        type: 'assistant',
        uuid: assistantUuid,
        session_id: options.sessionId,
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          model: targetModel,
          content,
          stop_reason: null,
          usage: {
            input_tokens: tokens.input_tokens,
            output_tokens: tokens.output_tokens,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
        _partial: true,
        _channelModelId: targetModel,
        _createdAt: startedAt,
      } as unknown as SDKAssistantMessage

      queue.push(partial)
    }

    ws.onmessage = (event: { data: unknown }) => {
      try {
        const text = typeof event.data === 'string'
          ? event.data
          : (typeof Buffer !== 'undefined' && Buffer.isBuffer(event.data))
            ? event.data.toString('utf8')
            : String(event.data)
        const data = JSON.parse(text) as Record<string, unknown>

        // 响应处理
        if (typeof data.id === 'number' && pendingRequests.has(data.id)) {
          const req = pendingRequests.get(data.id)!
          pendingRequests.delete(data.id)
          clearTimeout(req.timer)
          if (data.error) {
            const errObj = data.error as Record<string, unknown>
            req.reject(new Error(String(errObj.message || 'RPC 响应错误')))
          } else {
            req.resolve((data.result as Record<string, unknown>) || {})
          }
          return
        }

        // 服务端请求处理 (JSON-RPC ServerRequest)
        if (typeof data.id === 'number' && typeof data.method === 'string') {
          const reqId = data.id
          const reqMethod = data.method
          const isBypass = options.permissionMode === 'bypassPermissions' && options.advancedAuthorization === true

          switch (reqMethod) {
            case 'item/commandExecution/requestApproval':
            case 'item/fileChange/requestApproval':
            case 'item/permissions/requestApproval':
              try {
                ws.send(JSON.stringify({
                  id: reqId,
                  result: { decision: isBypass ? 'accept' : 'decline' },
                }))
              } catch (err) {
                console.warn(`[Codex App Server Adapter] 响应 ${reqMethod} 失败:`, err)
              }
              return

            case 'execCommandApproval':
            case 'applyPatchApproval':
              try {
                ws.send(JSON.stringify({
                  id: reqId,
                  result: { decision: isBypass ? 'approved' : 'denied' },
                }))
              } catch (err) {
                console.warn(`[Codex App Server Adapter] 响应 ${reqMethod} 失败:`, err)
              }
              return

            default:
              console.warn(`[Codex App Server Adapter] 收到未显式处理的 ServerRequest: ${reqMethod} (id=${reqId})`)
              break
          }
        }

        // 通知处理
        const method = typeof data.method === 'string' ? data.method : ''
        const params = (data.params as Record<string, unknown>) || {}

        switch (method) {
          case 'item/agentMessage/delta': {
            const delta = typeof params.delta === 'string' ? params.delta : ''
            if (delta) {
              accumulatedText += delta
              flushPartial()
            }
            break
          }

          case 'item/reasoning/textDelta':
          case 'item/reasoning/summaryTextDelta': {
            const delta = typeof params.delta === 'string' ? params.delta : ''
            if (delta) {
              accumulatedThinking += delta
              flushPartial()
            }
            break
          }

          case 'thread/tokenUsage/updated': {
            const usage = (params.tokenUsage as Record<string, unknown>) || {}
            if (typeof usage.inputTokens === 'number') tokens.input_tokens = usage.inputTokens
            if (typeof usage.outputTokens === 'number') tokens.output_tokens = usage.outputTokens
            break
          }

          case 'turn/completed': {
            if (partialPushTimer) {
              clearTimeout(partialPushTimer)
              partialPushTimer = null
            }
            const turn = (params.turn as Record<string, unknown>) || {}
            const turnStatus = turn.status === 'completed' ? 'completed' : String(turn.status || 'completed')

            // 最终输出 assistant 终态消息
            const finalContent: Array<{ type: 'thinking'; thinking: string } | { type: 'text'; text: string }> = []
            if (accumulatedThinking) {
              finalContent.push({ type: 'thinking', thinking: accumulatedThinking })
            }
            finalContent.push({ type: 'text', text: accumulatedText })

            const finalAssistant: SDKAssistantMessage = {
              type: 'assistant',
              uuid: assistantUuid,
              session_id: options.sessionId,
              parent_tool_use_id: null,
              message: {
                role: 'assistant',
                model: targetModel,
                content: finalContent,
                stop_reason: 'stop',
                usage: {
                  input_tokens: tokens.input_tokens,
                  output_tokens: tokens.output_tokens,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 0,
                },
              },
              _channelModelId: targetModel,
              _createdAt: Date.now(),
            } as unknown as SDKAssistantMessage
            queue.push(finalAssistant)

            // 终态 Result 消息
            const finalResult: SDKResultMessage = {
              type: 'result',
              session_id: options.sessionId,
              subtype: sessionEntry.aborted ? 'aborted' : (turnStatus === 'completed' ? 'success' : 'error_during_execution'),
              terminal_reason: 'completed',
              total_cost_usd: 0,
              usage: {
                input_tokens: tokens.input_tokens,
                output_tokens: tokens.output_tokens,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
              _durationMs: Date.now() - startedAt,
              _createdAt: Date.now(),
            } as unknown as SDKResultMessage
            queue.push(finalResult)

            queue.close()
            break
          }

          case 'thread/started': {
            const thread = (params.thread as Record<string, unknown>) || {}
            if (typeof thread.model === 'string' && thread.model) {
              options.onModelResolved?.(thread.model)
            }
            break
          }

          case 'model/rerouted': {
            if (typeof params.toModel === 'string' && params.toModel) {
              options.onModelResolved?.(params.toModel)
            }
            break
          }

          case 'error': {
            const message = extractCodexErrorMessage(params)
            const isTransient = params.willRetry === true || message.startsWith('Reconnecting')
            if (isTransient) {
              console.warn(`[Codex App Server Adapter] 捕获到临时重试通知 (willRetry=true): ${message}`)
              break
            }
            queue.fail(new Error(message))
            break
          }
        }
      } catch (err) {
        console.warn('[Codex App Server Adapter] 解析消息失败:', err)
      }
    }

    ws.onerror = (err: unknown) => {
      const errorObj = err instanceof Error
        ? err
        : new Error(String((err as { message?: string })?.message || err || 'WebSocket error'))
      void closeImageBridge()
      rejectPendingRequests('Codex WebSocket 发生错误，取消等待中的 RPC 请求')
      queue.fail(errorObj)
    }

    ws.onclose = () => {
      if (partialPushTimer) clearTimeout(partialPushTimer)
      void closeImageBridge()
      rejectPendingRequests('Codex WebSocket 已关闭，取消等待中的 RPC 请求')
      queue.close()
    }

    try {
      // 1. 初始化握手
      await sendRequest('initialize', {
        clientInfo: { name: 'copis', version: '0.1.0' },
        capabilities: null,
      })

      // 1.1 注册 Copis 工作区 Skills 路径，确保专业模式加载工作区与内置技能
      const skillRoots = [...(options.additionalSkillPaths ?? [])]
      if (skillRoots.length === 0 && options.cwd) {
        const candidate1 = join(options.cwd, '.agents', 'skills')
        const candidate2 = join(options.cwd, '..', '.agents', 'skills')
        if (existsSync(candidate1)) skillRoots.push(candidate1)
        else if (existsSync(candidate2)) skillRoots.push(candidate2)
      }
      if (skillRoots.length > 0) {
        try {
          await sendRequest('skills/extraRoots/set', {
            extraRoots: skillRoots,
          })
        } catch (err) {
          console.warn('[Codex App Server] 注册工作区 Skills 路径失败 (skills/extraRoots/set):', err)
        }
      }

      // 2. 构造对齐 pi-runtime 与 edu-api 的 Responses 模型配置
      // 除非显式选择自定义模型，否则严格使用本地 Rust HTTP API 网关访问 edu-api，与 pi-runtime 一致
      const isWorkingGatewayUrl = (url?: string): boolean => {
        if (!url) return false
        try {
          const parsed = new URL(url)
          return (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
            && parsed.pathname.includes('/api/internal/working-model')
        } catch {
          return false
        }
      }

      const httpApiPort = resolveCopisHttpApiPort({
        configuredPort: process.env.COPIS_HTTP_API_PORT,
        isPackaged: process.env.COPIS_PACKAGED === '1',
      })
      const defaultWorkingBaseUrl = `http://127.0.0.1:${httpApiPort}/api/internal/working-model/v1`

      const modelProviderName = isCustomModel ? 'custom' : 'copis'
      const baseUrl = isCustomModel
        ? (options.baseUrl?.trim().replace(/\/+$/, '') ?? defaultWorkingBaseUrl)
        : (isWorkingGatewayUrl(options.baseUrl) ? options.baseUrl!.trim().replace(/\/+$/, '') : defaultWorkingBaseUrl)

      const threadConfig: Record<string, unknown> = {
        model: targetModel,
        model_provider: modelProviderName,
        model_providers: {
          [modelProviderName]: {
            name: modelProviderName,
            wire_api: 'responses',
            base_url: baseUrl,
            ...(options.apiKey ? { experimental_bearer_token: options.apiKey } : {}),
            ...(isCustomModel
              ? {}
              : {
                http_headers: {
                  'X-Working-Model-Source-Type': 'copis-agent-model',
                },
              }),
          },
        },
      }
      // thread/resume 可能沿用已经加载的 MCP 配置；已加载 Thread 会在下方 fork，
      // 未启用时也显式传禁用项，避免恢复路径意外继承生图能力。
      threadConfig.mcp_servers = {
        [CODEX_IMAGE_MCP_SERVER_NAME]: imageBridge?.config ?? {
          url: 'http://127.0.0.1:1/mcp',
          tool_timeout_sec: 360,
          enabled: false,
          required: false,
          default_tools_approval_mode: 'approve',
        },
      }

      // 权限模式与沙箱策略对齐：
      // 只有用户主会话已开启高级授权且不在计划模式时，才给予完整命令执行能力。
      // 关闭高级授权或进入计划模式时，Codex 不得继续沿用完全访问沙箱。
      const isBypass = options.permissionMode === 'bypassPermissions' && options.advancedAuthorization === true
      const approvalPolicy = isBypass ? 'never' : 'on-request'
      const sandbox = isBypass ? 'danger-full-access' : 'read-only'
      const sandboxPolicy = isBypass
        ? { type: 'dangerFullAccess' }
        : { type: 'readOnly', networkAccess: false }

      // 3. 启动或恢复 Thread
      let threadId: string | undefined
      if (options.resumeSessionId) {
        // 对已加载 Thread，App Server 实测不会用 thread/resume 的 config 覆盖现有 MCP 配置。
        // 当前运行时的兼容成本是 fork 完整历史并应用本轮配置；原 SDK Thread 保留用于回滚。
        // 未加载时 thread/resume 会应用本轮 config；loaded 查询失败必须失败关闭。
        let isThreadLoaded = false
        try {
          let cursor: string | undefined
          const seenCursors = new Set<string>()
          do {
            const loaded = await sendRequest('thread/loaded/list', {
              limit: 100,
              ...(cursor ? { cursor } : {}),
            })
            if (!Array.isArray(loaded.data) || loaded.data.some(id => typeof id !== 'string')) {
              throw new Error('Codex 返回了无效的 loaded thread 列表')
            }
            if (loaded.nextCursor != null && typeof loaded.nextCursor !== 'string') {
              throw new Error('Codex 返回了无效的 loaded thread 游标')
            }
            const loadedIds = loaded.data as string[]
            if (loadedIds.includes(options.resumeSessionId)) {
              isThreadLoaded = true
              break
            }
            cursor = typeof loaded.nextCursor === 'string' ? loaded.nextCursor : undefined
            if (cursor && seenCursors.has(cursor)) throw new Error('Codex loaded thread 分页游标重复')
            if (cursor) seenCursors.add(cursor)
          } while (cursor)
        } catch {
          throw new Error('无法确认 Codex 会话是否已加载，已停止以避免沿用过期图片工具权限')
        }

        if (isThreadLoaded) {
          try {
            const res = await sendRequest('thread/fork', {
              threadId: options.resumeSessionId,
              deferGoalContinuation: true,
              cwd: options.cwd,
              approvalPolicy,
              sandbox,
              model: targetModel,
              modelProvider: modelProviderName,
              config: threadConfig,
              ...(options.systemPrompt ? { developerInstructions: options.systemPrompt } : {}),
            })
            const thread = (res.thread as Record<string, unknown>) || {}
            threadId = typeof thread.id === 'string' ? thread.id : undefined
            if (!threadId) throw new Error('Codex fork 未返回 Thread ID')
          } catch {
            throw new Error('无法使用当前图片工具权限 fork Codex 会话，已停止以保留原会话历史')
          }
        } else {
          try {
            const res = await sendRequest('thread/resume', {
              threadId: options.resumeSessionId,
              cwd: options.cwd,
              approvalPolicy,
              sandbox,
              model: targetModel,
              modelProvider: modelProviderName,
              config: threadConfig,
              ...(options.systemPrompt ? { developerInstructions: options.systemPrompt } : {}),
            })
            if (res && !res.error) {
              threadId = options.resumeSessionId
            } else {
              const message = typeof res.error === 'string'
                ? res.error
                : res.error && typeof res.error === 'object'
                  ? extractCodexErrorMessage({ error: res.error })
                  : 'Codex 未能恢复原会话'
              throw new Error(message)
            }
          } catch (error) {
            if (!isCodexThreadNotFoundError(error)) {
              throw new Error('Codex 恢复会话失败，已保留原会话 ID 和历史记录')
            }
            // 仅在明确 rollout/thread 不存在时维持既有 thread/start 恢复行为。
          }
        }
      }

      if (!threadId) {
        const res = await sendRequest('thread/start', {
          cwd: options.cwd,
          approvalPolicy,
          sandbox,
          model: targetModel,
          modelProvider: modelProviderName,
          config: threadConfig,
          ...(options.systemPrompt ? { developerInstructions: options.systemPrompt } : {}),
        })
        const threadObj = (res.thread as Record<string, unknown>) || {}
        threadId = (threadObj.id as string) || (res.threadId as string) || (res.id as string)
      }

      if (!threadId) {
        throw new Error('Codex App Server 未返回有效 Thread ID')
      }

      sessionEntry.threadId = threadId
      options.onSessionId?.(threadId)

      if (sessionEntry.aborted) throw new Error('Codex 会话已取消，未启动新 Turn')

      // 4. 启动 Turn
      const turnParams: Record<string, unknown> = {
        threadId,
        cwd: options.cwd,
        approvalPolicy,
        sandboxPolicy,
        summary: 'auto',
        input: [
          {
            type: 'text',
            text: options.prompt,
            text_elements: [],
          },
        ],
        model: targetModel,
      }
      if (resolvedEffort) {
        turnParams.effort = resolvedEffort
      }

      const turnRes = await sendRequest('turn/start', turnParams)

      const turnObj = (turnRes.turn as Record<string, unknown>) || {}
      sessionEntry.turnId = (turnObj.id as string) || (turnRes.turnId as string) || (turnRes.id as string)

      // 4. 消费队列中的流式输出
      while (true) {
        const next = await queue.next()
        if (next.done) break
        yield next.value
      }
    } finally {
      if (partialPushTimer) clearTimeout(partialPushTimer)
      this.activeSessions.delete(options.sessionId)
      rejectPendingRequests('会话已结束，取消等待中的 RPC 请求')
      await closeImageBridge()
      try {
        if (ws.readyState === 1 || ws.readyState === 0) {
          ws.close()
        }
      } catch {
        // 忽略关闭异常
      }
    }
  }

  /**
   * 释放适配器资源，关闭所有活跃 WebSocket 连接
   */
  dispose(): void {
    for (const entry of this.activeSessions.values()) {
      entry.aborted = true
      void entry.closeImageBridge?.()
      try {
        if (entry.ws && (entry.ws.readyState === 1 || entry.ws.readyState === 0)) {
          entry.ws.close()
        }
      } catch {
        // 忽略关闭异常
      }
    }
    this.activeSessions.clear()
  }

  async setPermissionMode(_sessionId: string, _mode: string): Promise<void> {
    // Codex App Server 在 turn/start 阶段通过 approvalPolicy 设置权限，当前运行中无需操作
  }

  async sendQueuedMessage(_sessionId: string, _message: SDKUserMessageInput, _options?: SendQueuedMessageOptions): Promise<void> {
    throw new Error('Codex 专业模式暂不支持运行中追加排队消息')
  }

  async interruptQuery(sessionId: string): Promise<void> {
    this.abort(sessionId)
  }

  /**
   * 中断当前正在执行的会话
   */
  abort(sessionId: string): void {
    const entry = this.activeSessions.get(sessionId)
    if (!entry) return
    entry.aborted = true
    void entry.closeImageBridge?.()

    if (entry.ws?.readyState === 1 && entry.threadId) {
      try {
        entry.ws.send(JSON.stringify({
          method: 'turn/interrupt',
          id: 999999,
          params: {
            threadId: entry.threadId,
            ...(entry.turnId ? { turnId: entry.turnId } : {}),
          },
        }))
      } catch (err) {
        console.warn('[Codex App Server Adapter] 发送 turn/interrupt 失败:', err)
      }
    } else if (entry.ws && (entry.ws.readyState === 1 || entry.ws.readyState === 0)) {
      try { entry.ws.close() } catch { /* 忽略关闭异常 */ }
    }
  }

  private async connectWebSocket(url: string): Promise<CodexWebSocketClient> {
    const startTime = Date.now()
    const WebSocketCtor = typeof globalThis.WebSocket !== 'undefined'
      ? (globalThis.WebSocket as unknown as { new(url: string): CodexWebSocketClient })
      : (WebSocket as unknown as { new(url: string): CodexWebSocketClient })

    let lastError: Error | null = null

    while (Date.now() - startTime < WS_CONNECT_TIMEOUT_MS) {
      try {
        const client = await new Promise<CodexWebSocketClient>((resolve, reject) => {
          let resolved = false
          const ws = new WebSocketCtor(url)

          const timer = setTimeout(() => {
            if (!resolved) {
              resolved = true
              try {
                if (typeof ws.terminate === 'function') {
                  ws.terminate()
                } else {
                  ws.close()
                }
              } catch { /* ignore */ }
              reject(new Error(`连接 Codex App Server 超时`))
            }
          }, Math.min(2000, Math.max(200, WS_CONNECT_TIMEOUT_MS - (Date.now() - startTime))))

          ws.onopen = () => {
            if (!resolved) {
              resolved = true
              clearTimeout(timer)
              resolve(ws)
            }
          }

          ws.onerror = (err: unknown) => {
            if (!resolved) {
              resolved = true
              clearTimeout(timer)
              const errorObj = err instanceof Error
                ? err
                : new Error(String((err as { message?: string })?.message || (err as { error?: { message?: string } })?.error?.message || err || 'WebSocket connection failed'))
              reject(errorObj)
            }
          }
        })
        return client
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        await new Promise((r) => setTimeout(r, 100))
      }
    }

    throw lastError ?? new Error(`连接 Codex App Server 失败 (${url})`)
  }
}
