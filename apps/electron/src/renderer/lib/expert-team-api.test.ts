import { afterEach, describe, expect, test } from 'bun:test'
import { expertTeamApi, ExpertTeamApiError } from './expert-team-api'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('expertTeamApi', () => {
  test('将 Rust schema snapshot 转为 renderer DAG，并保留 revision', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify({ schemas: [{
        id: 'team', name: '研究团队', description: 'desc', currentRevisionId: 7, revision: 2,
        snapshot: { id: 'team', name: '研究团队', nodes: [
          { id: 'research', role: 'researcher', dependsOn: [], config: {} },
          { id: 'write', role: 'writer', dependsOn: ['research'], config: {} },
        ], metadata: {} },
      }] }), { status: 200 })
    }) as unknown as typeof fetch

    const schemas = await expertTeamApi.listSchemas()
    expect(schemas[0]).toMatchObject({ id: 'team', currentRevisionId: 7, revision: 2 })
    expect(schemas[0]?.nodes.map((node) => node.id)).toEqual(['research', 'write'])
    expect(schemas[0]?.edges).toEqual([{ from: 'research', to: 'write' }])
    expect(calls[0]?.url).toContain('/api/expert-teams/schemas')
  })

  test('从 schema 详情的当前 revision snapshot 恢复 DAG', async () => {
    globalThis.fetch = (async (): Promise<Response> => new Response(JSON.stringify({
      id: 'team', name: '研究团队', currentRevisionId: 7,
      revisions: [{ id: 7, revision: 1, snapshot: { id: 'team', name: '研究团队', nodes: [{ id: 'research', role: 'researcher', dependsOn: [] }], metadata: {} } }],
    }), { status: 200 })) as unknown as typeof fetch
    const schema = await expertTeamApi.getSchema('team')
    expect(schema.nodes[0]).toMatchObject({ id: 'research', role: 'researcher' })
    expect(schema.revision).toBe(1)
  })

  test('发布 schema 时使用 camelCase 节点协议', async () => {
    let body = ''
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      body = String(init?.body)
      return new Response(JSON.stringify({
        id: 'team', revision: 1, schemaRevisionId: 3, sha256: 'hash',
        snapshot: { id: 'team', name: '研究团队', nodes: [{ id: 'research', role: 'researcher', dependsOn: [] }], metadata: {} },
      }), { status: 201 })
    }) as unknown as typeof fetch
    const schema = await expertTeamApi.publishSchema({ name: '研究团队', nodes: [{ id: 'research', role: 'researcher', dependsOn: [] }] })
    expect(schema.revision).toBe(1)
    expect(schema.nodes[0]?.dependsOn).toEqual([])
    expect(JSON.parse(body).nodes[0]).toMatchObject({ id: 'research', role: 'researcher', dependsOn: [] })
  })

  test('发送 workspace binding 与 run revision，并归一化 queued/canceled 状态', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init })
      if (String(input).endsWith('/binding')) return new Response(JSON.stringify({ schemaId: 'team', schemaRevisionId: 7, workspaceSlug: 'demo' }), { status: 200 })
      return new Response(JSON.stringify({ id: 'run-1', schemaId: 'team', workspaceSlug: 'demo', status: 'queued', input: 'goal', createdAt: 1 }), { status: 201 })
    }) as unknown as typeof fetch

    await expertTeamApi.bindWorkspace('demo', { schemaId: 'team', schemaRevisionId: 7, schemaRevision: 2 })
    const run = await expertTeamApi.createRun({ schemaId: 'team', workspaceSlug: 'demo', schemaRevisionId: 7, input: 'goal' })
    expect(run.status).toBe('queued')
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ schemaId: 'team', schemaRevisionId: 7 })
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ schemaId: 'team', schemaRevisionId: 7, input: 'goal' })
  })

  test('Given 已保存工作区运行 When 工作台重新打开 Then 恢复 binding 和筛选后的最近运行', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/workspaces/demo/binding')) {
        return new Response(JSON.stringify({ workspaceSlug: 'demo', schemaId: 'team', schemaRevisionId: 7 }), { status: 200 })
      }
      return new Response(JSON.stringify({ runs: [
        { id: 'run-1', schemaId: 'team', workspaceSlug: 'demo', status: 'queued', input: {}, createdAt: 1 },
      ] }), { status: 200 })
    }) as unknown as typeof fetch

    const binding = await expertTeamApi.getWorkspaceBinding('demo')
    const runs = await expertTeamApi.listRuns({ workspaceSlug: 'demo', schemaId: 'team' })

    expect(binding).toMatchObject({ workspaceSlug: 'demo', schemaId: 'team', schemaRevisionId: 7 })
    expect(runs).toMatchObject([{ id: 'run-1', workspaceSlug: 'demo', schemaId: 'team' }])
    expect(calls[1]).toContain('/api/expert-teams/runs?workspaceSlug=demo&schemaId=team')
  })

  test('未绑定工作区以空值恢复，不将首次使用视为错误', async () => {
    globalThis.fetch = (async (): Promise<Response> => new Response(JSON.stringify({ error: '尚未绑定' }), { status: 404 })) as unknown as typeof fetch
    await expect(expertTeamApi.getWorkspaceBinding('demo')).resolves.toBeNull()
  })

  test('按 error/code 抛出结构化错误', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: '无法取消', code: 'run_conflict' }), { status: 409 })) as unknown as typeof fetch
    await expect(expertTeamApi.cancelRun('run-1')).rejects.toBeInstanceOf(ExpertTeamApiError)
    await expect(expertTeamApi.cancelRun('run-1')).rejects.toMatchObject({ message: '无法取消', code: 'run_conflict', status: 409 })
  })
})
