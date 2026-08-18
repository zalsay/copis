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

  test('Given 非 VIP 用户 When 读取或保存模型目录 Then 隐藏目录并返回 vip_required', async () => {
    const settings = {
      themeMode: 'dark' as const,
      workingModelCatalog: {
        categories: [],
        models: [],
      },
      workingModelApiKeys: { 'model-1': 'encrypted-secret' },
    }
    let updateCalls = 0
    const dependencies: HttpApiDependencies = {
      ...createDependencies(),
      getWorkingClient: (() => ({
        baseUrl: 'https://backend.example.test',
        getCachedUser: () => ({ id: 1, isVip: false }),
      })) as unknown as HttpApiDependencies['getWorkingClient'],
      getAppSettings: () => settings,
      updateAppSettings: () => {
        updateCalls += 1
        return settings
      },
    }

    await expect(handleHttpApiRequest({ method: 'GET', path: '/api/settings' }, dependencies)).resolves.toEqual({
      status: 200,
      body: { themeMode: 'dark' },
    })
    await expect(handleHttpApiRequest({
      method: 'PATCH',
      path: '/api/settings',
      body: JSON.stringify({ themeMode: 'light', workingModelCatalog: { categories: [], models: [] } }),
    }, dependencies)).resolves.toEqual({
      status: 403,
      body: { error: '仅 VIP 用户可使用模型管理', code: 'vip_required' },
    })
    expect(updateCalls).toBe(0)
    expect(settings.themeMode).toBe('dark')

    await expect(handleHttpApiRequest({
      method: 'PATCH',
      path: '/api/settings',
      body: JSON.stringify({
        agentChannelId: 'copis-custom-ghost',
        agentModelId: 'ghost',
      }),
    }, dependencies)).resolves.toEqual({
      status: 403,
      body: { error: '仅 VIP 用户可使用模型管理', code: 'vip_required' },
    })
    expect(updateCalls).toBe(0)
  })

  test('Given VIP 用户尚未保存模型目录 When 通过 HTTP 读取设置 Then 返回空模型目录', async () => {
    const dependencies: HttpApiDependencies = {
      ...createDependencies(),
      getWorkingClient: (() => ({
        baseUrl: 'https://backend.example.test',
        getCachedUser: () => ({ id: 7, isVip: true }),
      })) as unknown as HttpApiDependencies['getWorkingClient'],
      getAppSettings: () => ({ themeMode: 'dark' }),
      getWorkingModelCatalog: () => ({ categories: [], models: [] }),
    }

    await expect(handleHttpApiRequest({ method: 'GET', path: '/api/settings' }, dependencies)).resolves.toEqual({
      status: 200,
      body: {
        themeMode: 'dark',
        workingModelCatalog: { categories: [], models: [] },
      },
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

  test('Working 支付路由不再由 Electron 业务桥处理', async () => {
    const response = await handleHttpApiRequest({
      method: 'GET',
      path: '/api/working/diamond-packages',
    }, createDependencies())

    expect(response).toEqual({
      status: 404,
      body: { error: 'Working API 路径不存在', code: 'not_found' },
    })
  })

  test('VIP 到账后通过 Rust 业务桥刷新认证并返回新的用户等级', async () => {
    const refreshAfterVipPayment = async () => ({ userId: '7', isVip: true })
    const authUpdates: unknown[] = []
    const response = await handleHttpApiRequest({
      method: 'POST',
      path: '/api/internal/working-auth/refresh-after-vip',
      body: '{}',
    }, {
      ...createDependencies(),
      getWorkingClient: (() => ({
        baseUrl: 'https://backend.example.test',
        refreshAfterVipPayment,
        getCachedUser: () => ({ id: 7, isVip: true, vipExpiresAt: '2026-09-12T00:00:00Z' }),
      })) as unknown as HttpApiDependencies['getWorkingClient'],
      notifyWorkingAuthUpdated: (payload: unknown) => authUpdates.push(payload),
    })

    expect(response).toEqual({
      status: 200,
      body: { userId: '7', isVip: true },
    })
    expect(authUpdates).toEqual([{
      authenticated: true,
      user: { id: 7, isVip: true, vipExpiresAt: '2026-09-12T00:00:00Z' },
      backendUrl: 'https://backend.example.test',
    }])
  })

  test('Rust Working 业务桥由主进程代发请求且只返回业务响应', async () => {
    const requests: unknown[] = []
    const response = await handleHttpApiRequest({
      method: 'POST',
      path: '/api/internal/working-auth/request',
      body: JSON.stringify({ method: 'GET', path: '/api/working/expert-skills' }),
    }, {
      ...createDependencies(),
      getWorkingClient: (() => ({
        baseUrl: 'https://backend.example.test',
        requestFromRust: async (input: unknown) => {
          requests.push(input)
          return { data: [{ id: 12, slug: 'weekly-report' }] }
        },
      })) as unknown as HttpApiDependencies['getWorkingClient'],
    })

    expect(response).toEqual({
      status: 200,
      body: { data: [{ id: 12, slug: 'weekly-report' }] },
    })
    expect(requests).toEqual([{ method: 'GET', path: '/api/working/expert-skills' }])
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

  test('Given 非 VIP 用户 When 浏览器请求创建自定义模型会话 Then 在写入会话前拒绝', async () => {
    const workspace = { id: 'workspace-1', slug: 'project-a' } as AgentWorkspace
    let createCalls = 0
    const dependencies: HttpApiDependencies = {
      ...createDependencies(),
      getWorkingClient: (() => ({
        baseUrl: 'https://backend.example.test',
        getCachedUser: () => ({ id: 7, isVip: false }),
      })) as unknown as HttpApiDependencies['getWorkingClient'],
      getAgentApi: async (): Promise<AgentHttpFacade> => ({
        ensureDefaultWorkspace: () => workspace,
        listAgentWorkspaces: () => [workspace],
        createAgentSession: () => {
          createCalls += 1
          return { id: 'session-1' } as AgentSessionMeta
        },
      } as unknown as AgentHttpFacade),
    }

    await expect(handleHttpApiRequest({
      method: 'POST',
      path: '/api/agent/sessions',
      body: JSON.stringify({
        channelId: 'copis-custom-model-1',
        modelId: 'provider-model-1',
        workspaceId: workspace.id,
      }),
    }, dependencies)).resolves.toEqual({
      status: 403,
      body: { error: '仅 VIP 用户可使用模型管理', code: 'vip_required' },
    })
    expect(createCalls).toBe(0)
  })

  test('Given 非 VIP 用户 When 浏览器持久化自定义模型选择 Then 在写入会话前拒绝', async () => {
    const dependencies: HttpApiDependencies = {
      ...createDependencies(),
      getWorkingClient: (() => ({
        baseUrl: 'https://backend.example.test',
        getCachedUser: () => ({ id: 7, isVip: false }),
      })) as unknown as HttpApiDependencies['getWorkingClient'],
      getAgentApi: async (): Promise<AgentHttpFacade> => ({
        getAgentSessionMeta: () => ({ id: 'session-1' } as AgentSessionMeta),
        updateAgentSessionModel: () => {
          throw new Error('不应写入会话')
        },
      } as unknown as AgentHttpFacade),
    }

    await expect(handleHttpApiRequest({
      method: 'PATCH',
      path: '/api/agent/sessions/session-1/model',
      body: JSON.stringify({
        channelId: 'copis-custom-model-1',
        modelId: 'provider-model-1',
      }),
    }, dependencies)).resolves.toEqual({
      status: 403,
      body: { error: '仅 VIP 用户可使用模型管理', code: 'vip_required' },
    })
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
