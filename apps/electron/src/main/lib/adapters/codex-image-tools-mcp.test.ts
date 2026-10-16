import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startCodexImageToolsMcp } from './codex-image-tools-mcp'

const testConfigDir = mkdtempSync(join(tmpdir(), 'copis-codex-image-mcp-'))
const configPaths = await import('../config-paths')
mock.module('../config-paths', () => ({ ...configPaths, getConfigDir: () => testConfigDir }))
mock.module('../attachment-storage', () => ({
  saveAttachment: ({ conversationId, filename, mediaType }: { conversationId: string; filename: string; mediaType: string }) => ({
    attachment: {
      id: 'mock-image-attachment',
      filename,
      mediaType,
      localPath: `${conversationId}/${filename}`,
      size: 16,
    },
  }),
}))

afterAll(() => rmSync(testConfigDir, { recursive: true, force: true }))

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function imageBackend(options: { failGeneration?: boolean } = {}) {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown>; signal?: AbortSignal }> = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    calls.push({ url, method, body, signal: init?.signal ?? undefined })

    if (method === 'POST' && url.endsWith('/api/working/image/tasks')) {
      return options.failGeneration
        ? jsonResponse({ data: { task_id: 'failed-task-123', status: 'failed', error: 'mock generation failure' } }, 202)
        : jsonResponse({ data: { task_id: 'created-task-123', status: 'queued' } }, 202)
    }
    if (url.endsWith('/api/working/image/tasks') || url.includes('/api/working/image/tasks?session_id=')) {
      return jsonResponse({ data: [{ task_id: 'listed-task-123', status: 'running' }] })
    }
    if (url.endsWith('/saved-task-123')) {
      return jsonResponse({ data: { task_id: 'saved-task-123', status: 'completed', data_url: 'data:image/png;base64,iVBORw0KGgo=' } })
    }
    if (url.endsWith('/created-task-123')) {
      return jsonResponse(options.failGeneration
        ? { data: { task_id: 'created-task-123', status: 'failed', error: 'mock generation failure' } }
        : { data: { task_id: 'created-task-123', status: 'completed', data_url: 'data:image/png;base64,iVBORw0KGgo=' } })
    }
    throw new Error(`Unexpected image backend request: ${method} ${url}`)
  }
  return { calls, fetchImpl }
}

function getConfig(config: Record<string, unknown>) {
  return {
    url: String(config.url),
    headers: config.http_headers as Record<string, string>,
  }
}

function contentOf(result: unknown): Array<{ type: string; text?: string }> {
  if (!result || typeof result !== 'object') return []
  const content = (result as { content?: unknown }).content
  return Array.isArray(content) ? content as Array<{ type: string; text?: string }> : []
}

async function connectClient(config: Record<string, unknown>) {
  const { url, headers } = getConfig(config)
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } })
  const client = new Client({ name: 'copis-image-test', version: '1.0.0' })
  await client.connect(transport)
  return { client, transport }
}

async function postMcp(config: Record<string, unknown>, body: unknown, headers = getConfig(config).headers) {
  const { url } = getConfig(config)
  const response = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json, text/event-stream', ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { response, body: text ? JSON.parse(text) as Record<string, unknown> : undefined }
}

