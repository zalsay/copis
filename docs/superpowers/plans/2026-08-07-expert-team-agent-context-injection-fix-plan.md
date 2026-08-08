# 专家团队 Agent 上下文注入修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让绑定专家团队的主 Agent 和 Pi 子 Agent 都获得同一份受 Rust 冻结 revision 约束的专家团 `AGENTS.md` 与子代理 schema，同时保持主 Agent 负责决策、子 Agent 只执行节点的调用边界。

**Architecture:** 以 Rust API 返回的 workspace binding 和不可变 schema revision 为唯一来源，Electron 主进程生成工作区级受管控 `AGENTS.md` 区块及结构化上下文。Copis 将该上下文显式传入 `buildSystemPrompt` 和专家节点 `AgentSendInput`，不重新启用 Pi 自动发现 `AGENTS.md`，避免仓库根目录指令文件绕过 Copis 权限与工作区边界。

**Tech Stack:** Electron 主进程、Pi Agent SDK、TypeScript、Jotai 现有会话模型、Rust 本地 HTTP API、SQLite 专家团队 revision 存储、Bun test。

---

## 当前事实与根因

- `apps/electron/src/main/lib/adapters/pi-resource-loader-overrides.ts` 固定返回 `{ noContextFiles: true }`，`pi-resource-loader.test.ts` 已明确验证 Pi 不自动加载 cwd 或父目录的 `AGENTS.md`；这条全局安全边界必须保留。
- `apps/electron/src/main/lib/agent-prompt-builder.ts:205-210` 当前只注入“何时调用 `expert_team_run`”的通用文字，没有注入当前 workspace 的专家团定义或 schema revision。
- 主 Agent 的两条提示词构建路径分别位于 `agent-orchestrator.ts:1545` 和 `agent-rpc-service.ts:491`，都没有向 `buildSystemPrompt` 传入专家团上下文。
- `expert-team-agent-tool.ts` 会从 Rust 读取 schema revision，但构建的 `ExpertTeamRunSnapshot` 目前只保留节点任务；`expert-team-runner.ts:161-172` 生成的节点 prompt 只有角色、任务、依赖和产物路径，没有 `AGENTS.md` 或完整 schema。
- `ai-education` 的参考方案是 workspace 隔离的受管控 `AGENTS.md` 动态区块 + `.pi/schemas/subagent-task.schema.json`，并在 Planner/任务开始前写入当前专家团快照；Copis 需要把这一思想适配到本地工作区和显式 prompt 注入。

## 目标行为与不变量

1. 当前 Schema 有 workspace binding 时，主 Agent system prompt 包含该 binding 指向的 `schemaId`、revision、sha256、节点 DAG、产物约束和受管控 `AGENTS.md` 内容。
2. binding 不存在、Rust API 不可用、revision 不一致或 schema 损坏时，主 Agent 保留通用专家团队说明，但不注入陈旧或未校验的 schema；请求专家团工具时返回可诊断错误。
3. `expert_team_run` 未指定 `schemaId` 时优先使用当前 workspace binding 的 schema；显式指定 schema 仍按 Rust API 校验并读取冻结 revision。
4. 每个专家节点的 Pi 子会话收到同一份冻结 schema 元数据、受管控 `AGENTS.md` 协议和自己的节点上下文；子会话 `triggeredBy` 仍为 `delegation`，不可见 `expert_team_run` 和 collaboration 工具，不得再次委派。
5. `AGENTS.md` 只在 `~/.copis/agent-workspaces/<workspaceSlug>/AGENTS.md` 维护由 Copis 标记包围的专家团队区块；保留文件中用户其他内容，不写入用户本地项目根目录，也不把 token、绝对产物路径或完整对话写入该文件。
6. 运行时每次新回合都以 Rust 当前 binding/revision 重新解析并注入，resume 不依赖旧 Pi session 是否曾经加载过旧上下文；schema revision 不能被运行中的节点修改。

## 文件地图

