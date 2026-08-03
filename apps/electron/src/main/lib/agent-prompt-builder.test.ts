import { beforeAll, describe, expect, mock, test } from 'bun:test'

mock.module('./user-profile-service', () => ({
  getUserProfile: () => ({ userName: '测试用户' }),
}))

mock.module('./agent-workspace-manager', () => ({
  getAgentWorkspaceBySlug: () => undefined,
  getAgentWorkspaceWritableRoot: () => '/tmp/sample-project',
  getProjectFilesPath: () => '/tmp/sample-project',
  getWorkspaceMcpConfig: () => ({ servers: {} }),
}))

mock.module('./config-paths', () => ({
  getConfigDirName: () => '.proma',
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

function buildPrompt(agentCwd: string): string {
  return buildSystemPrompt({
    agentRuntime: 'pi',
    workspaceName: '示例项目',
    workspaceSlug: 'sample-project',
    sessionId: 'session-1',
    agentCwd,
    permissionMode: 'bypassPermissions',
  })
}

describe('项目与会话工作台提示词', () => {
  test('Given 项目根 cwd When 构建提示词 Then 标明会话直接在项目中工作', () => {
    const prompt = buildPrompt('/tmp/sample-project')

    expect(prompt).toContain('## 项目')
    expect(prompt).toContain('项目名称: 示例项目')
    expect(prompt).toContain('当前会话直接在项目根目录中工作')
    expect(prompt).not.toContain('项目根始终是 cwd')
  })

  test('Given 历史会话工作台 cwd When 构建提示词 Then 不将它误称为项目根', () => {
    const prompt = buildPrompt('/tmp/.proma/agent-workspaces/sample-project/session-1')

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
})
