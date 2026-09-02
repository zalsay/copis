import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

type AgentSessionManager = typeof import('./agent-session-manager')
type AgentSessionContextPrompt = typeof import('./agent-session-context-prompt')

let manager: AgentSessionManager
let contextPrompt: AgentSessionContextPrompt
let tempHome: string
const originalHome = process.env.HOME
const originalCopisDev = process.env.COPIS_DEV

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(process.env.HOME ?? tempHome, 'Library', 'Application Support'),
  },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

function jsonl(rows: string[]): string {
  return rows.join('\n') + '\n'
}

function writeAgentSessionJsonl(sessionId: string, rows: string[]): void {
  const dir = join(tempHome, '.copis', 'agent-sessions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sessionId}.jsonl`), jsonl(rows), 'utf-8')
}

function writeAgentSessionsIndex(sessions: Array<{
  id: string
  title: string
  workspaceId: string
  createdAt: number
  updatedAt: number
}>): void {
  const dir = join(tempHome, '.copis')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-sessions.json'), JSON.stringify({ version: 1, sessions }), 'utf-8')
}

function writeAgentWorkspacesIndex(workspaces: Array<{
  id: string
  name: string
  slug: string
  projectRootPath?: string
  allowWorkspaceWrite?: boolean
  createdAt: number
  updatedAt: number
}>): void {
  const dir = join(tempHome, '.copis')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-workspaces.json'), JSON.stringify({ version: 2, workspaces }), 'utf-8')
}

function createIndexedSessions(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `session-${index}`,
    title: `会话 ${index}`,
    workspaceId: 'workspace-a',
    createdAt: index,
    updatedAt: index,
  }))
}

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'copis-agent-session-manager-'))
  process.env.HOME = tempHome
  process.env.COPIS_DEV = '0'
  manager = await import('./agent-session-manager')
  contextPrompt = await import('./agent-session-context-prompt')
})

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalCopisDev === undefined) {
    delete process.env.COPIS_DEV
  } else {
    process.env.COPIS_DEV = originalCopisDev
  }
  rmSync(tempHome, { recursive: true, force: true })
})

describe('Agent 会话 JSONL 读取', () => {
  test('Given 会话 JSONL 混入损坏行 When 读取 SDKMessage Then 跳过坏行并保留其它消息', () => {
    writeAgentSessionJsonl('session-with-bad-line', [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '你好' }] }, parent_tool_use_id: null }),
      '{ 这不是合法 JSON',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '仍然可读' }] }, parent_tool_use_id: null }),
    ])

    const messages = manager.getAgentSessionSDKMessages('session-with-bad-line')

    expect(messages.map((message) => message.type)).toEqual(['user', 'assistant'])
  })

  test('Given 会话 JSONL 存在损坏行 When 截断 SDKMessage Then 抛错避免重写不完整历史', () => {
    writeAgentSessionJsonl('session-truncate-bad-line', [
      JSON.stringify({ type: 'assistant', uuid: 'assistant-1', message: { content: [{ type: 'text', text: '完成' }] } }),
      '{ 这不是合法 JSON',
    ])

    expect(() => manager.truncateSDKMessages('session-truncate-bad-line', 'assistant-1'))
      .toThrow('JSONL 第 2 行解析失败')
  })
})

