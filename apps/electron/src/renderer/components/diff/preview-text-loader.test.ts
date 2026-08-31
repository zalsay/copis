import { describe, expect, test } from 'bun:test'
import { loadPreviewText } from './preview-text-loader'

describe('Markdown 预览文本加载', () => {
  test('HTTP 文件 API 失败时回退到旧版 IPC 读取', async () => {
    const result = await loadPreviewText({
      readViaHttp: async () => {
        throw new Error('HTTP API 不可用')
      },
      readViaIpc: async () => ({
        resolvedPath: '/workspace/notes.md',
        content: '# 可见内容',
      }),
    })

    expect(result).toEqual({
      source: 'ipc',
      resolvedPath: '/workspace/notes.md',
      content: '# 可见内容',
    })
  })

  test('两个读取入口都失败时返回加载错误而不是空内容', async () => {
    const httpError = new Error('HTTP API 不可用')
    const result = await loadPreviewText({
      readViaHttp: async () => {
        throw httpError
      },
      readViaIpc: async () => null,
    })

    expect(result).toEqual({
      source: 'error',
      error: httpError,
    })
  })

  test('HTTP 失败且调用方已取消时不启动 IPC 回退', async () => {
    let ipcCalls = 0
    const loaders = {
      shouldAbort: () => true,
      readViaHttp: async () => {
        throw new Error('HTTP API 不可用')
      },
      readViaIpc: async () => {
        ipcCalls += 1
        return {
          resolvedPath: '/workspace/notes.md',
          content: '# 不应读取',
        }
      },
    }

    const result = await loadPreviewText(loaders)

    expect(ipcCalls).toBe(0)
    expect(result.source).toBe('error')
  })
})