- Create: `apps/electron/src/main/lib/expert-team-context.ts`，负责读取 binding/schema、规范化冻结上下文、生成/更新受管控 `AGENTS.md` 区块和长度/哈希校验。
- Create: `apps/electron/src/main/lib/expert-team-context.test.ts`，覆盖文件区块替换、保留用户内容、schema hash、缺失/陈旧 binding 和长度上限。
- Modify: `packages/shared/src/types/expert-team.ts`，增加跨 IPC/主进程/子 Agent 传递的 `ExpertTeamPromptContext`、`ExpertTeamPromptNode` 类型。
- Modify: `packages/shared/src/types/agent.ts`，给 `AgentSendInput` 增加可选的 `expertTeamContext`，只允许主进程生成的已校验快照进入运行链路。
- Modify: `apps/electron/src/main/lib/agent-prompt-builder.ts`，增加专家团上下文参数和受信边界明确的 prompt section。
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`、`apps/electron/src/main/lib/agent-rpc-service.ts`，在构建主/子 Agent system prompt 前解析并传递上下文；保留两条入口语义一致。
- Modify: `apps/electron/src/main/lib/expert-team-agent-tool.ts`，把 Rust 返回的 schema revision 转成冻结 prompt context，并让省略 `schemaId` 时使用当前 binding。
- Modify: `apps/electron/src/main/lib/expert-team-runner.ts`，把冻结 context 放入节点 `AgentSendInput`，并在节点 prompt 中声明节点角色、依赖和禁止再次委派规则。
- Modify/Test: `apps/electron/src/main/lib/agent-prompt-builder.test.ts`、`agent-rpc-service.test.ts`、`expert-team-runner.test.ts`、`adapters/pi-resource-loader.test.ts`；必要时新增 `expert-team-agent-tool.test.ts`。
- Review only: `apps/electron/src/main/lib/adapters/pi-resource-loader-overrides.ts`，确认不恢复自动 `AGENTS.md` 发现。

## 实施任务

### Task 1: 建立专家团队上下文契约与受管控文件渲染器

**Files:**
- Create: `apps/electron/src/main/lib/expert-team-context.ts`
- Create: `apps/electron/src/main/lib/expert-team-context.test.ts`
- Modify: `packages/shared/src/types/expert-team.ts`

- [x] **Step 1: 写失败测试**

测试使用临时 workspace 根目录和两个 schema revision，验证 `renderExpertTeamAgentsBlock()` 生成固定标记、包含 `schemaId/revision/sha256` 与 `researcher → summary → reviewer` 节点，并且第二次渲染只替换 Copis 区块、保留用户手写内容。

```ts
const first = renderExpertTeamAgentsFile('# 用户自定义规则\n', context('research-v1'))
const second = renderExpertTeamAgentsFile(first, context('research-v2'))
expect(second).toContain('# 用户自定义规则')
expect(second).toContain('schema-research-v2')
expect(second).not.toContain('schema-research-v1')
```

- [x] **Step 2: 运行红测试**

运行：`bun test apps/electron/src/main/lib/expert-team-context.test.ts`

预期：失败原因是上下文类型、受管控标记或渲染函数尚未存在，而不是测试导入错误。

- [x] **Step 3: 实现最小上下文模型**

增加以下语义字段：`schemaId`、`schemaRevisionId`、`revision`、`sha256`、`schemaName`、`schemaDescription`、规范化节点数组、`agentsMdPath`、`agentsMdContent` 和可选 `nodeId`。只接受 Rust 返回的冻结 snapshot；对名称、目标、路径和文件内容执行长度限制，使用固定 `<!-- copis-expert-team:start -->` / `<!-- copis-expert-team:end -->` 标记替换区块。

```ts
export interface ExpertTeamPromptContext {
  schemaId: string
  schemaRevisionId?: number
  revision?: number
  sha256: string
  schemaName: string
  schemaDescription?: string
  nodes: ExpertTeamPromptNode[]
  agentsMdPath: string
  agentsMdContent: string
  nodeId?: string
}
```

- [x] **Step 4: 运行绿测试**

运行：`bun test apps/electron/src/main/lib/expert-team-context.test.ts`

预期：区块替换、用户内容保留、哈希和缺失上下文测试全部通过。

### Task 2: 从 Rust binding 解析当前 schema 并生成 workspace `AGENTS.md`

**Files:**
- Modify: `apps/electron/src/main/lib/expert-team-context.ts`
- Modify: `apps/electron/src/main/lib/expert-team-rust-client.ts` 或新增同目录只读 context client
- Modify: `apps/electron/src/main/lib/agent-workspace-manager.ts`（仅增加受控 `AGENTS.md` 路径 helper）
- Test: `apps/electron/src/main/lib/expert-team-context.test.ts`

- [x] **Step 1: 写失败测试**

用 fake fetch 返回 `/api/expert-teams/workspaces/:slug/binding` 和 `/api/expert-teams/schemas/:id`，断言 resolver 只接受 binding 对应的 revision snapshot，并将文件写入 `getAgentWorkspacePath(slug)/AGENTS.md`；binding 的 `schemaId`、revision 或 sha256 不匹配时返回 `undefined`/结构化诊断，不继续使用旧文件。

- [x] **Step 2: 运行红测试**

运行：`bun test apps/electron/src/main/lib/expert-team-context.test.ts`

预期：当前没有只读 binding/schema resolver 或 revision 一致性校验，测试失败。

- [x] **Step 3: 实现解析与落盘**

新增 `resolveExpertTeamPromptContext({ workspace, schemaId? })`：先读 workspace binding，再读 schema 详情和绑定的不可变 revision；规范化 JSON 后计算/核对 sha256；成功后更新 workspace 根目录 `AGENTS.md` 的 Copis 区块，并返回内存上下文。Rust 不可用时只记录中文 warning 并返回无上下文结果，不阻断普通主 Agent 对话。

```ts
const binding = await reader.getBinding(workspace.slug)
if (!binding || (schemaId && binding.schemaId !== schemaId)) return undefined
const schema = await reader.getSchema(binding.schemaId)
const revision = findRevision(schema, binding.schemaRevisionId, binding.revision)
if (!revision || hashSnapshot(revision.snapshot) !== binding.sha256) return undefined
return persistManagedExpertTeamAgents(workspace, buildPromptContext(schema, revision))
```

- [x] **Step 4: 运行绿测试**

运行：`bun test apps/electron/src/main/lib/expert-team-context.test.ts`

预期：成功 binding 注入当前 revision，陈旧/损坏/不可用场景全部 fail-soft，且不修改项目根目录。

### Task 3: 把上下文显式注入主 Agent prompt

**Files:**
- Modify: `apps/electron/src/main/lib/agent-prompt-builder.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Modify: `apps/electron/src/main/lib/agent-rpc-service.ts`
- Test: `apps/electron/src/main/lib/agent-prompt-builder.test.ts`
- Test: `apps/electron/src/main/lib/agent-rpc-service.test.ts`

