import { afterEach, describe, expect, test } from 'bun:test'
import {
  listWorkspaceDevProjects,
  startWorkspaceDevProject,
  stopWorkspaceDevProject,
} from './workspace-dev-api'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('workspace development API', () => {
  test('Given Vite 项目 When 请求开发服务 Then 使用 Rust 项目列表、启动与停止端点', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify({
        projectPath: 'landing', name: 'landing', kind: 'vite', port: 5175, status: 'running',
      }), { status: 200 })
    }) as unknown as typeof fetch

    await listWorkspaceDevProjects('demo workspace')
    await startWorkspaceDevProject('demo workspace', 'landing')
    await stopWorkspaceDevProject('demo workspace', 'landing')

    expect(calls[0]?.url).toContain('/api/workspaces/demo%20workspace/dev-projects')
    expect(calls[0]?.init?.method).toBe('GET')
    expect(calls[1]?.url).toContain('/api/workspaces/demo%20workspace/dev-projects/start')
    expect(calls[1]?.init?.method).toBe('POST')
    expect(calls[1]?.init?.body).toBe(JSON.stringify({ projectPath: 'landing' }))
    expect(calls[2]?.url).toContain('/api/workspaces/demo%20workspace/dev-projects/stop')
    expect(calls[2]?.init?.method).toBe('POST')
  })
})
