import { describe, expect, mock, test } from 'bun:test'
import {
  PiImageGenerationToolClient,
  PiImageGenerationToolError,
  base64FromDataUrl,
  detectBase64ImageType,
  extensionForMediaType,
  buildPiImageGenerationTools,
} from './pi-image-generation-tool'

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
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
        return jsonResponse({
          data_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          content_type: 'image/png',
          deducted_tokens: 10,
          balance_after: 90,
        })
      },
    })

    const result = await client.execute({ prompt: '一只可爱的小猫', size: '1024x1024' })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('http://127.0.0.1:51740/api/working/image')
    expect(calls[0]?.body).toEqual({
      prompt: '一只可爱的小猫',
      size: '1024x1024',
      run_id: 'session-123',
    })

    expect(result.text).toContain('图片已成功生成（1 张）')
    expect(result.text).toContain('消耗 10 钻石，余额 90')
    expect(result.text).toContain('<generated_images>')
    expect(result.text).toContain('session-123/copis-image-')
    expect(result.mediaType).toBe('image/png')
    expect(result.meta).toHaveLength(1)
    expect(result.meta[0]?.mediaType).toBe('image/png')
  })

  test('Given 用户未登录或后端返回错误 When 执行生图 Then 抛出错误并保留具体消息', async () => {
    const client = new PiImageGenerationToolClient({
      sessionId: 'session-123',
      baseUrl: 'http://127.0.0.1:51740',
      fetchImpl: async () => jsonResponse({ error: '请先登录 Copis Working' }, 401),
    })

    await expect(client.execute({ prompt: '风景画' })).rejects.toThrow('请先登录 Copis Working')
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

    expect(tools).toHaveLength(1)
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

