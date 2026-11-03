import { afterEach, expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const runtimeRoot = process.env.COPIS_DSH_TEST_RUNTIME_ROOT
const runtimeTest = test.skipIf(!runtimeRoot)
const contexts: any[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

/** 仅在独立内存会话中加载指定官方模块，不接触用户的 Goal、Profile 或磁盘会话。 */
async function harness(source: Record<string, unknown> = { kind: 'user' }) {
  const require = createRequire(join(runtimeRoot!, 'package.json'))
  const { Context } = require('@deepseek-ai/cordis')
  const ctx = new Context()
  contexts.push(ctx)
  for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-agent', 'dsh-tools', 'dsh-goal']) {
    await ctx.plugin(require(`@deepseek-ai/${name}`).default)
  }
  // 旧版公开投影由 AgentLoop 注册；新版改由 AgentRegistry 自己持有。
  if (typeof ctx.agents.turnBoundaryOf !== 'function') {
    ctx.sessionProjections.register(require('@deepseek-ai/dsh-agent-loop').turnBoundaryProjectionDefinition)
  }
  await ctx.plugin(require('@deepseek-ai/dsh-tool-goal'), {})
  const { SessionId } = require('@deepseek-ai/dsh-session')
  const { createUserMessage } = require('@deepseek-ai/dsh-llm')
  const session = ctx.sessions.create(SessionId(`copis-goal-regression-${crypto.randomUUID()}`))
  const agent = {
    id: session.id, session, ctx, status: 'running', options: {}, model: {}, inbox: {},
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {},
    runMaintenance: (task: (signal: AbortSignal) => unknown) => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '验证官方 Goal 状态转换' }], source }), { surfaceOp: 'append' })
  const execute = async (args: Record<string, unknown>, initiator: unknown = agent) => ctx.agents.withInitiator(initiator, () =>
    ctx.tools.get('update_goal').execute(args, { agent, signal: new AbortController().signal, deferContext() {} }),
  )
  return { ctx, agent, session, execute, createUserMessage }
}

runtimeTest('Given blocked 调用携带轮数 15 When 官方 Goal 工具执行 Then 不报动作无关字段错误且不改写原有目标与轮数', async () => {
  const { ctx, agent, execute } = await harness()
  const goal = ctx.goals.create(agent, { objective: '保持原有目标', maxGoalRounds: 4 })
  await execute({ goal_id: goal.id, revision: goal.revision, action: 'blocked', objective: '', max_goal_rounds: 15, blocked_reason: '等待外部输入' })
  expect(ctx.goals.get(agent)).toMatchObject({ objective: goal.objective, maxGoalRounds: 4, phase: 'blocked', revision: goal.revision + 1, blockedReason: { code: 'model-reported', message: '等待外部输入' } })
})

for (const action of ['pause', 'resume', 'complete'] as const) {
  runtimeTest(`Given ${action} 附带其他动作的有效字段 When 官方工具执行 Then 仅更新选定动作的状态`, async () => {
    const { ctx, agent, execute } = await harness()
    const goal = ctx.goals.create(agent, { objective: '保持原有目标', maxGoalRounds: 4 })
    if (action === 'resume') ctx.goals.disarm(agent)
    await execute({ goal_id: goal.id, revision: goal.revision, action, objective: '不能覆盖原目标', max_goal_rounds: 15, blocked_reason: '不能写入阻塞理由' })
    expect(ctx.goals.get(agent)).toMatchObject({ objective: goal.objective, maxGoalRounds: 4, phase: action === 'resume' ? 'active' : action === 'pause' ? 'paused' : 'complete' })
    expect(ctx.goals.get(agent).blockedReason).toBeUndefined()
  })
}

runtimeTest('Given edit 动作 When 显式替换目标与轮数 Then 正常修改并保留 revision 乐观锁', async () => {
  const { ctx, agent, execute } = await harness()
  const goal = ctx.goals.create(agent, { objective: '原目标', maxGoalRounds: 4 })
  await execute({ goal_id: goal.id, revision: goal.revision, action: 'edit', objective: '新目标', max_goal_rounds: 15 })
  expect(ctx.goals.get(agent)).toMatchObject({ objective: '新目标', maxGoalRounds: 15, revision: goal.revision + 1 })
  await expect(execute({ goal_id: goal.id, revision: goal.revision, action: 'complete' })).rejects.toThrow()
  expect(ctx.goals.get(agent).phase).toBe('active')
})

runtimeTest('Given 缺少阻塞理由或越过调用者边界 When 更新 Goal Then 官方校验仍然拒绝且不修改状态', async () => {
  const { ctx, agent, execute } = await harness()
  const goal = ctx.goals.create(agent, { objective: '原目标', maxGoalRounds: 4 })
  await expect(execute({ goal_id: goal.id, revision: goal.revision, action: 'blocked', blocked_reason: '' })).rejects.toThrow()
  await expect(execute({ goal_id: goal.id, revision: goal.revision, action: 'complete' }, null)).rejects.toThrow()
  expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active', revision: goal.revision })
})


runtimeTest('Given 自动 Goal 轮次 When 未满三轮或尝试编辑 Then 官方权限与阻塞轮次下限仍有效', async () => {
  const { ctx, agent, session, execute, createUserMessage } = await harness()
  const goal = ctx.goals.create(agent, { objective: '只验证隔离目标', maxGoalRounds: 15 })
  for (let round = 1; round <= 3; round++) {
    session.append('turn/end', { turn: round, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: round + 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '继续隔离验收' }], source: { kind: 'goal', goalId: goal.id, revision: goal.revision, round } }), { surfaceOp: 'append' })
    const args = { goal_id: goal.id, revision: goal.revision, action: 'blocked', objective: '', max_goal_rounds: 15, blocked_reason: '测试中的同一外部条件持续未满足' }
    await expect(execute({ ...args, action: 'edit', objective: '不允许自动编辑' })).rejects.toMatchObject({ code: 'GOAL_TOOL_AUTHORITY_REQUIRED' })
    if (round < 3) {
      await expect(execute(args)).rejects.toMatchObject({ code: 'GOAL_TOOL_BLOCK_THRESHOLD' })
      expect(ctx.goals.get(agent).phase).toBe('active')
    } else {
      await execute(args)
      expect(ctx.goals.get(agent)).toMatchObject({ phase: 'blocked', objective: goal.objective, maxGoalRounds: 15, roundsStarted: 3 })
    }
  }
})

runtimeTest('Given 用户已暂停的 Goal When 模型尝试恢复或传入错误字段类型 Then 保留官方拒绝且不改变状态', async () => {
  const { ctx, agent, execute } = await harness()
  let goal = ctx.goals.create(agent, { objective: '原目标', maxGoalRounds: 4 })
  goal = ctx.goals.pause(agent, { id: goal.id, revision: goal.revision })
  await expect(execute({ goal_id: goal.id, revision: goal.revision, action: 'resume', max_goal_rounds: 15 })).rejects.toMatchObject({ code: 'GOAL_TOOL_RESUME_PAUSED' })
  await expect(execute({ goal_id: goal.id, revision: goal.revision, action: 'complete', max_goal_rounds: '15' })).rejects.toThrow()
  expect(ctx.goals.get(agent)).toMatchObject({ phase: 'paused', revision: goal.revision })
})