- [x] **Step 1: 写失败测试**

增加两个行为断言：带 `expertTeamContext` 的 system prompt 包含受管控 `AGENTS.md` 区块、revision/hash 和完整节点 DAG；没有 context 时只包含通用 `expert_team_run` 说明，不出现陈旧 schema。`prepareAgentRpcRun()` 和 orchestrator 的首次运行、resume 运行都要传入同一上下文。

```ts
const prompt = buildSystemPrompt({ ...base, expertTeamContext: context })
expect(prompt).toContain('<copis_expert_team_agents_md>')
expect(prompt).toContain('schema-research-v2')
expect(prompt).toContain('researcher -> summary -> reviewer')
```

- [x] **Step 2: 运行红测试**

运行：`bun test apps/electron/src/main/lib/agent-prompt-builder.test.ts apps/electron/src/main/lib/agent-rpc-service.test.ts`

预期：当前 `SystemPromptContext` 不接受 context，或主/子路径的 prompt 缺少 schema 内容。

- [x] **Step 3: 实现统一注入**

在 `buildSystemPrompt` 增加独立 section：将 `AGENTS.md` 作为“当前专家团队受管控协议”引用，明确其不能改变 Copis system、权限、workspace root 和子 Agent 规则；schema 使用规范化 JSON/表格展示。两条入口在构建 system prompt 前调用 Task 2 resolver，并在 `expertTeamAvailable && triggeredBy === 'user'` 时传 context；`delegation` 只传节点 context，不暴露主 Agent 工具。

