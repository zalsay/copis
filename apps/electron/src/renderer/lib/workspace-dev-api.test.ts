import { afterEach, describe, expect, test } from 'bun:test'
import {
  listWorkspaceDevProjects,
  startWorkspaceDevProject,
  stopWorkspaceDevProject,
} from './workspace-dev-api'

const originalFetch = globalThis.fetch
const originalSetTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout

afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.setTimeout = originalSetTimeout
  globalThis.clearTimeout = originalClearTimeout
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

  test('Given 开发服务未响应 When 停止项目 Then 在超时后返回可重试错误', async () => {
    let requestSignal: AbortSignal | undefined
    globalThis.setTimeout = ((handler: TimerHandler) => {
      if (typeof handler === 'function') {
        const callback = handler as () => void
        queueMicrotask(callback)
      }
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout
    globalThis.clearTimeout = (() => undefined) as typeof clearTimeout
    globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requestSignal = init?.signal ?? undefined
      return new Promise<Response>((_, reject) => {
        requestSignal?.addEventListener('abort', () => {
          reject(new DOMException('请求已中止', 'AbortError'))
        }, { once: true })
      })
    }) as typeof fetch

    await expect(stopWorkspaceDevProject('default', 'workbench')).rejects.toMatchObject({
      message: '项目开发服务响应超时，请重试',
      status: 408,
      code: 'REQUEST_TIMEOUT',
    })
    expect(requestSignal?.aborted).toBe(true)
  })
})
