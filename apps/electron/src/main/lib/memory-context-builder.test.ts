import { beforeAll, describe, expect, mock, test } from 'bun:test'

let contextCalls = 0
let contextImpl = async () => ({ text: '用户偏好：中文', entries: [], generatedAt: 1 })

mock.module('./memory-api-client', () => ({
    memoryApiClient: {
      context: async () => {
        contextCalls += 1
        return contextImpl()
      },
  },
}))

let appendMemoryContext: typeof import('./memory-context-builder').appendMemoryContext

beforeAll(async () => {
  ({ appendMemoryContext } = await import('./memory-context-builder'))
})

describe('动态 Memory context 边界', () => {
  test('Given off policy When构建 prompt Then不访问 Memory API', async () => {
    contextCalls = 0
    expect(await appendMemoryContext('原始上下文', {
      userMessage: '测试',
      policy: 'off',
    })).toBe('原始上下文')
    expect(contextCalls).toBe(0)
  })

  test('Given visible policy When Memory API 返回内容 Then以参考标签追加', async () => {
    contextImpl = async () => ({ text: '用户偏好：中文', entries: [], generatedAt: 1 })
    expect(await appendMemoryContext('原始上下文', {
      workspaceSlug: 'project-a',
      userMessage: '语言偏好',
      policy: 'visible',
    })).toContain('<copis_memory_context>\n用户偏好：中文\n</copis_memory_context>')
    expect(contextCalls).toBe(1)
  })

  test('Given Memory API 失败 When构建 prompt Then保留原始上下文', async () => {
    contextImpl = async () => { throw new Error('服务不可用') }
    expect(await appendMemoryContext('原始上下文', {
      userMessage: '失败测试',
      policy: 'writable',
    })).toBe('原始上下文')
  })
})