```ts
if (ctx.expertTeamContext) {
  sections.push(`<copis_expert_team_agents_md>\n${ctx.expertTeamContext.agentsMdContent}\n</copis_expert_team_agents_md>`)
  sections.push(`<copis_expert_team_schema>\n${JSON.stringify(ctx.expertTeamContext.nodes)}\n</copis_expert_team_schema>`)
}
```

- [x] **Step 4: 运行绿测试**

运行：`bun test apps/electron/src/main/lib/agent-prompt-builder.test.ts apps/electron/src/main/lib/agent-rpc-service.test.ts`

预期：主 Agent 首次/恢复运行都能看到当前绑定专家团，普通无绑定工作区不受影响。

### Task 4: 将冻结 schema 与 Agents 协议传入 Pi 子 Agent

**Files:**
- Modify: `apps/electron/src/main/lib/expert-team-agent-tool.ts`
- Modify: `apps/electron/src/main/lib/expert-team-runner.ts`
- Modify: `packages/shared/src/types/agent.ts`
- Modify: `packages/shared/src/types/expert-team.ts`
- Test: `apps/electron/src/main/lib/expert-team-runner.test.ts`
- Create: `apps/electron/src/main/lib/expert-team-agent-tool.test.ts`

- [x] **Step 1: 写失败测试**

扩展 fake Agent executor，断言每个节点的 `AgentSendInput` 携带 `triggeredBy: 'delegation'`、schema revision/hash、Agents 区块、当前 `nodeId/role` 和依赖；断言同一 run 使用创建时 snapshot，即使 Rust 当前 schema 随后升级也不变。

- [x] **Step 2: 运行红测试**

运行：`bun test apps/electron/src/main/lib/expert-team-runner.test.ts apps/electron/src/main/lib/expert-team-agent-tool.test.ts`

预期：当前 snapshot/input 类型没有 context，节点 prompt 只包含任务文本。

- [x] **Step 3: 实现冻结传递**

`runExpertTeam()` 将 Rust 返回的 revision snapshot 转换成 `ExpertTeamPromptContext`，写入 `ExpertTeamRunSnapshot`；`ExpertTeamRunner` 为每个节点构建 `<copis_expert_team_agents_md>`、`<copis_expert_team_schema>` 和 `<copis_expert_team_node>` 块，并通过 `AgentSendInput.expertTeamContext` 交给 system prompt builder。节点只能读取自己的依赖产物，不得修改 schema、调用 `expert_team_run` 或继续委派。

```ts
const input: AgentSendInput = {
  ...baseInput,
  triggeredBy: 'delegation',
  expertTeamContext: { ...snapshot.expertTeamContext, nodeId: node.id },
  userMessage: buildNodePrompt(snapshot, node),
}
```

- [x] **Step 4: 运行绿测试**

运行：`bun test apps/electron/src/main/lib/expert-team-runner.test.ts apps/electron/src/main/lib/expert-team-agent-tool.test.ts`

预期：节点收到完整冻结上下文，递归工具和 collaboration 工具仍不可见，已有 DAG 调度/产物验收测试保持通过。

### Task 5: 保持 Pi loader 安全边界并补齐回归契约

**Files:**
- Modify/Test: `apps/electron/src/main/lib/adapters/pi-resource-loader.test.ts`
- Modify/Test: `apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts`
- Test: `apps/electron/src/main/lib/agent-rpc-protocol.test.ts`

- [x] **Step 1: 写失败测试**

增加契约：workspace/project 根目录存在任意 `AGENTS.md` 时，Pi loader 仍返回空 `agentsFiles`；只有 Copis 显式传入的专家上下文出现在 system prompt。`delegation`/`automation` input 不包含主 Agent expert team tool。

- [x] **Step 2: 运行测试确认边界**

运行：`bun test apps/electron/src/main/lib/adapters/pi-resource-loader.test.ts apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts apps/electron/src/main/lib/agent-rpc-protocol.test.ts`

