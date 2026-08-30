import { describe, expect, test, mock } from 'bun:test'
import { buildPiMemoryTools } from './pi-memory-tools'
import type { MemoryApiClient } from '../memory-api-client-runtime'

function createFakeSdk() {
  return {
    defineTool: (def: unknown) => def,
  } as unknown as typeof import('@earendil-works/pi-coding-agent')
}

describe('pi-memory-tools', () => {
  test('Given memoryPolicy=off Then 返回空工具列表', () => {
    const sdk = createFakeSdk()
    const tools = buildPiMemoryTools(sdk, { memoryPolicy: 'off' })
    expect(tools).toHaveLength(0)
  })

  test('Given memoryPolicy=visible Then 仅返回 memory_recall 和 memory_read', () => {
    const sdk = createFakeSdk()
    const tools = buildPiMemoryTools(sdk, { memoryPolicy: 'visible' })
    const names = tools.map((t) => t.name)
    expect(names).toEqual(['memory_recall', 'memory_read'])
  })

  test('Given memoryPolicy=writable Then 返回全部 4 个 Memory 工具', () => {
    const sdk = createFakeSdk()
    const tools = buildPiMemoryTools(sdk, { memoryPolicy: 'writable', workspaceSlug: 'demo' })
    const names = tools.map((t) => t.name)
    expect(names).toEqual(['memory_recall', 'memory_read', 'memory_capture', 'memory_rewrite'])
  })

  test('Given memory_recall When 执行 Then 正确调用 apiClient.recall 并返回格式化结果', async () => {
    const sdk = createFakeSdk()
    const mockRecall = mock(async (input: unknown) => ({ entries: [{ id: 'mem-1' }], total: 1, limit: 8 }))
    const fakeClient = {
      recall: mockRecall,
    } as unknown as MemoryApiClient

    const tools = buildPiMemoryTools(sdk, {
      workspaceSlug: 'my-project',
      memoryPolicy: 'writable',
      memoryApiClient: fakeClient,
    })
    const recallTool = tools.find((t) => t.name === 'memory_recall')!

    const res = await (recallTool as any).execute('call-1', { query: '前端架构', limit: 5 })
    expect(mockRecall).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceSlug: 'my-project', query: '前端架构', limit: 5 }),
      undefined,
    )
    expect(res.details).toEqual({ entries: [{ id: 'mem-1' }], total: 1, limit: 8 })
  })

  test('Given memory_read When 执行 Then 正确调用 apiClient.read 并返回记忆详情', async () => {
    const sdk = createFakeSdk()
    const mockRead = mock(async (id: string, slug?: string) => ({ id, title: '项目架构', revision: 1, content: 'Vue 3' }))
    const fakeClient = {
      read: mockRead,
    } as unknown as MemoryApiClient

    const tools = buildPiMemoryTools(sdk, {
      workspaceSlug: 'my-project',
      memoryPolicy: 'writable',
      memoryApiClient: fakeClient,
    })
    const readTool = tools.find((t) => t.name === 'memory_read')!

    const res = await (readTool as any).execute('call-2', { id: 'mem-123' })
    expect(mockRead).toHaveBeenCalledWith('mem-123', 'my-project', undefined)
    expect(res.details).toEqual({ entry: { id: 'mem-123', title: '项目架构', revision: 1, content: 'Vue 3' } })
  })

  test('Given memory_capture When 无 workspaceSlug Then 抛出异常阻断写入', async () => {
    const sdk = createFakeSdk()
    const fakeClient = {
      capture: mock(async () => ({})),
    } as unknown as MemoryApiClient

    const tools = buildPiMemoryTools(sdk, {
      memoryPolicy: 'writable',
      memoryApiClient: fakeClient,
    })
    const captureTool = tools.find((t) => t.name === 'memory_capture')!

    await expect((captureTool as any).execute('call-3', {
      title: '测试',
      content: '内容',
      kind: 'fact',
    })).rejects.toThrow('当前没有工作区')
  })

  test('Given memory_capture When 有 workspaceSlug Then 正确调用 apiClient.capture', async () => {
    const sdk = createFakeSdk()
    const mockCapture = mock(async (input: unknown) => ({ entry: { id: 'mem-new' } }))
    const fakeClient = {
      capture: mockCapture,
    } as unknown as MemoryApiClient

    const tools = buildPiMemoryTools(sdk, {
      workspaceSlug: 'my-project',
      memoryPolicy: 'writable',
      memoryApiClient: fakeClient,
    })
    const captureTool = tools.find((t) => t.name === 'memory_capture')!

    const res = await (captureTool as any).execute('call-4', {
      title: '技术栈决策',
      content: '使用 Vite + Vue 3',
      kind: 'decision',
      tags: ['arch', 'frontend'],
    })
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceSlug: 'my-project',
        title: '技术栈决策',
        content: '使用 Vite + Vue 3',
        kind: 'decision',
        tags: ['arch', 'frontend'],
      }),
      undefined,
    )
    expect(res.details).toEqual({ entry: { id: 'mem-new' } })
  })

  test('Given memory_rewrite When expectedRevision 无效或未提供更新内容 Then 抛出错误', async () => {
    const sdk = createFakeSdk()
    const fakeClient = {
      rewrite: mock(async () => ({})),
    } as unknown as MemoryApiClient

    const tools = buildPiMemoryTools(sdk, {
      workspaceSlug: 'my-project',
      memoryPolicy: 'writable',
      memoryApiClient: fakeClient,
    })
    const rewriteTool = tools.find((t) => t.name === 'memory_rewrite')!

    await expect((rewriteTool as any).execute('call-5', {
      id: 'mem-1',
      title: '新标题',
      expectedRevision: 0,
    })).rejects.toThrow('expectedRevision 必须是正整数')

    await expect((rewriteTool as any).execute('call-6', {
      id: 'mem-1',
      expectedRevision: 2,
    })).rejects.toThrow('至少提供 title、content 或 tags 之一')
  })
})
