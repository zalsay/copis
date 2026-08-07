import { describe, expect, mock, test } from 'bun:test'

mock.module('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' },
  shell: {},
  safeStorage: {},
  BrowserWindow: class {},
  WebContentsView: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  screen: {},
}))
const { HttpExpertTeamRustApiClient } = await import('./expert-team-rust-client')

describe('HttpExpertTeamRustApiClient', () => {
  test('使用内部 token 调用 Rust expert-team 状态端点', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const client = new HttpExpertTeamRustApiClient({
      baseUrl: 'http://127.0.0.1:51730',
      getToken: () => 'internal-token',
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), init })
        return new Response('{}', { status: 200 })
      },
    })

    await client.claimRun('run-1')
    await client.nodeStarted({ runId: 'run-1', nodeId: 'node-1', childSessionId: 'child-1', outputDir: '/workspace/.copis/expert-team-runs/run-1/node-1' })
    await client.nodeCompleted({ runId: 'run-1', nodeId: 'node-1', childSessionId: 'child-1', summary: 'done', noArtifact: true })
    await client.nodeFailed({ runId: 'run-1', nodeId: 'node-1', error: 'failed' })
    await client.nodeCancelled({ runId: 'run-1', nodeId: 'node-1', reason: 'cancelled' })
    await client.appendEvent({ runId: 'run-1', nodeId: 'node-1', type: 'succeeded', payload: { summary: 'done' } })
    await client.recordArtifact({ runId: 'run-1', nodeId: 'node-1', path: 'result.md', sizeBytes: 4, sha256: 'hash' })
    await client.completeRun({ runId: 'run-1', status: 'succeeded' })

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/api/internal/expert-teams/runs/run-1/claim',
      '/api/internal/expert-teams/runs/run-1/nodes/node-1',
      '/api/internal/expert-teams/runs/run-1/nodes/node-1',
      '/api/internal/expert-teams/runs/run-1/nodes/node-1',
      '/api/internal/expert-teams/runs/run-1/nodes/node-1',
      '/api/internal/expert-teams/runs/run-1/events',
      '/api/internal/expert-teams/runs/run-1/artifacts',
      '/api/internal/expert-teams/runs/run-1/complete',
    ])
    expect(requests.every((request) => request.init?.headers && (request.init.headers as Record<string, string>)['X-Copis-Internal-Token'] === 'internal-token')).toBe(true)
    expect(JSON.parse(String(requests[1]?.init?.body))).toMatchObject({ status: 'running' })
    expect(JSON.parse(String(requests[6]?.init?.body))).toMatchObject({ name: 'result.md', path: 'result.md' })
  })

  test('拒绝未授权或危险路径组件', async () => {
    const client = new HttpExpertTeamRustApiClient({ getToken: () => null, fetchImpl: async () => new Response('{}') })
    await expect(client.claimRun('run-1')).rejects.toThrow('尚未启动')
    const authorized = new HttpExpertTeamRustApiClient({ getToken: () => 'token', fetchImpl: async () => new Response('{}', { status: 200 }) })
    await expect(authorized.claimRun('../run')).rejects.toThrow('runId 参数不正确')
  })
})
