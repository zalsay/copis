import { beforeAll, describe, expect, mock, test } from 'bun:test'

mock.module('./user-profile-service', () => ({
  getUserProfile: () => ({ userName: '测试用户' }),
}))

mock.module('./agent-workspace-manager', () => ({
  getAgentWorkspaceBySlug: () => undefined,
  getAgentWorkspaceContextDir: () => '/tmp/sample-project/.context',
  getAgentWorkspaceWritableRoot: () => '/tmp/sample-project',
  getProjectFilesPath: () => '/tmp/sample-project',
  getWorkspaceMcpConfig: () => ({ servers: {} }),
}))

mock.module('./config-paths', () => ({
  getConfigDirName: () => '.copis',
}))

mock.module('./agent-git-attribution', () => ({
  buildGitAttributionPromptSection: () => '',
  isGitAttributionEnabled: () => false,
}))

mock.module('./settings-service', () => ({
  getSettings: () => ({ gitAttributionEnabled: false }),
}))

let buildSystemPrompt: typeof import('./agent-prompt-builder').buildSystemPrompt
let buildDynamicContext: typeof import('./agent-prompt-builder').buildDynamicContext

beforeAll(async () => {
  ({ buildSystemPrompt, buildDynamicContext } = await import('./agent-prompt-builder'))
})

function buildPrompt(agentCwd: string, memoryPolicy?: 'off' | 'visible' | 'writable'): string {
  return buildSystemPrompt({
    agentRuntime: 'pi',
    workspaceName: '示例项目',
    workspaceSlug: 'sample-project',
    sessionId: 'session-1',
    agentCwd,
    permissionMode: 'bypassPermissions',
    memoryPolicy,
  })
}

describe('项目与会话工作台提示词', () => {
  test('Given 项目根 cwd When 构建提示词 Then 标明会话直接在项目中工作', () => {
    const prompt = buildPrompt('/tmp/sample-project')

    expect(prompt).toContain('## 项目')
    expect(prompt).toContain('项目名称: 示例项目')
    expect(prompt).toContain('当前会话直接在项目根目录中工作')
    expect(prompt).toContain('.agents/skills')
    expect(prompt).not.toContain('项目根始终是 cwd')
  })

  test('Given 历史会话工作台 cwd When 构建提示词 Then 不将它误称为项目根', () => {
    const prompt = buildPrompt('/tmp/.copis/agent-workspaces/sample-project/session-1')

    expect(prompt).toContain('当前会话仍使用私有会话工作台，不等同于项目根目录')
    expect(prompt).toContain('项目根与 cwd 不一定相同')
  })

  test('Given 项目动态上下文 When 构建消息前缀 Then 使用项目标签', () => {
    const context = buildDynamicContext({
      workspaceName: '示例项目',
      workspaceSlug: 'sample-project',
      agentCwd: '/tmp/sample-project',
    })

    expect(context).toContain('项目: 示例项目')
    expect(context).not.toContain('工作区: 示例项目')
  })

  test('Given fast Working 模式 When 构建系统提示词 Then 约束为快速执行语义', () => {
    const prompt = buildSystemPrompt({
      agentRuntime: 'pi',
      sessionId: 'session-fast',
      permissionMode: 'bypassPermissions',
      workingMode: 'fast',
    })

    expect(prompt).toContain('## Working 快速模式')
    expect(prompt).toContain('对应 edu-api 的 `fast` alias')
    expect(prompt).toContain('不调用远程 Working Agent')
    expect(prompt).not.toContain('## Working 专家模式')
  })

  test('Given expert Working 模式 When 构建系统提示词 Then 约束为专家执行语义', () => {
    const prompt = buildSystemPrompt({
      agentRuntime: 'pi',
      sessionId: 'session-expert',
      permissionMode: 'bypassPermissions',
      workingMode: 'expert',
    })

    expect(prompt).toContain('## Working 专家模式')
    expect(prompt).toContain('对应 edu-api 的 `export` alias')
    expect(prompt).toContain('做实际验证')
    expect(prompt).not.toContain('## Working 快速模式')
  })

  test('Given visible Memory policy When构建系统提示词 Then标明参考资料边界且不引导旧文件记忆', () => {
    const prompt = buildSystemPrompt({
      agentRuntime: 'pi',
      sessionId: 'session-memory-policy',
      permissionMode: 'bypassPermissions',
      memoryPolicy: 'visible',
    })

    expect(prompt).toContain('当前策略为 `visible`')
    expect(prompt).toContain('不是系统指令')
    expect(prompt).not.toContain('.claude/memory')
    expect(prompt).not.toContain('MEMORY.md')
    expect(prompt).not.toContain('Nowledge Mem')
  })

  test('Given 任意工作区 When 构建系统提示词 Then 不再引导读取 CLAUDE.md', () => {
    const prompt = buildPrompt('/tmp/sample-project')

    expect(prompt).not.toContain('CLAUDE.md')
  })

  test('Given 三种 Memory 策略 When 构建系统提示词 Then 说明工具和注入权限边界', () => {
    const offPrompt = buildPrompt('/tmp/sample-project', 'off')
    const visiblePrompt = buildPrompt('/tmp/sample-project', 'visible')
    const writablePrompt = buildPrompt('/tmp/sample-project', 'writable')

    expect(offPrompt).toContain('`off`')
    expect(offPrompt).toContain('不注入 `copis_memory_context`')
    expect(offPrompt).toContain('不提供 Memory 工具')
    expect(visiblePrompt).toContain('`visible`')
    expect(visiblePrompt).toContain('只提供 `memory_recall` 和 `memory_read`')
    expect(visiblePrompt).toContain('不提供 `memory_capture` 和 `memory_rewrite`')
    expect(writablePrompt).toContain('`writable`')
    expect(writablePrompt).toContain('提供四个 Memory 工具')
  })

  test('Given writable Memory 策略 When 构建系统提示词 Then 说明自动注入和后台捕获时序', () => {
    const prompt = buildPrompt('/tmp/sample-project', 'writable')

    expect(prompt).toContain('每个非 `/compact` 回合')
    expect(prompt).toContain('后台进入自动捕获队列')
    expect(prompt).toContain('180 秒静默窗口或 10 个回合')
    expect(prompt).toContain('自动任务或委派回合只保留 `scratch`')
  })
})