describe('Agent 会话 runtime 元数据', () => {
  test('Given 父 Agent 没有安全 Pi artifact When 创建侧问答 Then 创建归档 Agent 子会话并通过引用上下文兜底', async () => {
    const parent = manager.createAgentSession('父 Agent', 'channel-1', undefined, 'model-1')

    const result = await manager.createAgentSideQuestionSession({
      parentSessionId: parent.id,
      upToMessageUuid: 'completed-assistant',
      modelId: 'model-1',
    })

    expect(result.contextMode).toBe('referenced-session')
    expect(result.contextMessageUuid).toBe('completed-assistant')
    expect(result.session.parentSessionId).toBe(parent.id)
    expect(result.session.rootSessionId).toBe(parent.id)
    expect(result.session.archived).toBe(true)
    expect(result.session.title).toBe('Agent 问答')
  })

  test('Given Pi 会话运行在项目 cwd When 创建会话 Then 初始化项目级 context 且不预建会话级 .context', () => {
    const projectRootPath = join(tempHome, 'context-project')
    mkdirSync(projectRootPath, { recursive: true })
    writeAgentWorkspacesIndex([{
      id: 'context-workspace',
      name: 'Context 项目',
      slug: 'context-workspace',
      projectRootPath,
      createdAt: 1,
      updatedAt: 1,
    }])

    const session = manager.createAgentSession(
      'Context 会话',
      undefined,
      'context-workspace',
      undefined,
      'pi',
      'project',
    )

    expect(existsSync(join(projectRootPath, 'copis', '.context'))).toBe(true)
    expect(existsSync(join(projectRootPath, 'project', '.context'))).toBe(false)
    expect(existsSync(join(tempHome, '.copis', 'agent-workspaces', 'context-workspace', session.id, '.context'))).toBe(false)
  })

  test('Given 历史索引包含非法附加路径 When 读取会话 Then 清理非法值后再返回', () => {
    const indexPath = join(tempHome, '.copis', 'agent-sessions.json')
    const indexBackup = existsSync(indexPath) ? readFileSync(indexPath, 'utf-8') : undefined
    const validFile = join(tempHome, 'attached-note.md')
    const validDirectory = join(tempHome, 'attached-directory')

    mkdirSync(join(tempHome, '.copis'), { recursive: true })
    writeFileSync(indexPath, JSON.stringify({
      version: 1,
      sessions: [{
        id: 'session-with-invalid-attached-paths',
        title: '脏路径会话',
        attachedFiles: [validFile, null, '', 42],
        attachedDirectories: [validDirectory, null, '  '],
        createdAt: 1,
        updatedAt: 1,
      }],
    }), 'utf-8')

    try {
      const session = manager.getAgentSessionMeta('session-with-invalid-attached-paths')

      expect(session?.attachedFiles).toEqual([validFile])
      expect(session?.attachedDirectories).toEqual([validDirectory])
      expect(JSON.parse(readFileSync(indexPath, 'utf-8')).sessions[0]).toMatchObject({
        attachedFiles: [validFile],
        attachedDirectories: [validDirectory],
      })
    } finally {
      if (indexBackup === undefined) {
        rmSync(indexPath, { force: true })
      } else {
        writeFileSync(indexPath, indexBackup, 'utf-8')
      }
    }
  })

  test('Given 已保存 OpenAI medium 默认值 When 新建 Pi 会话 Then 默认并持久化 medium', () => {
    const settingsPath = join(tempHome, '.copis', 'settings.json')
    mkdirSync(join(tempHome, '.copis'), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify({
      agentThinking: { type: 'adaptive' },
      agentEffort: 'max',
      defaultOpenAIThinkingLevel: 'medium',
    }), 'utf-8')

    try {
      const defaultRuntimeSession = manager.createAgentSession('默认内核会话')

      expect(defaultRuntimeSession.agentRuntime).toBe('pi')
      expect(manager.getAgentSessionMeta(defaultRuntimeSession.id)?.agentRuntime).toBe('pi')
      expect(defaultRuntimeSession.reasoningLevel).toBe('medium')
      expect(defaultRuntimeSession.workingMode).toBe('fast')
      expect(manager.getAgentSessionMeta(defaultRuntimeSession.id)?.reasoningLevel).toBe('medium')
    } finally {
      rmSync(settingsPath, { force: true })
    }
  })

  test('Given 新安装用户保存关闭思考 When 连续新建会话 Then 不被旧版迁移改回 high', () => {
    const settingsPath = join(tempHome, '.copis', 'settings.json')
    const indexPath = join(tempHome, '.copis', 'agent-sessions.json')
    const indexBackupPath = `${indexPath}.bak`
    mkdirSync(join(tempHome, '.copis'), { recursive: true })
    rmSync(indexPath, { force: true })
    rmSync(indexBackupPath, { force: true })
    writeFileSync(settingsPath, JSON.stringify({
      agentThinking: { type: 'adaptive' },
      agentEffort: 'medium',
      defaultOpenAIThinkingLevel: 'off',
    }), 'utf-8')

    try {
      const firstSession = manager.createAgentSession('关闭思考会话一')
      const secondSession = manager.createAgentSession('关闭思考会话二')

      expect(manager.getAgentSessionMeta(firstSession.id)?.reasoningLevel).toBe('off')
      expect(manager.getAgentSessionMeta(secondSession.id)?.reasoningLevel).toBe('off')
    } finally {
      rmSync(settingsPath, { force: true })
      rmSync(indexPath, { force: true })
      rmSync(indexBackupPath, { force: true })
    }
  })

  test('Given session settings When updating Then persists reasoning depth per session', () => {
    const session = manager.createAgentSession('Codex 会话', undefined, undefined, undefined, 'pi')

    const updated = manager.updateAgentSessionMeta(session.id, { reasoningLevel: 'xhigh' })

    expect(updated.reasoningLevel).toBe('xhigh')
    expect(manager.getAgentSessionMeta(session.id)).toMatchObject({ reasoningLevel: 'xhigh' })
  })

  test('Given session settings When updating Working mode Then persists expert mode per session', () => {
    const session = manager.createAgentSession('Working 会话', undefined, undefined, undefined, 'pi')

    const updated = manager.updateAgentSessionMeta(session.id, { workingMode: 'expert' })

    expect(updated.workingMode).toBe('expert')
    expect(manager.getAgentSessionMeta(session.id)).toMatchObject({ workingMode: 'expert' })
  })

  test('Given 专家团队工作台 When 创建主控会话 Then 持久化运行与 Schema 标识', () => {
    const session = manager.createAgentSession(
      '专家团队 · 深入研究团队',
      'channel-1',
      undefined,
      'model-1',
      'pi',
      undefined,
      { runId: 'run-1', schemaId: 'team-a', schemaRevisionId: 7 },
    )

    expect(session.expertTeamSession).toEqual({ runId: 'run-1', schemaId: 'team-a', schemaRevisionId: 7 })
    expect(manager.getAgentSessionMeta(session.id)?.expertTeamSession).toEqual(session.expertTeamSession)
  })

  test('Given 新专家团入口 When 创建筹备会话 Then 持久化 expertTeamSetup 标记', () => {
    const session = manager.createAgentSession(
      '专家团队 · 组建新团队',
      'channel-1',
      'workspace-1',
      'model-1',
      'pi',
      undefined,
      undefined,
      true,
    )

    expect(session.expertTeamSetup).toBe(true)
    expect(manager.getAgentSessionMeta(session.id)?.expertTeamSetup).toBe(true)
  })

  test('Given a session When star state is updated Then it persists without changing freshness or archive state', () => {
    const session = manager.createAgentSession('星标会话')
    const archived = manager.updateAgentSessionMeta(session.id, { archived: true })

    const updated = manager.updateAgentSessionMeta(session.id, { starred: true })

    expect(updated).toMatchObject({ starred: true, archived: true })
    expect(updated.updatedAt).toBe(archived.updatedAt)
    expect(manager.getAgentSessionMeta(session.id)).toMatchObject({ starred: true, archived: true })
  })
})

