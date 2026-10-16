import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Value } from 'typebox/value'
import {
  CancelledNotificationSchema,
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  createImageGenerationToolDefinitions,
  type PiImageGenerationToolOptions,
} from './pi-image-generation-tool'

export const CODEX_IMAGE_MCP_SERVER_NAME = 'copis_image'

export interface CodexImageToolCall {
  callId: string
  name: string
  arguments: Record<string, unknown>
}

export interface CodexImageToolResult extends CodexImageToolCall {
  content: unknown[]
  details?: unknown
  isError: boolean
}

export interface CodexImageToolsMcpOptions extends PiImageGenerationToolOptions {
  onToolStart?: (call: CodexImageToolCall) => void
  onToolResult?: (result: CodexImageToolResult) => void
}

const MCP_PATH = '/mcp'
const MAX_REQUEST_BODY_BYTES = 1024 * 1024
const TOOL_TIMEOUT_SECONDS = 360

interface CachedToolCall {
  fingerprint: string
  result: Promise<CodexImageToolResult>
}

class HttpRequestError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message)
  }
}

function jsonResponse(response: ServerResponse, statusCode: number, body: unknown): void {
  if (response.headersSent || response.destroyed) return
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const contentLength = request.headers['content-length']
    if (typeof contentLength === 'string') {
      const parsedLength = Number(contentLength)
      if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
        reject(new HttpRequestError(400, 'Content-Length 无效'))
        return
      }
      if (parsedLength > MAX_REQUEST_BODY_BYTES) {
        request.resume()
        reject(new HttpRequestError(413, '请求正文过大'))
        return
      }
    }

    const chunks: Buffer[] = []
    let totalBytes = 0
    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalBytes += buffer.byteLength
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        chunks.length = 0
        request.resume()
        reject(new HttpRequestError(413, '请求正文过大'))
        return
      }
      chunks.push(buffer)
    })
    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        if (!text) throw new HttpRequestError(400, '请求正文不能为空')
        resolve(JSON.parse(text) as unknown)
      } catch (error) {
        reject(error instanceof HttpRequestError ? error : new HttpRequestError(400, '请求正文必须是有效 JSON'))
      }
    })
    request.on('error', error => reject(error))
    request.on('aborted', () => reject(new HttpRequestError(400, '请求已取消')))
  })
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function requestKey(value: string | number): string {
  return `${typeof value}:${String(value)}`
}

