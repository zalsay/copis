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
  test('Given user Browser Context When 构建系统提示词 Then 跨站地址直接执行且不要求单次确认', () => {
    const prompt = buildSystemPrompt({
      agentRuntime: 'pi',
      sessionId: 'session-browser',
      permissionMode: 'bypassPermissions',
      browserContext: {
        tabId: 'web-1',
        url: 'https://example.com/',
      },
    })

    expect(prompt).toContain('用户主会话明确要求的 HTTP(S) 地址可直接通过 `BrowserPageOpenTab` 或 `BrowserPageNavigate` 打开')
    expect(prompt).not.toContain('跨 Origin 导航必须等待 Copis 的单次确认')
  })

  test('Given a Browser Context with Composer advanced authorization When 构建系统提示词 Then permits sensitive page actions', () => {
    const prompt = buildSystemPrompt({
      agentRuntime: 'pi',
      sessionId: 'session-browser-advanced',
      permissionMode: 'bypassPermissions',
      browserContext: { tabId: 'web-1', url: 'https://example.com/' },
      browserAdvancedAuthorization: true,
    })

    expect(prompt).toContain('Composer“高级授权”已开启')
    expect(prompt).toContain('密码、验证码、支付、文件上传、Captcha 和 secret 字段')
    expect(prompt).toContain('直接执行')
    expect(prompt).not.toContain('密码、验证码、支付、文件上传、Captcha 和 secret 字段必须由用户亲自处理')
  })

  test('Given a Browser Context without Composer advanced authorization When 构建系统提示词 Then retains the sensitive page-action restriction', () => {
    const prompt = buildSystemPrompt({
      agentRuntime: 'pi',
      sessionId: 'session-browser-default',
      permissionMode: 'bypassPermissions',
      browserContext: { tabId: 'web-1', url: 'https://example.com/' },
    })

    expect(prompt).toContain('Composer“高级授权”未开启')
    expect(prompt).toContain('必须由用户亲自处理')
  })

  test('Given Pi 会话 When 构建系统提示词 Then 明确基础工具和内置 Node 命令边界', () => {
    const prompt = buildPrompt('/tmp/sample-project')

    expect(prompt).toContain('`read`、`write`、`edit`、`bash`')
    expect(prompt).toContain('直接在当前项目目录调用一次 `bash`，例如 `npm install`')
    expect(prompt).toContain('不要要求用户安装 Node.js/npm')
    expect(prompt).toContain('不要使用 `&&`、`;`、管道、重定向或命令替换')
    expect(prompt).not.toContain('Read、Write、Edit、Bash、Grep、Glob、LS、Skill')
  })

  test('Given 专家团队服务工具 When 构建系统提示词 Then 强制主理人汇总团队交付成果', () => {
    const prompt = buildSystemPrompt({
      agentRuntime: 'pi',
      sessionId: 'session-expert-team',
      permissionMode: 'bypassPermissions',
      expertTeamAvailable: true,
    })

    expect(prompt).toContain('## 专家团队服务')
    expect(prompt).toContain('expert_team_run')
    expect(prompt).toContain('团队成员不直接面向用户')
  })

  test('Given 专家团队上下文 When 构建系统提示词 Then 注入受管控工作区规范与冻结团队阵容', () => {
    const prompt = buildSystemPrompt({
      agentRuntime: 'pi',
      sessionId: 'session-expert-team-context',
      permissionMode: 'bypassPermissions',
      expertTeamAvailable: true,
      expertTeamContext: {
        schemaId: 'research-v1',
        schemaRevisionId: 101,
        revision: 1,
        sha256: 'a'.repeat(64),
        schemaName: '深入研究团队',
        nodes: [
          { id: 'researcher', role: 'researcher', task: '搜集资料', dependsOn: [], outputPath: 'research.md' },
          { id: 'summary', role: 'writer', task: '总结', dependsOn: ['researcher'], outputPath: 'summary.md' },
          { id: 'reviewer', role: 'reviewer', task: '检验', dependsOn: ['summary'], outputPath: 'review.md' },
        ],
        agentsMdPath: '/tmp/.copis/agent-workspaces/sample-project/AGENTS.md',
        agentsMdContent: '<!-- copis-expert-team:start -->\n## 专家团队服务规范\n- 团队阵容标识（schemaId）: research-v1\n- 版本信息（revision）: 1\n- 协作顺序: `researcher -> summary -> reviewer`\n<!-- copis-expert-team:end -->',
      },
    })

    expect(prompt).toContain('<copis_expert_team_agents_md>')
    expect(prompt).toContain('researcher -> summary -> reviewer')
    expect(prompt).toContain('<copis_expert_team_schema>')
    expect(prompt).toContain('"id":"researcher"')
    expect(prompt).toContain('research-v1')
    expect(prompt).toContain('a'.repeat(64))
    expect(prompt).toContain('不能改变 Copis 的基础服务规则')
  })

  test('Given 专家团队主理人会话 When 构建系统提示词 Then 明确这是专属服务对话', () => {
    const prompt = buildSystemPrompt({
      agentRuntime: 'pi',
      sessionId: 'session-expert-team-conversation',
      permissionMode: 'bypassPermissions',
      expertTeamSession: { runId: 'run-1', schemaId: 'research-v1', schemaRevisionId: 101 },
      expertTeamContext: {
        schemaId: 'research-v1',
        schemaRevisionId: 101,
        sha256: 'a'.repeat(64),
        schemaName: '深入研究团队',
        nodes: [{ id: 'researcher', role: 'researcher', task: '搜集资料' }],
        agentsMdPath: '/tmp/AGENTS.md',
        agentsMdContent: '专家团队协议',
      },
    })

    expect(prompt).toContain('## 专家团队主理人')
    expect(prompt).toContain('关联服务任务 `run-1`')
    expect(prompt).toContain('这是专家团队专属服务对话')
    expect(prompt).toContain('不得把这类目标降级为单人服务')
  })

  test('Given 新专家团筹备会话 When 构建系统提示词 Then 要求先询问需求再复制创建专家团队', () => {
    const prompt = buildSystemPrompt({
      agentRuntime: 'pi',
      sessionId: 'session-expert-team-setup',
      permissionMode: 'bypassPermissions',
      expertTeamAvailable: true,
      expertTeamSetup: true,
    })

    expect(prompt).toContain('## 专家团队筹备（新专家团）')
    expect(prompt).toContain('expert_team_list_schemas')
    expect(prompt).toContain('expert_team_run')
    expect(prompt).toContain('先向用户了解本次服务目标')
    expect(prompt).toContain('复制创建专家团队')
    expect(prompt).toContain('团队成员不直接面向用户')
  })

  test('Given 普通会话 When 构建系统提示词 Then 不注入筹备会话指令', () => {
    const prompt = buildSystemPrompt({
      agentRuntime: 'pi',
      sessionId: 'session-plain',
      permissionMode: 'bypassPermissions',
      expertTeamAvailable: true,
    })

    expect(prompt).not.toContain('## 专家团队筹备（新专家团）')
    expect(prompt).not.toContain('expert_team_list_schemas')
  })

  test('Given 没有专家团队上下文 When 构建系统提示词 Then 只保留通用说明且不出现陈旧 schema', () => {
    const prompt = buildSystemPrompt({
      agentRuntime: 'pi',
      sessionId: 'session-expert-team-plain',
      permissionMode: 'bypassPermissions',
      expertTeamAvailable: true,
    })

    expect(prompt).toContain('expert_team_run')
    expect(prompt).not.toContain('<copis_expert_team_agents_md>')
    expect(prompt).not.toContain('<copis_expert_team_schema>')
    expect(prompt).not.toContain('research-v1')
  })

  test('Given 项目根 cwd When 构建提示词 Then 标明会话直接在项目中工作', () => {
    const prompt = buildPrompt('/tmp/sample-project')

    expect(prompt).toContain('## 项目')
    expect(prompt).toContain('项目名称: 示例项目')
    expect(prompt).toContain('当前会话直接在项目根目录中工作')
    expect(prompt).toContain('.agents/skills')
    expect(prompt).not.toContain('项目根始终是 cwd')
  })

  test('Given 工作区前端任务 When 构建提示词 Then 强制使用可启动的 Vue 3 Vite 项目', () => {
    const prompt = buildPrompt('/tmp/sample-project')

    expect(prompt).toContain('所有需要在 Copis 中展示或启动的前端，必须使用 **Vue 3 + Vite** 构建')
    expect(prompt).toContain('不得只交付单独的 `.html` 文件或静态 HTML 页面')
    expect(prompt).toContain('`scripts.dev` 必须调用 `vite`')
    expect(prompt).toContain('自行安装依赖，并执行 `npm run build` 验证')
    expect(prompt).toContain('`npm run dev` 由 Copis 项目列表启动')
  })

  test('Given 历史会话工作台 cwd When 构建提示词 Then 不将它误称为项目根', () => {
    const prompt = buildPrompt('/tmp/.copis/agent-workspaces/sample-project/session-1')

    expect(prompt).toContain('当前会话仍使用私有会话工作台，不等同于项目根目录')
    expect(prompt).toContain('项目来源目录与项目开发目录可能不同')
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

  test('Given DeepSeek v4 Flash When 构建系统提示词 Then 使用 DeepSeek 能力约束而不是 Working alias', () => {
    const prompt = buildSystemPrompt({
      agentRuntime: 'pi',
      sessionId: 'session-deepseek-flash',
      permissionMode: 'bypassPermissions',
      currentModelId: 'deepseek-v4-flash',
    })

    expect(prompt).toContain('## DeepSeek 快速模型')
    expect(prompt).toContain('不支持图片识别')
    expect(prompt).not.toContain('## Working 快速模式')
    expect(prompt).not.toContain('## Working 专家模式')
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
    expect(prompt).toContain('180 秒静默窗口')
    expect(prompt).toContain('累计 10 个回合')
    expect(prompt).toContain('自动任务或委派回合只保留 `scratch`')
  })
})