预期：既有 noContextFiles 与工具可见性测试通过；新增测试在实现前失败，完成后通过。

- [x] **Step 3: 实现协议透传与安全校验**

为 RPC parser/query config 透传 `expertTeamContext`，禁止从 renderer 直接提交；只接受主进程 resolver 或 runner 生成、带 revision/hash 的对象。限制 prompt 字符数，日志只记录 schema ID/revision，不记录 Agents 全文、用户输入、token 或绝对路径。

```ts
// parseAgentRpcInput 只解析 renderer 允许的字段；外部 record.expertTeamContext 必须忽略。
const internalContext = input.triggeredBy === 'delegation'
  ? validateInternalExpertTeamContext(input.expertTeamContext)
  : undefined
```

- [x] **Step 4: 运行绿测试**

运行：`bun test apps/electron/src/main/lib/adapters/pi-resource-loader.test.ts apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts apps/electron/src/main/lib/agent-rpc-protocol.test.ts`

预期：全局默认文件发现仍关闭，显式专家上下文可用，非 user 子会话不能递归调度。

### Task 6: 集成验证与人工验收

**Files:**
- Review: `docs/superpowers/plans/2026-08-07-expert-team-rust-api-pi-only-plan.md`
- Review: `apps/electron/src/main/lib/adapters/pi-resource-loader-overrides.ts`
- No change: `README.md`、根 `AGENTS.md`（除非用户另行批准）

- [x] **Step 1: 运行 focused tests**

```bash
bun test apps/electron/src/main/lib/expert-team-context.test.ts
bun test apps/electron/src/main/lib/agent-prompt-builder.test.ts
bun test apps/electron/src/main/lib/agent-rpc-service.test.ts
bun test apps/electron/src/main/lib/expert-team-runner.test.ts apps/electron/src/main/lib/expert-team-agent-tool.test.ts
bun test apps/electron/src/main/lib/adapters/pi-resource-loader.test.ts apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts apps/electron/src/main/lib/agent-rpc-protocol.test.ts
```

预期：所有测试通过，且测试日志不打印 Agents 内容、完整 schema、用户输入、API key 或内部 token。

- [x] **Step 2: 运行类型检查和构建**

```bash
bun run typecheck
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:renderer
git diff --check
```

预期：命令退出码为 0；Browserslist、sonner 动态导入和 chunk size 等已有 warning 单独记录，不作为本修复失败。

- [ ] **Step 3: 验证真实数据流**

在本地 Rust API 中绑定 `ai-education-research-writer-reviewer` 的 revision 2，检查 workspace `AGENTS.md` managed block 与 schema hash；从已绑定工作区进入主 Agent，确认 system prompt/调度日志只使用该 revision；调用专家团队后检查 researcher、summary、reviewer 三个子会话均携带相同 revision，且只暴露对应节点上下文。

- [ ] **Step 4: Electron 窗口人工确认**

由用户在实际 Electron 窗口完成一次：绑定工作区 → 点击“开始”进入主 Agent → 提交需要深入研究的请求 → 确认主 Agent 决定是否调用专家团、节点结果回传主 Agent、主 Agent 最终汇总回复。自动化测试不替代该视觉与交互确认。

## 风险与回滚

- Rust API 不可用时只回退到通用主 Agent prompt，不阻断普通对话；专家团队工具在无法取得可信 schema 时拒绝执行并返回明确错误。
- 不重新启用 Pi `AGENTS.md` 自动发现，避免仓库根目录的 `AGENTS.md` 或用户附加目录注入系统级指令。
- 绑定切换只替换 Copis managed block，保留用户自定义 `AGENTS.md` 内容；运行中的子 Agent 使用创建时冻结 revision，不受后续 schema 更新影响。
- 回滚时移除 `expertTeamContext` 注入和 managed block 写入逻辑即可，已有 schema/run SQLite 数据不删除、不迁移。

## 执行交接

计划完成并保存。实现阶段应按任务逐项执行，每个代码任务先写失败测试、确认红，再做最小实现并回归；当前不提交代码，也不修改 `README.md` 或根 `AGENTS.md`。