describe('Agent 会话引用搜索', () => {
  test('Given 工作区有超过 20 个会话 When 请求最近 200 条 Then 按更新时间返回 200 条', async () => {
    writeAgentSessionsIndex(createIndexedSessions(220))

    const results = await manager.searchAgentSessionReferences({
      workspaceId: 'workspace-a',
      limit: 200,
    })

    expect(results).toHaveLength(200)
    expect(results[0]?.sessionId).toBe('session-219')
    expect(results.at(-1)?.sessionId).toBe('session-20')
    expect(results.every((result) => result.matchSource === 'recent')).toBe(true)
  })

  test('Given 请求数量超过性能上限 When 搜索可引用会话 Then 最多返回 200 条', async () => {
    writeAgentSessionsIndex(createIndexedSessions(220))

    const results = await manager.searchAgentSessionReferences({
      workspaceId: 'workspace-a',
      limit: 500,
    })

    expect(results).toHaveLength(200)
  })

  test('Given 未指定工作区 When 搜索可引用会话 Then 返回全部工作区的最近会话并标示来源', async () => {
    writeAgentWorkspacesIndex([
      { id: 'workspace-a', name: '产品研发', slug: 'product-dev', createdAt: 1, updatedAt: 1 },
      { id: 'workspace-b', name: '客户支持', slug: 'customer-support', createdAt: 2, updatedAt: 2 },
      { id: 'workspace-c', name: '当前项目', slug: 'current-project', createdAt: 3, updatedAt: 3 },
    ])
    writeAgentSessionsIndex([
      { id: 'workspace-a-session', title: '同名会话', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 },
      { id: 'workspace-b-session', title: '同名会话', workspaceId: 'workspace-b', createdAt: 2, updatedAt: 2 },
      { id: 'current-session', title: '当前会话', workspaceId: 'workspace-c', createdAt: 3, updatedAt: 3 },
    ])

    const results = await manager.searchAgentSessionReferences({
      excludeSessionId: 'current-session',
      limit: 200,
    })

    expect(results).toMatchObject([
      { sessionId: 'workspace-b-session', workspaceName: '客户支持', workspaceSlug: 'customer-support' },
      { sessionId: 'workspace-a-session', workspaceName: '产品研发', workspaceSlug: 'product-dev' },
    ])
  })

  test('Given 消息内容命中 When 搜索可引用会话 Then 异步返回匹配片段和工作区来源', async () => {
    writeAgentWorkspacesIndex([
      { id: 'workspace-b', name: '客户支持', slug: 'customer-support', createdAt: 1, updatedAt: 1 },
    ])
    writeAgentSessionsIndex([
      { id: 'message-session', title: '项目讨论', workspaceId: 'workspace-b', createdAt: 1, updatedAt: 1 },
    ])
    writeAgentSessionJsonl('message-session', [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '需要核对跨工作区的会话引用。' }] } }),
    ])

    const results = await manager.searchAgentSessionReferences({ query: '跨工作区' })

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      sessionId: 'message-session',
      workspaceName: '客户支持',
      workspaceSlug: 'customer-support',
      matchSource: 'message',
      snippet: expect.stringContaining('跨工作区'),
    })
  })

  test('Given 正文扫描预算耗尽 When 较旧会话标题命中 Then 仍返回标题命中结果', async () => {
    const scannedSessions = Array.from({ length: 50 }, (_, index) => ({
      id: `body-scan-${index}`,
      title: `普通会话 ${index}`,
      workspaceId: 'workspace-a',
      createdAt: 100 - index,
      updatedAt: 100 - index,
    }))
    writeAgentSessionsIndex([
      ...scannedSessions,
      { id: 'older-title-match', title: '目标会话', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 },
    ])
    for (const session of scannedSessions) {
      writeAgentSessionJsonl(session.id, [
        JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '没有匹配内容' }] } }),
      ])
    }

    const results = await manager.searchAgentSessionReferences({ query: '目标' })

    expect(results).toMatchObject([{ sessionId: 'older-title-match', matchSource: 'title' }])
  })

  test('Given 正文命中在单文件扫描上限之后 When 搜索引用 Then 不读取超出输入补全预算的历史', async () => {
    writeAgentSessionsIndex([
      { id: 'oversized-session', title: '大历史', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 },
    ])
    writeAgentSessionJsonl('oversized-session', [
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: `${'x'.repeat(300 * 1024)}隐藏关键词` }] },
      }),
    ])

    const results = await manager.searchAgentSessionReferences({ query: '隐藏关键词' })

    expect(results).toEqual([])
  })
})

