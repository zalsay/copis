import { describe, expect, mock, test } from 'bun:test'
import type { HttpApiDependencies } from './http-api-handler'

// Bun 测试环境没有 Electron 原生模块，健康检查测试不需要真实凭证存储。
mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => '/tmp/copis-test-app-data',
  },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {
    openExternal: async () => {},
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}))

const { handleHttpApiRequest } = await import('./http-api-handler')

describe('Rust HTTP API 业务桥契约', () => {
  function createDependencies(): HttpApiDependencies {
    return {
      getWorkingClient: (() => ({ baseUrl: 'https://backend.example.test' })) as unknown as HttpApiDependencies['getWorkingClient'],
      getAppSettings: (() => ({})) as unknown as HttpApiDependencies['getAppSettings'],
      updateAppSettings: (() => ({})) as unknown as HttpApiDependencies['updateAppSettings'],
    }
  }

  test('健康检查保持原有响应格式', async () => {
    const response = await handleHttpApiRequest({
      method: 'GET',
      path: '/api/health',
    })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      ok: true,
      service: 'copis-http-api',
      port: 51730,
    })
  })

  test('未知路径返回统一错误结构', async () => {
    const response = await handleHttpApiRequest({
      method: 'GET',
      path: '/api/unknown',
    })

    expect(response.status).toBe(404)
    expect(response.body).toEqual({
      error: 'HTTP API 路径不存在',
      code: 'not_found',
    })
  })

  test('非法 JSON 保持原有错误码', async () => {
    const response = await handleHttpApiRequest({
      method: 'PATCH',
      path: '/api/settings',
      body: '{',
    })

    expect(response.status).toBe(400)
    expect(response.body).toEqual({
      error: '请求体不是有效的 JSON',
      code: 'invalid_json',
    })
  })

  test('技能市场路由不再由 Electron 业务桥处理', async () => {
    const response = await handleHttpApiRequest({
      method: 'GET',
      path: '/api/working/skill-market?workspaceSlug=default-project',
    }, createDependencies())

    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: 'Working API 路径不存在', code: 'not_found' })
  })

  test('文件文本读写路由将上下文转发给文件服务', async () => {
    const received: unknown[] = []
    const dependencies: HttpApiDependencies = {
      ...createDependencies(),
      getFileApi: () => ({
        readText: (input) => {
          received.push(input)
          return { resolvedPath: input.path, content: '初始内容', revision: 'revision-1' }
        },
        writeText: (input) => {
          received.push(input)
          return { resolvedPath: input.path, revision: 'revision-2' }
        },
      }),
    }

    const read = await handleHttpApiRequest({
      method: 'POST',
      path: '/api/files/read-text',
      body: JSON.stringify({ path: '/workspace/note.md', sessionId: 'session-1' }),
    }, dependencies)
    const write = await handleHttpApiRequest({
      method: 'PUT',
      path: '/api/files/text',
      body: JSON.stringify({ path: '/workspace/note.md', content: '更新内容', expectedRevision: 'revision-1' }),
    }, dependencies)

    expect(read).toEqual({ status: 200, body: { resolvedPath: '/workspace/note.md', content: '初始内容', revision: 'revision-1' } })
    expect(write).toEqual({ status: 200, body: { resolvedPath: '/workspace/note.md', revision: 'revision-2' } })
    expect(received).toEqual([
      { path: '/workspace/note.md', sessionId: 'session-1' },
      { path: '/workspace/note.md', content: '更新内容', expectedRevision: 'revision-1' },
    ])
  })
})