describe('Codex 图片工具 Streamable HTTP MCP bridge', () => {
  test('Given 本地 Codex MCP 客户端 When 列表和调用工具 Then 转发三项 Pi 图片能力并保留图片附件结果', async () => {
    const backend = imageBackend()
    const service = await startCodexImageToolsMcp({
      sessionId: 'mcp-session-tools',
      fetchImpl: backend.fetchImpl,
      pollIntervalMs: 0,
    })
    const { client, transport } = await connectClient(service.config)
    try {
      const listed = await client.listTools()
      expect(listed.tools.map(tool => tool.name)).toEqual(['generate_image', 'get_image_task', 'list_image_tasks'])
      expect(listed.tools[0]?.description).toContain('生成图片')
      expect(listed.tools[0]?.inputSchema.required).toEqual(['prompt'])

      const generated = await client.callTool({ name: 'generate_image', arguments: { prompt: 'small watercolor house' } })
      expect(generated.isError).not.toBe(true)
      expect(contentOf(generated).some(item => item.type === 'image')).toBe(true)
      expect(contentOf(generated).some(item => item.type === 'text' && item.text?.includes('<generated_images>'))).toBe(true)
      expect(generated.structuredContent).toMatchObject({ generatedAttachments: [{ filename: expect.stringMatching(/^copis-image-/) }] })

      const recovered = await client.callTool({ name: 'get_image_task', arguments: { task_id: 'saved-task-123' } })
      expect(contentOf(recovered).some(item => item.type === 'image')).toBe(true)
      const tasks = await client.callTool({ name: 'list_image_tasks', arguments: { session_id: 'mcp-session-tools' } })
      expect(contentOf(tasks)[0]?.text).toContain('listed-task-123')
      expect(backend.calls.filter(call => call.method === 'POST')).toHaveLength(1)

      expect(service.config).toMatchObject({ required: true, tool_timeout_sec: 360, enabled: true, default_tools_approval_mode: 'approve' })
      expect(String(service.config.url)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    } finally {
      await client.close()
      await transport.close()
      await service.close()
    }
  })

  test('拒绝缺少 Bearer token、错误 Origin、未知工具和非法参数', async () => {
    const backend = imageBackend()
    const service = await startCodexImageToolsMcp({ sessionId: 'mcp-session-guards', fetchImpl: backend.fetchImpl })
    try {
      const invalidCall = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'generate_image', arguments: { prompt: 42 } } }
      const noAuth = await postMcp(service.config, invalidCall, {})
      expect(noAuth.response.status).toBe(401)

      const wrongOrigin = await postMcp(service.config, invalidCall, {
        ...getConfig(service.config).headers,
        Origin: 'https://attacker.example',
      })
      expect(wrongOrigin.response.status).toBe(403)

      const { client, transport } = await connectClient(service.config)
      try {
        await expect(client.callTool({ name: 'not_an_image_tool', arguments: {} })).rejects.toThrow()
        await expect(client.callTool({ name: 'generate_image', arguments: { prompt: 42 } })).rejects.toThrow()
        await expect(client.callTool({ name: 'generate_image', arguments: { prompt: 'valid prompt', shell_command: 'unsafe' } })).rejects.toThrow()
      } finally {
        await client.close()
        await transport.close()
      }
      expect(backend.calls).toHaveLength(0)
    } finally {
      await service.close()
    }
  })

  test('重复相同 JSON-RPC requestId 复用结果且不重复提交或重复发出回调', async () => {
    const backend = imageBackend()
    const starts: unknown[] = []
    const results: unknown[] = []
    const service = await startCodexImageToolsMcp({
      sessionId: 'mcp-session-idempotency',
      fetchImpl: backend.fetchImpl,
      pollIntervalMs: 0,
      onToolStart: call => starts.push(call),
      onToolResult: result => results.push(result),
    })
    try {
      const init = await postMcp(service.config, {
        jsonrpc: '2.0', id: 'init', method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp-test', version: '1.0.0' } },
      })
      expect(init.response.status).toBe(200)
      await postMcp(service.config, { jsonrpc: '2.0', method: 'notifications/initialized' })

      const call = {
        jsonrpc: '2.0', id: 42, method: 'tools/call',
        params: { name: 'generate_image', arguments: { prompt: 'stable prompt' } },
      }
      const first = await postMcp(service.config, call)
      const second = await postMcp(service.config, call)
      expect(first.response.status).toBe(200)
      expect(second.response.status).toBe(200)
      expect(second.body?.result).toEqual(first.body?.result)
      expect(backend.calls.filter(item => item.method === 'POST')).toHaveLength(1)
      expect(starts).toHaveLength(1)
      expect(results).toHaveLength(1)
    } finally {
      await service.close()
    }
  })

  test('后端失败时返回 isError 并在 MCP 结构化结果保留 task_id', async () => {
    const backend = imageBackend({ failGeneration: true })
    const service = await startCodexImageToolsMcp({ sessionId: 'mcp-session-task-error', fetchImpl: backend.fetchImpl })
    const { client, transport } = await connectClient(service.config)
    try {
      const result = await client.callTool({ name: 'generate_image', arguments: { prompt: 'fail safely' } })
      expect(result.isError).toBe(true)
      expect(contentOf(result)[0]?.text).toContain('task_id=failed-task-123')
      expect(result.structuredContent).toEqual({ task_id: 'failed-task-123' })
      expect(backend.calls.filter(call => call.method === 'POST')).toHaveLength(1)
    } finally {
      await client.close()
      await transport.close()
      await service.close()
    }
  })

  test('notifications/cancelled 会中止对应的图片后端请求', async () => {
    let enteredPoll = false
    let observedSignal: AbortSignal | undefined
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'POST') return jsonResponse({ data: { task_id: 'rpc-cancel-task', status: 'queued' } }, 202)
      enteredPoll = true
      observedSignal = init?.signal ?? undefined
      return new Promise((_resolve, reject) => {
        const signal = init?.signal
        if (signal?.aborted) reject(new DOMException('aborted', 'AbortError'))
        else signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    }
    const service = await startCodexImageToolsMcp({ sessionId: 'mcp-session-cancel-notification', fetchImpl, pollIntervalMs: 0 })
    try {
      await postMcp(service.config, {
        jsonrpc: '2.0', id: 'init', method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp-test', version: '1.0.0' } },
      })
      await postMcp(service.config, { jsonrpc: '2.0', method: 'notifications/initialized' })

      const call = postMcp(service.config, {
        jsonrpc: '2.0', id: 'call-to-cancel', method: 'tools/call',
        params: { name: 'generate_image', arguments: { prompt: 'cancel by MCP notification' } },
      })
      for (let attempt = 0; attempt < 100 && !enteredPoll; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 2))
      }
      expect(enteredPoll).toBe(true)
      await postMcp(service.config, {
        jsonrpc: '2.0', method: 'notifications/cancelled',
        params: { requestId: 'call-to-cancel', reason: 'test cancellation' },
      })
      const cancelled = await call
      expect(observedSignal?.aborted).toBe(true)
      expect((cancelled.body?.result as { isError?: boolean } | undefined)?.isError).toBe(true)
    } finally {
      await service.close()
    }
  })

  test('不同 Codex run 的相同数字 requestId 不会重用之前的图片请求 ID', async () => {
    const backend = imageBackend()
    const invokeSameNumericId = async () => {
      const service = await startCodexImageToolsMcp({
        sessionId: 'mcp-session-run-nonce',
        fetchImpl: backend.fetchImpl,
        pollIntervalMs: 0,
      })
      try {
        await postMcp(service.config, {
          jsonrpc: '2.0', id: 'init', method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp-test', version: '1.0.0' } },
        })
        const response = await postMcp(service.config, {
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'generate_image', arguments: { prompt: 'same prompt across runs' } },
        })
        expect((response.body?.result as { isError?: boolean } | undefined)?.isError).not.toBe(true)
      } finally {
        await service.close()
      }
    }

    await invokeSameNumericId()
    await invokeSameNumericId()
    const requestIds = backend.calls
      .filter(call => call.method === 'POST')
      .map(call => call.body?.request_id)
    expect(requestIds).toHaveLength(2)
    expect(requestIds[0]).toBeString()
    expect(requestIds[1]).toBeString()
    expect(requestIds[0]).not.toBe(requestIds[1])
  })

  test('关闭 bridge 会取消正在轮询的图片执行并允许重复 close', async () => {
    let observedSignal: AbortSignal | undefined
    let enteredPoll = false
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'POST') return jsonResponse({ data: { task_id: 'cancelled-task-1', status: 'queued' } }, 202)
      if (!enteredPoll) {
        enteredPoll = true
        observedSignal = init?.signal ?? undefined
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
        })
      }
      return jsonResponse({ data: { task_id: 'cancelled-task-1', status: 'queued' } })
    }
    const service = await startCodexImageToolsMcp({ sessionId: 'mcp-session-close', fetchImpl, pollIntervalMs: 0 })
    const { client, transport } = await connectClient(service.config)
    const call = client.callTool({ name: 'generate_image', arguments: { prompt: 'cancel this' } })
    try {
      for (let attempt = 0; attempt < 100 && !enteredPoll; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 2))
      }
      expect(enteredPoll).toBe(true)
      await Promise.all([service.close(), service.close()])
      expect(observedSignal?.aborted).toBe(true)
      await expect(call).rejects.toThrow()
    } finally {
      await transport.close().catch(() => undefined)
      await service.close()
    }
  })
})