describe('Agent 连接器专属会话标记保持与自动迁移', () => {
  test('Given 历史会话仅包含连接器标题或绑定 When 读取会话索引 Then 自动补全并持久化 source 与 dedicated 属性', () => {
    writeAgentSessionsIndex([
      { id: 'legacy-feishu', title: '飞书专属会话', workspaceId: 'default', createdAt: 1, updatedAt: 1 },
      { id: 'legacy-wechat', title: '[微信] 专属会话', workspaceId: 'default', createdAt: 2, updatedAt: 2 },
      { id: 'legacy-dingtalk', title: '钉钉专属会话', workspaceId: 'default', createdAt: 3, updatedAt: 3 },
      { id: 'normal-session', title: '普通新会话', workspaceId: 'default', createdAt: 4, updatedAt: 4 },
    ])

    const sessions = manager.listAgentSessions()
    const feishu = sessions.find((s) => s.id === 'legacy-feishu')
    const wechat = sessions.find((s) => s.id === 'legacy-wechat')
    const dingtalk = sessions.find((s) => s.id === 'legacy-dingtalk')
    const normal = sessions.find((s) => s.id === 'normal-session')

    expect(feishu?.source).toBe('feishu')
    expect(feishu?.feishuDedicated).toBe(true)
    expect(wechat?.source).toBe('wechat')
    expect(wechat?.wechatDedicated).toBe(true)
    expect(dingtalk?.source).toBe('dingtalk')
    expect(dingtalk?.dingtalkDedicated).toBe(true)
    expect(normal?.feishuDedicated).toBeUndefined()
    expect(normal?.wechatDedicated).toBeUndefined()
    expect(normal?.dingtalkDedicated).toBeUndefined()
  })

  test('Given 连接器专属会话 When 更新标题为业务名称 Then 专属标记与 source 始终保持不被丢弃', () => {
    writeAgentSessionsIndex([
      { id: 'wechat-session-1', title: '微信专属会话', workspaceId: 'default', createdAt: 1, updatedAt: 1 },
    ])

    // 先读一次触发迁移补全
    manager.listAgentSessions()

    // 模拟对话后 autoGenerateTitle 或用户重命名标题
    const updated = manager.updateAgentSessionMeta('wechat-session-1', {
      title: '开发 Python 自动化脚本',
    })

    expect(updated.title).toBe('开发 Python 自动化脚本')
    expect(updated.source).toBe('wechat')
    expect(updated.wechatDedicated).toBe(true)

    // 重新从磁盘读取确认持久化保持
    const reloaded = manager.getAgentSessionMeta('wechat-session-1')
    expect(reloaded?.title).toBe('开发 Python 自动化脚本')
    expect(reloaded?.source).toBe('wechat')
    expect(reloaded?.wechatDedicated).toBe(true)
  })

  test('Given 新建会话 When 不指定 advancedAuthorization Then 默认开启高级授权 (true)', () => {
    const session = manager.createAgentSession('新默认会话')
    expect(session.advancedAuthorization).toBe(true)
    expect(manager.getAgentSessionMeta(session.id)?.advancedAuthorization).toBe(true)
  })

  test('Given 历史会话未包含 advancedAuthorization 字段 When 读取会话索引 Then 自动迁移为开启 (true)', () => {
    writeAgentSessionsIndex([
      { id: 'legacy-session-no-auth', title: '历史会话', workspaceId: 'default', createdAt: 1, updatedAt: 1 },
    ])

    const sessions = manager.listAgentSessions()
    const migrated = sessions.find((s) => s.id === 'legacy-session-no-auth')
    expect(migrated?.advancedAuthorization).toBe(true)
  })
})
