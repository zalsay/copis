import { afterAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PiImageGenerationToolClient,
  PiImageGenerationToolError,
  base64FromDataUrl,
  detectBase64ImageType,
  extensionForMediaType,
  buildPiImageGenerationTools,
} from './pi-image-generation-tool'

const testConfigDir = mkdtempSync(join(tmpdir(), 'copis-image-tests-'))
const configPaths = await import('../config-paths')
mock.module('../config-paths', () => ({ ...configPaths, getConfigDir: () => testConfigDir }))
afterAll(() => rmSync(testConfigDir, { recursive: true, force: true }))

// Mock attachment-storage 以避免真实的磁盘写入
mock.module('../attachment-storage', () => ({
  saveAttachment: ({ conversationId, filename, mediaType }: { conversationId: string; filename: string; mediaType: string }) => ({
    attachment: {
      id: 'mock-att-1',
      filename,
      mediaType,
      localPath: `${conversationId}/${filename}`,
      size: 1024,
    },
  }),
}))

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('Pi Copis 图片生成工具适配器', () => {
  test('图片 URL 返回 403 时刷新原任务 URL，仍不提交生成', async () => {
    const urls: string[] = []
    const client = new PiImageGenerationToolClient({ sessionId: 'url-refresh', fetchImpl: async (url, init) => {
      expect(init?.method ?? 'GET').toBe('GET')
      const path = String(url); urls.push(path)
      if (path.endsWith('/task?refresh=1')) return jsonResponse({ data: { task_id: 'task', status: 'completed', image_url: 'https://images.example/new' } })
      if (path.endsWith('/task')) return jsonResponse({ data: { task_id: 'task', status: 'completed', image_url: 'https://images.example/old' } })
      if (path.endsWith('/old')) return new Response('', { status: 403 })
      return new Response('png', { headers: { 'Content-Type': 'image/png' } })
    } })
    expect((await client.getTask('task')).base64).toBeTruthy()
    expect(urls).toHaveLength(4)
  })
  test('按 Task ID 获取已完成图片只查询和下载，不提交生成', async () => {
    const methods: string[] = []
    const client = new PiImageGenerationToolClient({ sessionId: 'recover-session', fetchImpl: async (url, init) => {
      methods.push(init?.method ?? 'GET')
      if (String(url).endsWith('/saved-task')) return jsonResponse({ data: { task_id: 'saved-task', status: 'completed', image_url: 'https://images.example/result.png' } })
      return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } })
    } })
    const result = await client.getTask('saved-task')
    expect(result.text).toContain('generated_images')
    expect(methods).toEqual(['GET', 'GET'])
  })
  test('按 Task ID 查询运行中任务立即返回状态而不等待五分钟', async () => {
    const client = new PiImageGenerationToolClient({ sessionId: 'recover-session', fetchImpl: async () => jsonResponse({ data: { task_id: 'pending-task', status: 'running' } }) })
    expect((await client.getTask('pending-task')).text).toContain('running')
    await expect(client.getTask('../escape')).rejects.toThrow('task_id')
  })
	 test('Given 已提交任务的客户端重建 When 重试同一工具调用 Then 只查询原任务且拒绝参数冲突', async () => {
		let posts = 0
		const options = {
			sessionId: 'restart-session', pollIntervalMs: 0,
			fetchImpl: async (url: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === 'POST') { posts++; return jsonResponse({ data: { task_id: 'restart-task', status: 'queued' } }, 202) }
				if (String(url).endsWith('/restart-task')) return jsonResponse({ data: { task_id: 'restart-task', status: 'failed', error: '模拟失败' } })
				throw new Error('unexpected URL')
			},
		}
		await expect(new PiImageGenerationToolClient(options).execute({ prompt: 'cup' }, undefined, 'restart-call')).rejects.toMatchObject({ taskId: 'restart-task' })
		await expect(new PiImageGenerationToolClient(options).execute({ prompt: 'cup' }, undefined, 'restart-call')).rejects.toMatchObject({ taskId: 'restart-task' })
		await expect(new PiImageGenerationToolClient(options).execute({ prompt: 'other' }, undefined, 'restart-call')).rejects.toThrow('提示词或尺寸已变化')
		expect(posts).toBe(1)
	 })
  test('Given 工具辅助函数 When 处理 dataUrl、MIME 类型和扩展名 Then 结果正确', () => {
    expect(base64FromDataUrl('data:image/png;base64,iVBORw0KGgo=')).toBe('iVBORw0KGgo=')
    expect(base64FromDataUrl('invalid-data-url')).toBeNull()

    expect(detectBase64ImageType('/9j/4AAQSkZJRg==')).toBe('image/jpeg')
    expect(detectBase64ImageType('iVBORw0KGgoAAAAN==')).toBe('image/png')
    expect(detectBase64ImageType('UklGRgAAAABXRUJQ')).toBe('image/webp')
    expect(detectBase64ImageType('R0lGODlhAQABAIA==')).toBe('image/gif')

    expect(extensionForMediaType('image/jpeg')).toBe('.jpg')
    expect(extensionForMediaType('image/webp')).toBe('.webp')
    expect(extensionForMediaType('image/png')).toBe('.png')
  })

  test('Given prompt 为空 When 执行生图 Then 抛出参数缺失错误', async () => {
    const client = new PiImageGenerationToolClient({
      sessionId: 'test-session',
      baseUrl: 'http://127.0.0.1:51730',
      fetchImpl: async () => jsonResponse({}),
    })

    await expect(client.execute({ prompt: '' })).rejects.toThrow(PiImageGenerationToolError)
    await expect(client.execute({ prompt: '   ' })).rejects.toThrow('prompt 参数缺失')
  })

  test('Given 正常请求与登录态 When 调用生图 Then 发送请求至 Rust API 并返回带有 <generated_images> 的文本', async () => {
    const calls: Array<{ url: string; body?: unknown }> = []
    const client = new PiImageGenerationToolClient({
      sessionId: 'session-123',
      baseUrl: 'http://127.0.0.1:51740',
      pollIntervalMs: 0,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
        if (String(url).endsWith('/api/working/image/tasks')) {
          return jsonResponse({ data: { task_id: 'task-123', status: 'queued' } }, 202)
        }
        if (String(url).endsWith('/api/working/image/tasks/task-123')) {
          return jsonResponse({ data: {
            task_id: 'task-123',
            status: 'completed',
            image_url: 'https://images.example.test/task-123.png',
          } })
        }
        return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } })
      },
    })

    const result = await client.execute({ prompt: '一只可爱的小猫', size: '1024x1024' })

    expect(calls).toHaveLength(3)
    expect(calls[0]?.url).toBe('http://127.0.0.1:51740/api/working/image/tasks')
    expect(calls[0]?.body).toEqual({
      prompt: '一只可爱的小猫',
      size: '1024x1024',
      sessionId: 'session-123',
      request_id: expect.any(String),
    })

    expect(result.text).toContain('图片已成功生成（1 张）')
    expect(result.text).toContain('<generated_images>')
    expect(result.text).toContain('session-123/copis-image-')
    expect(result.mediaType).toBe('image/png')
    expect(result.meta).toHaveLength(1)
    expect(result.meta[0]?.mediaType).toBe('image/png')
  })

  test('Given 提供了工作区 cwd When 生图成功 Then 图片文件同步写入 cwd 目录', async () => {
    const testCwd = mkdtempSync(join(tmpdir(), 'copis-workspace-test-'))
    try {
      const client = new PiImageGenerationToolClient({
        sessionId: 'session-cwd-test',
        baseUrl: 'http://127.0.0.1:51740',
        pollIntervalMs: 0,
        cwd: testCwd,
        fetchImpl: async (url) => {
          if (String(url).endsWith('/api/working/image/tasks')) {
            return jsonResponse({ data: { task_id: 'task-cwd-1', status: 'queued' } }, 202)
          }
          if (String(url).endsWith('/api/working/image/tasks/task-cwd-1')) {
            return jsonResponse({ data: {
              task_id: 'task-cwd-1',
              status: 'completed',
              image_url: 'https://images.example.test/task-cwd-1.png',
            } })
          }
          return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } })
        },
      })

      const result = await client.execute({ prompt: '一张海报' })
      expect(result.text).toContain('图片已成功生成（1 张）')
      expect(result.meta).toHaveLength(1)
      const filename = result.meta[0]!.filename
      const targetWorkspaceFile = join(testCwd, filename)
      expect(existsSync(targetWorkspaceFile)).toBe(true)
      expect(readFileSync(targetWorkspaceFile).length).toBe(4)
    } finally {
      rmSync(testCwd, { recursive: true, force: true })
    }
  })

  test('Given 图片任务失败 When 轮询任务 Then 保留后端错误且只提交一次', async () => {
    const urls: string[] = []
    const client = new PiImageGenerationToolClient({
      sessionId: 'session-failed',
      baseUrl: 'http://127.0.0.1:51740',
      pollIntervalMs: 0,
      fetchImpl: async (url) => {
        urls.push(String(url))
        return String(url).endsWith('/tasks')
          ? jsonResponse({ data: { task_id: 'task-failed', status: 'queued' } }, 202)
          : jsonResponse({ data: { task_id: 'task-failed', status: 'failed', error: '上游权限不足' } })
      },
    })
    await expect(client.execute({ prompt: '测试' }, undefined, `call-failed-${Date.now()}`)).rejects.toThrow('上游权限不足')
    expect(urls.filter((url) => url.endsWith('/tasks'))).toHaveLength(1)
  })

  test('Given 用户未登录或后端返回错误 When 执行生图 Then 抛出错误并保留具体消息', async () => {
    const client = new PiImageGenerationToolClient({
      sessionId: 'session-123',
      baseUrl: 'http://127.0.0.1:51740',
      fetchImpl: async () => jsonResponse({ error: '请先登录 Copis Working' }, 401),
    })

    await expect(client.execute({ prompt: '风景画' })).rejects.toThrow('请先登录 Copis Working')
  })

  test('Given 调用开始前已取消 When 执行生图 Then 不提交任务', async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    const client = new PiImageGenerationToolClient({
      sessionId: 'pre-abort',
      fetchImpl: async () => { calls += 1; return jsonResponse({}) },
    })
    await expect(client.execute({ prompt: '测试' }, controller.signal, 'abort-call')).rejects.toThrow()
    expect(calls).toBe(0)
  })

  test('Given 轮询返回其他任务 ID When 查询 Then 拒绝并保留当前 task_id', async () => {
    const client = new PiImageGenerationToolClient({
      sessionId: 'mismatch',
      pollIntervalMs: 0,
      fetchImpl: async (url) => String(url).endsWith('/tasks')
        ? jsonResponse({ data: { task_id: 'task-owned', status: 'queued' } }, 202)
        : jsonResponse({ data: { task_id: 'task-other', status: 'completed', image_url: 'https://image.test/a' } }),
    })
    await expect(client.execute({ prompt: '测试' }, undefined, `mismatch-${Date.now()}`)).rejects.toMatchObject({
      taskId: 'task-owned',
    })
  })

  test('Given 含特殊字符的 toolCallId When 提交图片任务 Then 发送稳定合法的 request_id', async () => {
    let body: Record<string, unknown> | undefined
    const client = new PiImageGenerationToolClient({
      sessionId: 'session|with|separator',
      pollIntervalMs: 0,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return jsonResponse({ data: { task_id: 'task-safe', status: 'failed', error: '停止' } }, 202)
      },
    })
    await expect(client.execute({ prompt: '测试' }, undefined, `call|unsafe/字符-${Date.now()}`)).rejects.toMatchObject({ taskId: 'task-safe' })
    expect(body?.request_id).toMatch(/^img_[a-f0-9]{64}$/)
  })

  test('Given 已知图片任务在轮询中取消 When 执行 Then 错误保留 task_id', async () => {
    const controller = new AbortController()
    const client = new PiImageGenerationToolClient({
      sessionId: 'cancel-known-task',
      pollIntervalMs: 0,
      sleepImpl: async () => {
        controller.abort()
        throw new DOMException('aborted', 'AbortError')
      },
      fetchImpl: async () => jsonResponse({ data: { task_id: 'task-cancelled', status: 'queued' } }, 202),
    })
    await expect(client.execute({ prompt: '测试' }, controller.signal, `cancel-${Date.now()}`)).rejects.toMatchObject({
      taskId: 'task-cancelled',
    })
  })

  test('Given 服务网络错误 When 执行生图 Then 抛出连接失败错误', async () => {
    const client = new PiImageGenerationToolClient({
      sessionId: 'session-123',
      baseUrl: 'http://127.0.0.1:51740',
      fetchImpl: async () => {
        throw new Error('Connection refused')
      },
    })

    await expect(client.execute({ prompt: '风景画' })).rejects.toThrow('Copis 图片生成服务连接失败')
  })

  test('Given Pi SDK When 调用 buildPiImageGenerationTools Then 正确注册 generate_image 工具', async () => {
    let registeredTool: unknown = null
    const mockSdk = {
      defineTool: (def: unknown) => {
        registeredTool = def
        return def
      },
    } as unknown as typeof import('@earendil-works/pi-coding-agent')

    const tools = buildPiImageGenerationTools(mockSdk, {
      sessionId: 'session-test',
      baseUrl: 'http://127.0.0.1:51740',
    })

    expect(tools).toHaveLength(3)
    expect(tools[1]?.name).toBe('get_image_task')
    expect(tools[2]?.name).toBe('list_image_tasks')
    const tool = tools[0] as { name: string; label: string; executionMode: string }
    expect(tool.name).toBe('generate_image')
    expect(tool.label).toBe('Copis 图片生成')
    expect(tool.executionMode).toBe('sequential')
  })

  test('Given buildBuiltinToolDefinitions When imageGenerationEnabled 为 true Then customTools 包含 generate_image', async () => {
    const { buildBuiltinToolDefinitions } = await import('./pi-agent-adapter')

    const mockSdk = {
      createReadToolDefinition: () => ({ name: 'Read' }),
      createBashToolDefinition: () => ({ name: 'Bash' }),
      createEditToolDefinition: () => ({ name: 'Edit' }),
      createWriteToolDefinition: () => ({ name: 'Write' }),
      createGrepToolDefinition: () => ({ name: 'Grep' }),
      createFindToolDefinition: () => ({ name: 'Find' }),
      createLsToolDefinition: () => ({ name: 'Ls' }),
      defineTool: (def: { name: string }) => ({ ...def }),
    } as unknown as typeof import('@earendil-works/pi-coding-agent')

    const enabledDefs = buildBuiltinToolDefinitions(
      mockSdk,
      '/test/cwd',
      undefined,
      undefined,
      {
        sessionId: 'session-1',
        useRustFileApi: false,
        imageGenerationEnabled: true,
      },
    )

    const disabledDefs = buildBuiltinToolDefinitions(
      mockSdk,
      '/test/cwd',
      undefined,
      undefined,
      {
        sessionId: 'session-2',
        useRustFileApi: false,
        imageGenerationEnabled: false,
      },
    )

    expect(enabledDefs.map((d) => d.name)).toContain('generate_image')
    expect(disabledDefs.map((d) => d.name)).not.toContain('generate_image')
  })
})