function hasObjectDetails(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function copyToolResultForCallback(result: CodexImageToolResult): CodexImageToolResult {
  const details = result.details === undefined ? undefined : JSON.parse(JSON.stringify(result.details)) as unknown
  return {
    ...result,
    arguments: { ...result.arguments },
    content: result.content.map(item => hasObjectDetails(item) ? { ...item } : item),
    ...(details === undefined ? {} : { details }),
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function validateArguments(name: string, parameters: object, value: unknown): Record<string, unknown> {
  if (!hasObjectDetails(value)) {
    throw new McpError(ErrorCode.InvalidParams, `${name} 参数必须是对象`)
  }
  const properties = (parameters as { properties?: unknown }).properties
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    const allowedKeys = new Set(Object.keys(properties))
    const unknownKeys = Object.keys(value).filter(key => !allowedKeys.has(key))
    if (unknownKeys.length > 0) {
      throw new McpError(ErrorCode.InvalidParams, `${name} 包含未知参数：${unknownKeys.slice(0, 4).join(', ')}`)
    }
  }
  if (!Value.Check(parameters as never, value)) {
    const detail = [...Value.Errors(parameters as never, value)]
      .slice(0, 4)
      .map(error => `${error.instancePath || '/'} ${error.message}`)
      .join('; ')
    throw new McpError(ErrorCode.InvalidParams, `${name} 参数无效${detail ? `：${detail}` : ''}`)
  }
  return value
}

function isAllowedOrigin(originHeader: string | undefined, expectedOrigin: string): boolean {
  if (!originHeader) return true
  return originHeader === expectedOrigin
}

export async function startCodexImageToolsMcp(options: CodexImageToolsMcpOptions): Promise<{
  config: Record<string, unknown>
  close: () => Promise<void>
}> {
  const token = randomBytes(32).toString('base64url')
  const runNonce = randomBytes(12).toString('hex')
  const toolDefinitions = createImageGenerationToolDefinitions(options)
  const toolsByName = new Map(toolDefinitions.map(definition => [definition.name, definition]))
  const listTools: ListToolsResult['tools'] = toolDefinitions.map(definition => ({
    name: definition.name,
    description: definition.description,
    inputSchema: JSON.parse(JSON.stringify(definition.parameters)) as ListToolsResult['tools'][number]['inputSchema'],
  }))

  const cachedCalls = new Map<string, CachedToolCall>()
  const activeMcpServers = new Set<Server>()
  const requestCleanups = new Set<(abort: boolean) => Promise<void>>()
  const sockets = new Set<Socket>()
  const requestIdControllers = new Map<string, Set<AbortController>>()
  const runController = new AbortController()
  let executionQueue: Promise<void> = Promise.resolve()
  let closing = false
  let closePromise: Promise<void> | undefined
  let httpServer: ReturnType<typeof createServer>
  let expectedOrigin = ''
  let expectedHost = ''

  const dispatchTool = (
    name: string,
    rawArguments: unknown,
    rpcRequestId: string | number,
    peerSignal: AbortSignal,
    requestControllers: Set<AbortController>,
  ): Promise<CodexImageToolResult> => {
    if (closing) throw new McpError(ErrorCode.ConnectionClosed, '图片工具服务正在关闭')
    const definition = toolsByName.get(name)
    if (!definition) throw new McpError(ErrorCode.InvalidParams, `未知图片工具：${name}`)
    const args = validateArguments(name, definition.parameters, rawArguments)
    const cacheKey = requestKey(rpcRequestId)
    const fingerprint = canonicalJson({ name, arguments: args })
    const cached = cachedCalls.get(cacheKey)
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        throw new McpError(ErrorCode.InvalidRequest, 'JSON-RPC request ID 已用于不同的图片工具调用')
      }
      return cached.result
    }

    const call: CodexImageToolCall = {
      callId: `codex_${runNonce}_${cacheKey}`,
      name,
      arguments: JSON.parse(JSON.stringify(args)) as Record<string, unknown>,
    }
    const controller = new AbortController()
    requestControllers.add(controller)
    const perRequestControllers = requestIdControllers.get(cacheKey) ?? new Set<AbortController>()
    perRequestControllers.add(controller)
    requestIdControllers.set(cacheKey, perRequestControllers)

    const execute = async (): Promise<CodexImageToolResult> => {
      try {
        try { options.onToolStart?.({ ...call, arguments: { ...call.arguments } }) } catch { /* UI 回调失败不应影响工具执行 */ }

        if (closing) controller.abort(new DOMException('图片工具服务正在关闭', 'AbortError'))
        const signal = AbortSignal.any([peerSignal, controller.signal, runController.signal])
        signal.throwIfAborted()
        const result = await definition.execute(
          call.callId,
          call.arguments as never,
          signal,
          undefined,
          undefined as never,
        )
        const toolResult: CodexImageToolResult = {
          ...call,
          content: Array.isArray(result.content) ? result.content : [],
          ...(result.details === undefined ? {} : { details: result.details }),
          isError: false,
        }
        try { options.onToolResult?.(copyToolResultForCallback(toolResult)) } catch { /* UI 回调失败不应改变工具结果 */ }
        return toolResult
      } catch (error) {
        const taskId = error && typeof error === 'object' && 'taskId' in error
          ? (error as { taskId?: unknown }).taskId
          : undefined
        const details = typeof taskId === 'string' && taskId ? { task_id: taskId } : undefined
        const toolResult: CodexImageToolResult = {
          ...call,
          content: [{ type: 'text', text: errorText(error) }],
          ...(details ? { details } : {}),
          isError: true,
        }
        try { options.onToolResult?.(copyToolResultForCallback(toolResult)) } catch { /* UI 回调失败不应改变工具结果 */ }
        return toolResult
      } finally {
        requestControllers.delete(controller)
        const remaining = requestIdControllers.get(cacheKey)
        remaining?.delete(controller)
        if (remaining?.size === 0) requestIdControllers.delete(cacheKey)
      }
    }

    const execution = executionQueue.then(execute, execute)
    executionQueue = execution.then(() => undefined, () => undefined)
    cachedCalls.set(cacheKey, { fingerprint, result: execution })
    return execution
  }

  const sendHttpError = (response: ServerResponse, statusCode: number, message: string): void => {
    jsonResponse(response, statusCode, { error: message })
  }

  const handleHttpRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestControllers = new Set<AbortController>()
    let mcpServer: Server | undefined
    let cleanupPromise: Promise<void> | undefined
    const cleanup = (abort: boolean): Promise<void> => {
      if (cleanupPromise) return cleanupPromise
      cleanupPromise = (async () => {
        if (abort) {
          for (const controller of requestControllers) {
            controller.abort(new DOMException('MCP HTTP 请求已关闭', 'AbortError'))
          }
        }
        if (mcpServer) {
          activeMcpServers.delete(mcpServer)
          await mcpServer.close().catch(() => undefined)
        }
        requestCleanups.delete(cleanup)
      })()
      return cleanupPromise
    }
    requestCleanups.add(cleanup)
    response.once('finish', () => { void cleanup(false) })
    response.once('close', () => { void cleanup(!response.writableEnded) })

    try {
      const requestUrl = new URL(request.url ?? '/', expectedOrigin)
      if (requestUrl.pathname !== MCP_PATH || requestUrl.search) {
        request.resume()
        sendHttpError(response, 404, '路径不存在')
        return
      }
      if (request.method !== 'POST') {
        request.resume()
        response.setHeader('Allow', 'POST')
        sendHttpError(response, 405, '请求方法不受支持')
        return
      }

      const authorization = request.headers.authorization ?? ''
      const expectedAuthorization = `Bearer ${token}`
      const authorizationBuffer = Buffer.from(authorization)
      const expectedAuthorizationBuffer = Buffer.from(expectedAuthorization)
      if (authorizationBuffer.byteLength !== expectedAuthorizationBuffer.byteLength
        || !timingSafeEqual(authorizationBuffer, expectedAuthorizationBuffer)) {
        request.resume()
        sendHttpError(response, 401, '未授权')
        return
      }
      if (!isAllowedOrigin(request.headers.origin, expectedOrigin)) {
        request.resume()
        sendHttpError(response, 403, 'Origin 来源不受支持')
        return
      }
      const contentType = request.headers['content-type']
      if (contentType && !contentType.toLowerCase().includes('application/json')) {
        request.resume()
        sendHttpError(response, 415, 'Content-Type 必须是 application/json')
        return
      }

      const body = await readJsonBody(request)
      if (closing) {
        sendHttpError(response, 503, '图片工具服务正在关闭')
        return
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        allowedHosts: [expectedHost],
        allowedOrigins: [expectedOrigin],
      })
      mcpServer = new Server(
        { name: CODEX_IMAGE_MCP_SERVER_NAME, version: '1.0.0' },
        { capabilities: { tools: { listChanged: false } } },
      )
      mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools }))
      mcpServer.setRequestHandler(CallToolRequestSchema, async (rpcRequest, extra) => {
        const result = await dispatchTool(
          rpcRequest.params.name,
          rpcRequest.params.arguments ?? {},
          extra.requestId,
          extra.signal,
          requestControllers,
        )
        const mcpResult: CallToolResult = {
          content: result.content as CallToolResult['content'],
          isError: result.isError,
        }
        if (hasObjectDetails(result.details)) mcpResult.structuredContent = result.details
        else if (result.details !== undefined) mcpResult._meta = { 'copis/details': result.details }
        return mcpResult
      })
      mcpServer.setNotificationHandler(CancelledNotificationSchema, notification => {
        const cancelledRequestId = notification.params.requestId
        if (cancelledRequestId === undefined) return
        for (const controller of requestIdControllers.get(requestKey(cancelledRequestId)) ?? []) {
          controller.abort(new DOMException('MCP 客户端已取消图片工具调用', 'AbortError'))
        }
      })
      activeMcpServers.add(mcpServer)
      await mcpServer.connect(transport)
      await transport.handleRequest(request, response, body)
    } catch (error) {
      if (error instanceof HttpRequestError) {
        sendHttpError(response, error.statusCode, error.message)
      } else if (!response.headersSent && !response.destroyed) {
        sendHttpError(response, 500, '图片工具服务内部错误')
      }
    }
  }

  httpServer = createServer({
    maxHeaderSize: 8 * 1024,
    headersTimeout: 10_000,
    requestTimeout: 30_000,
    keepAliveTimeout: 1_000,
  }, (request, response) => {
    const operation = handleHttpRequest(request, response)
    void operation.catch(() => undefined)
  })
  httpServer.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        httpServer.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        httpServer.off('error', onError)
        resolve()
      }
      httpServer.once('error', onError)
      httpServer.once('listening', onListening)
      httpServer.listen(0, '127.0.0.1')
    })
  } catch (error) {
    await new Promise<void>(resolve => httpServer.close(() => resolve()))
    throw error
  }

  const address = httpServer.address()
  if (!address || typeof address === 'string') {
    await new Promise<void>(resolve => httpServer.close(() => resolve()))
    throw new Error('无法确定图片 MCP 服务端口')
  }
  const port = address.port
  expectedHost = `127.0.0.1:${port}`
  expectedOrigin = `http://${expectedHost}`

  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    closing = true
    closePromise = (async () => {
      runController.abort(new DOMException('图片工具服务已关闭', 'AbortError'))
      for (const controllers of requestIdControllers.values()) {
        for (const controller of controllers) controller.abort(new DOMException('图片工具服务已关闭', 'AbortError'))
      }

      const httpClosed = new Promise<void>(resolve => httpServer.close(() => resolve()))
      httpServer.closeAllConnections()
      for (const socket of sockets) socket.destroy()
      await Promise.allSettled([...requestCleanups].map(cleanup => cleanup(true)))
      await executionQueue
      await httpClosed
      cachedCalls.clear()
      activeMcpServers.clear()
      requestIdControllers.clear()
      sockets.clear()
    })()
    return closePromise
  }

  return {
    config: {
      url: `${expectedOrigin}${MCP_PATH}`,
      http_headers: { Authorization: `Bearer ${token}` },
      required: true,
      tool_timeout_sec: TOOL_TIMEOUT_SECONDS,
      enabled: true,
      default_tools_approval_mode: 'approve',
    },
    close,
  }
}
