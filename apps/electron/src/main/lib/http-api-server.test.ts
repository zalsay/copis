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

// 路由测试只验证 HTTP facade，不加载真实的本地 Skill 文件服务。
mock.module('./working-skill-market-service', () => ({
  installWorkingExpertSkill: async () => ({ slug: 'mock-skill', name: 'Mock Skill', enabled: true }),
  listWorkingExpertSkillMarketForWorkspace: async () => [],
  uninstallWorkingExpertSkill: async () => {},
}))

const { handleHttpApiRequest } = await import('./http-api-handler')

describe('Rust HTTP API 业务桥契约', () => {
  function createMarketDependencies(calls: string[]): HttpApiDependencies {
    return {
      getWorkingClient: (() => ({ baseUrl: 'https://backend.example.test' })) as unknown as HttpApiDependencies['getWorkingClient'],
      getAppSettings: (() => ({})) as unknown as HttpApiDependencies['getAppSettings'],
      updateAppSettings: (() => ({})) as unknown as HttpApiDependencies['updateAppSettings'],
      getSkillMarketApi: () => ({
        listForWorkspace: async (workspaceSlug) => {
          calls.push(`list:${workspaceSlug}`)
          return [{ id: 12, slug: 'weekly-report', name: '周报', description: '整理周报', enabled: true, localInstalled: true, version: '1.2.0', installed: true, category: '文档', accent: 'blue', sourceProvider: 'skillhub', syncStatus: 'ready' }]
        },
        install: async (workspaceSlug, skillId) => {
          calls.push(`install:${workspaceSlug}:${String(skillId)}`)
          return { slug: 'weekly-report', name: '周报', enabled: true }
        },
        uninstall: async (workspaceSlug, skillId) => {
          calls.push(`uninstall:${workspaceSlug}:${String(skillId)}`)
        },
      }),
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

  test('通过 Rust HTTP 路由转发技能市场列表、安装和卸载', async () => {
    const calls: string[] = []
    const dependencies = createMarketDependencies(calls)

    const listed = await handleHttpApiRequest({
      method: 'GET',
      path: '/api/working/skill-market?workspaceSlug=default-project',
    }, dependencies)
    expect(listed.status).toBe(200)
    expect(listed.body).toEqual([expect.objectContaining({ slug: 'weekly-report', localInstalled: true })])

    const installed = await handleHttpApiRequest({
      method: 'POST',
      path: '/api/working/skill-market/12/install?workspaceSlug=default-project',
      body: '{}',
    }, dependencies)
    expect(installed.status).toBe(200)

    const uninstalled = await handleHttpApiRequest({
      method: 'DELETE',
      path: '/api/working/skill-market/12/install?workspaceSlug=default-project',
    }, dependencies)
    expect(uninstalled.status).toBe(204)
    expect(calls).toEqual([
      'list:default-project',
      'install:default-project:12',
      'uninstall:default-project:12',
    ])
  })

  test('技能市场路由缺少工作区 slug 时拒绝请求', async () => {
    const response = await handleHttpApiRequest({
      method: 'GET',
      path: '/api/working/skill-market',
    }, createMarketDependencies([]))

    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: '工作区 slug 不能为空', code: 'invalid_workspace_slug' })
  })
})
