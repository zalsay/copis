import { describe, expect, mock, test } from 'bun:test'
import { COPIS_WORKING_FAST_MODEL_ID, type AgentSessionMeta, type AgentWorkspace } from '@copis/shared'
import type { AgentHttpFacade, HttpApiDependencies } from './http-api-handler'

// Bun 测试环境没有 Electron 原生模块，健康检查测试不需要真实凭证存储。
mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => '/tmp/copis-test-app-data',
  },
  BrowserWindow: class {},
  WebContentsView: class {},
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

  test('MCP 测试路由缺少 entry 时返回 400', async () => {
    const response = await handleHttpApiRequest({
      method: 'POST',
      path: '/api/mcp/test',
      body: JSON.stringify({ name: 'filesystem' }),
    }, createDependencies())

    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'MCP 配置不正确', code: 'invalid_request' })
  })

  test('MCP 扩展路径不存在时返回统一错误', async () => {
    const response = await handleHttpApiRequest({
      method: 'GET',
      path: '/api/workspaces/demo-project/mcp/unknown',
    }, createDependencies())

    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: 'MCP 路径不存在', code: 'not_found' })
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

  test('Given 专家团队工作台创建会话 When 通过 Rust HTTP API 提交 Then 保留运行与 Schema 关联', async () => {
    const workspace = { id: 'workspace-1', slug: 'project-a' } as AgentWorkspace
    const calls: unknown[][] = []
    const dependencies: HttpApiDependencies = {
      ...createDependencies(),
      getAgentApi: async (): Promise<AgentHttpFacade> => ({
        ensureDefaultWorkspace: () => workspace,
        listAgentWorkspaces: () => [workspace],
        createAgentSession: (...args: Parameters<AgentHttpFacade['createAgentSession']>) => {
          calls.push(args)
          return {
            id: 'session-1',
            title: '专家团队 · 研究',
            createdAt: 1,
            updatedAt: 1,
            workspaceId: workspace.id,
            expertTeamSession: args[6],
          } as AgentSessionMeta
        },
      } as unknown as AgentHttpFacade),
    }

    const response = await handleHttpApiRequest({
      method: 'POST',
      path: '/api/agent/sessions',
      body: JSON.stringify({
        title: '专家团队 · 研究',
        workspaceId: workspace.id,
        expertTeamSession: { runId: 'run-1', schemaId: 'research-v1', schemaRevisionId: 8 },
      }),
    }, dependencies)

    expect(response).toMatchObject({
      status: 201,
      body: { id: 'session-1', expertTeamSession: { runId: 'run-1', schemaId: 'research-v1', schemaRevisionId: 8 } },
    })
    expect(calls).toEqual([[
      '专家团队 · 研究',
      'copis-working',
      'workspace-1',
      COPIS_WORKING_FAST_MODEL_ID,
      'pi',
      undefined,
      { runId: 'run-1', schemaId: 'research-v1', schemaRevisionId: 8 },
    ]])
  })

  test('删除 Agent 会话路由只删除指定会话并返回 204', async () => {
    const deleted: string[] = []
    const dependencies: HttpApiDependencies = {
      ...createDependencies(),
      getAgentApi: async (): Promise<AgentHttpFacade> => ({
        getAgentSessionMeta: (id: string) => id === 'session-1' ? { id: 'session-1' } as AgentSessionMeta : undefined,
        deleteAgentSession: (id: string) => { deleted.push(id) },
      } as unknown as AgentHttpFacade),
    }

    const response = await handleHttpApiRequest({
      method: 'DELETE',
      path: '/api/agent/sessions/session-1',
    }, dependencies)

    expect(response).toEqual({ status: 204 })
    expect(deleted).toEqual(['session-1'])
  })
})
