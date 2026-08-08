/**
 * 本地专家团队执行器。
 *
 * 这里的“团队成员”是 Copis Pi Agent 子会话，不是外部 Codex/bwrap 进程。
 * 调度器只接受冻结快照，所有可变状态通过 Rust API client 逐步写回。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, normalize, relative, resolve } from 'node:path'
import type { AgentMessage, AgentSendInput, ExpertTeamPromptContext } from '@copis/shared'
import {
  createAgentSession,
  updateAgentSessionMeta,
} from './agent-session-manager'
import {
  runRegisteredHeadlessAgent,
  stopRegisteredAgent,
} from './agent-headless-runner-registry'
import { HttpExpertTeamRustApiClient } from './expert-team-rust-client'
import type { ExpertTeamRustApi } from './expert-team-rust-client'

export const EXPERT_TEAM_MAX_CONCURRENCY = 4

export type ExpertTeamNodeRole = 'researcher' | 'writer' | 'reviewer' | 'executor' | 'explore' | 'research' | 'implement' | 'review' | 'custom'
export type ExpertTeamNodeStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface ExpertTeamNodeSnapshot {
  readonly id: string
  readonly role: ExpertTeamNodeRole
  /** 节点任务文本。冻结后不得由 renderer 或运行时改写。 */
  readonly task: string
  readonly dependsOn?: readonly string[]
  /** 相对于该节点输出目录的声明产物路径；不传表示显式无产物节点。 */
  readonly outputPath?: string
  readonly allowNoArtifact?: boolean
}

export interface ExpertTeamRunSnapshot {
  readonly runId: string
  readonly parentSessionId: string
  readonly channelId: string
  readonly modelId?: string
  readonly workspaceId: string
  readonly nodes: readonly ExpertTeamNodeSnapshot[]
  /** 创建 run 时冻结的专家团队上下文；同一 run 的所有节点共享，不得被后续 schema 更新改写。 */
  readonly expertTeamContext?: ExpertTeamPromptContext
}

export interface ExpertTeamNodeResult {
  readonly nodeId: string
  readonly status: ExpertTeamNodeStatus
  readonly childSessionId?: string
  readonly summary?: string
  readonly error?: string
  readonly outputPath?: string
}

export interface ExpertTeamRunResult {
  readonly runId: string
  readonly nodes: readonly ExpertTeamNodeResult[]
}

export interface ExpertTeamAgentRunResult {
  readonly summary?: string
  readonly messages?: readonly AgentMessage[]
}

export interface ExpertTeamAgentExecutor {
  createSession(input: {
    title: string
    channelId: string
    workspaceId: string
    modelId?: string
    parentSessionId: string
    nodeId: string
  }): { sessionId: string }
  run(input: AgentSendInput, callbacks: {
    onError: (error: string) => void
    onComplete: (messages?: AgentMessage[]) => void
  }): Promise<void>
  stop(sessionId: string): Promise<void> | void
}

export interface ExpertTeamRunnerDependencies {
  rustApi?: ExpertTeamRustApi
  agent?: ExpertTeamAgentExecutor
  /** 主进程根据 workspaceId 解析出的受控可写根目录。 */
  workspaceRoot: string
  maxConcurrency?: number
}

interface NormalizedNode extends ExpertTeamNodeSnapshot {
  readonly dependencies: readonly string[]
  readonly outputDir: string
  readonly declaredOutputPath?: string
}

interface MutableNodeResult {
  nodeId: string
  status: ExpertTeamNodeStatus
  childSessionId?: string
  summary?: string
  error?: string
  outputPath?: string
}

function assertIdentifier(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new Error(`${field} 参数不正确`)
  }
  return value
}

function assertRelativeOutputPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (!value.trim() || value.includes('\0') || isAbsolute(value)) {
    throw new Error('节点产物路径必须是非空相对路径')
  }
  const normalized = normalize(value)
  if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${'/'}`) || normalized.startsWith(`..\\`)) {
    throw new Error('节点产物路径不能跳出节点输出目录')
  }
  return normalized
}

function assertInsideRoot(root: string, candidate: string, label: string): void {
  const rootPath = resolve(root)
  const candidatePath = resolve(candidate)
  const rel = relative(rootPath, candidatePath)
  if (rel === '..' || rel.startsWith(`..${'/'}`) || rel.startsWith(`..\\`) || isAbsolute(rel)) {
    throw new Error(`${label} 必须位于工作区受控根目录内`)
  }
}

function buildOutputDir(root: string, runId: string, nodeId: string): string {
  const outputDir = resolve(root, '.copis', 'expert-team-runs', runId, nodeId)
  assertInsideRoot(root, outputDir, '专家团队输出目录')
  return outputDir
}

function summarizeMessages(messages: readonly AgentMessage[] | undefined): string | undefined {
  const assistant = [...(messages ?? [])]
    .reverse()
    .find((message) => message.role === 'assistant' && message.content.trim())
  return assistant?.content.trim()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function buildNodePrompt(
  snapshot: ExpertTeamRunSnapshot,
  node: NormalizedNode,
): string {
  const artifactInstruction = node.declaredOutputPath
    ? `必须将最终产物写入节点输出目录下的相对路径：${node.declaredOutputPath}`
    : '本节点明确无文件产物；完成前不要伪造产物路径。'
  const dependencyInstruction = node.dependencies.length > 0
    ? `前序节点产物位于工作区运行目录下：${node.dependencies.map((dependency) => `.copis/expert-team-runs/${snapshot.runId}/${dependency}`).join('、')}。需要时先读取这些目录中的文件。`
    : '本节点没有前序节点产物。'
  return `你是 Copis 本地专家团队的 ${node.role} 节点成员，属于运行 ${snapshot.runId} 的节点 ${node.id}。

<copis_expert_team_node>
${JSON.stringify({
  nodeId: node.id,
  role: node.role,
  task: node.task,
  dependsOn: node.dependencies,
  outputPath: node.declaredOutputPath ?? null,
})}
</copis_expert_team_node>

工作边界：
- 只处理本节点任务，不创建或调用任何协作子会话，不委派给其他 Agent。
- 运行时固定为 Copis Pi；不要使用 Codex、bwrap 或任何外部代理运行时。
- 节点输出目录为：${node.outputDir}
- ${artifactInstruction}
- ${dependencyInstruction}
- ${node.declaredOutputPath ? '如果无法生成声明产物，必须明确说明失败，不要仅以最终文本冒充成功。' : '完成时会由系统写入无产物完成记录。'}

本节点任务：
${node.task.trim()}`
}

function createDefaultAgentExecutor(): ExpertTeamAgentExecutor {
  return {
    createSession(input) {
      const child = createAgentSession(input.title, input.channelId, input.workspaceId, input.modelId, 'pi')
      updateAgentSessionMeta(child.id, {
        parentSessionId: input.parentSessionId,
        rootSessionId: input.parentSessionId,
        sourceDelegationId: `expert-team-${input.nodeId}-${child.id}`,
        delegationRole: 'custom',
        delegationStatus: 'running',
        delegationDepth: 1,
        delegationGoal: `专家团队节点 ${input.nodeId}`,
        permissionMode: 'bypassPermissions',
        workingMode: 'expert',
      })
      return { sessionId: child.id }
    },
    run(input, callbacks) {
      return runRegisteredHeadlessAgent(input, {
        source: 'delegation',
        originSessionId: input.sessionId,
        onError: callbacks.onError,
        onComplete: callbacks.onComplete,
        onTitleUpdated: () => {},
      })
    },
    stop(sessionId) {
      stopRegisteredAgent(sessionId)
    },
  }
}

function validateSnapshot(snapshot: ExpertTeamRunSnapshot, workspaceRoot: string): NormalizedNode[] {
  assertIdentifier(snapshot.runId, 'runId')
  if (!snapshot.parentSessionId.trim() || !snapshot.channelId.trim() || !snapshot.workspaceId.trim()) {
    throw new Error('专家团队快照缺少父会话、渠道或工作区')
  }
  if (!Array.isArray(snapshot.nodes) || snapshot.nodes.length === 0) {
    throw new Error('专家团队至少需要一个节点')
  }

  const ids = new Set<string>()
  const rawNodes = snapshot.nodes.map((node) => {
    assertIdentifier(node.id, 'nodeId')
    if (ids.has(node.id)) throw new Error(`节点 ID 重复: ${node.id}`)
    ids.add(node.id)
    if (!['researcher', 'writer', 'reviewer', 'executor', 'explore', 'research', 'implement', 'review', 'custom'].includes(node.role)) {
      throw new Error(`节点角色不支持: ${node.role}`)
    }
    if (!node.task.trim()) throw new Error(`节点任务不能为空: ${node.id}`)
    const dependencies = [...(node.dependsOn ?? [])]
    if (dependencies.some((dependency) => dependency === node.id)) {
      throw new Error(`节点不能依赖自身: ${node.id}`)
    }
    const declaredOutputPath = assertRelativeOutputPath(node.outputPath)
    return { node, dependencies, declaredOutputPath }
  })

  for (const item of rawNodes) {
    for (const dependency of item.dependencies) {
      if (!ids.has(dependency)) throw new Error(`节点依赖不存在: ${item.node.id} -> ${dependency}`)
    }
  }

  // Kahn 检查只负责验证快照，不改变运行时调度状态。
  const incoming = new Map(rawNodes.map((item) => [item.node.id, item.dependencies.length]))
  const queue = rawNodes.filter((item) => item.dependencies.length === 0).map((item) => item.node.id)
  let visited = 0
  while (queue.length > 0) {
    const current = queue.shift()!
    visited += 1
    for (const item of rawNodes) {
      if (!item.dependencies.includes(current)) continue
      const count = (incoming.get(item.node.id) ?? 0) - 1
      incoming.set(item.node.id, count)
      if (count === 0) queue.push(item.node.id)
    }
  }
  if (visited !== rawNodes.length) throw new Error('专家团队节点依赖存在环')

  const runRoot = resolve(workspaceRoot, '.copis', 'expert-team-runs', snapshot.runId)
  assertInsideRoot(workspaceRoot, runRoot, '专家团队运行目录')
  return rawNodes.map(({ node, dependencies, declaredOutputPath }) => {
    const outputDir = buildOutputDir(workspaceRoot, snapshot.runId, node.id)
    const outputPath = declaredOutputPath ? resolve(outputDir, declaredOutputPath) : undefined
    if (outputPath) assertInsideRoot(outputDir, outputPath, '节点产物路径')
    return {
      ...node,
      dependencies,
      outputDir,
      ...(declaredOutputPath ? { declaredOutputPath } : {}),
    }
  })
}

export class ExpertTeamRunner {
  private readonly rustApi: ExpertTeamRustApi
  private readonly agent: ExpertTeamAgentExecutor
  private readonly workspaceRoot: string
  private readonly maxConcurrency: number

  constructor(dependencies: ExpertTeamRunnerDependencies) {
    this.rustApi = dependencies.rustApi ?? new HttpExpertTeamRustApiClient()
    this.agent = dependencies.agent ?? createDefaultAgentExecutor()
    this.workspaceRoot = resolve(dependencies.workspaceRoot)
    const maxConcurrency = dependencies.maxConcurrency ?? EXPERT_TEAM_MAX_CONCURRENCY
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > EXPERT_TEAM_MAX_CONCURRENCY) {
      throw new Error(`专家团队并发数必须在 1-${EXPERT_TEAM_MAX_CONCURRENCY} 之间`)
    }
    this.maxConcurrency = maxConcurrency
  }

  async run(snapshot: ExpertTeamRunSnapshot, signal?: AbortSignal): Promise<ExpertTeamRunResult> {
    const nodes = validateSnapshot(snapshot, this.workspaceRoot)
    const results = new Map<string, MutableNodeResult>()
    const running = new Map<string, Promise<void>>()
    const completed = new Set<string>()
    const failed = new Set<string>()
    const cancelled = new Set<string>()
    const childSessionIds = new Map<string, string>()
    await this.rustApi.claimRun(snapshot.runId)

    const queueNode = async (node: NormalizedNode): Promise<void> => {
      results.set(node.id, { nodeId: node.id, status: 'queued' })
      await this.rustApi.appendEvent({ runId: snapshot.runId, nodeId: node.id, type: 'queued' })
    }
    for (const node of nodes) await queueNode(node)

    const cancelRunning = async (reason: string): Promise<void> => {
      await Promise.all([...childSessionIds.values()].map(async (sessionId) => {
        try {
          await this.agent.stop(sessionId)
        } catch (error) {
          console.warn(`[专家团队] 停止节点失败 (${sessionId}): ${errorMessage(error)}`)
        }
      }))
      for (const node of nodes) {
        const result = results.get(node.id)
        if (!result || result.status === 'succeeded' || result.status === 'failed' || result.status === 'cancelled') continue
        result.status = 'cancelled'
        result.error = reason
        cancelled.add(node.id)
        await this.rustApi.nodeCancelled({ runId: snapshot.runId, nodeId: node.id, childSessionId: childSessionIds.get(node.id), reason })
        await this.rustApi.appendEvent({ runId: snapshot.runId, nodeId: node.id, type: 'cancelled', payload: { reason } })
      }
    }

    const runNode = async (node: NormalizedNode): Promise<void> => {
      const result = results.get(node.id)!
      if (signal?.aborted) throw new Error('专家团队运行已取消')
      mkdirSync(node.outputDir, { recursive: true })
      // 路径校验同时检查已存在的 symlink，避免预置链接把产物目录带出工作区。
      assertInsideRoot(realpathSync(this.workspaceRoot), realpathSync(node.outputDir), '专家团队输出目录')
      const child = this.agent.createSession({
        title: `专家团队：${node.id}`,
        channelId: snapshot.channelId,
        workspaceId: snapshot.workspaceId,
        modelId: snapshot.modelId,
        parentSessionId: snapshot.parentSessionId,
        nodeId: node.id,
      })
      childSessionIds.set(node.id, child.sessionId)
      result.childSessionId = child.sessionId
      result.status = 'running'
      await this.rustApi.nodeStarted({
        runId: snapshot.runId,
        nodeId: node.id,
        childSessionId: child.sessionId,
        outputDir: node.outputDir,
      })
      await this.rustApi.appendEvent({ runId: snapshot.runId, nodeId: node.id, type: 'running', payload: { childSessionId: child.sessionId } })

      let messages: AgentMessage[] | undefined
      let callbackError: string | undefined
      let noArtifact = !node.declaredOutputPath
      const input: AgentSendInput = {
        sessionId: child.sessionId,
        userMessage: buildNodePrompt(snapshot, node),
        rawUserMessage: node.task,
        channelId: snapshot.channelId,
        modelId: snapshot.modelId,
        agentRuntime: 'pi',
        workspaceId: snapshot.workspaceId,
        permissionModeOverride: 'bypassPermissions',
        workingMode: 'expert',
        startedAt: Date.now(),
        triggeredBy: 'delegation',
        ...(snapshot.expertTeamContext
          ? { expertTeamContext: { ...snapshot.expertTeamContext, nodeId: node.id } }
          : {}),
      }
      await this.agent.run(input, {
        onError: (error) => { callbackError = error },
        onComplete: (completedMessages) => { messages = completedMessages },
      })
      if (callbackError) throw new Error(callbackError)
      if (signal?.aborted) throw new Error('专家团队运行已取消')

      const summary = summarizeMessages(messages)
      result.summary = summary
      if (node.declaredOutputPath) {
        const outputPath = resolve(node.outputDir, node.declaredOutputPath)
        try {
          assertInsideRoot(realpathSync(node.outputDir), realpathSync(outputPath), '节点产物路径')
          const info = statSync(outputPath)
          if (!info.isFile()) throw new Error('声明产物不是文件')
          const content = readFileSync(outputPath)
          await this.rustApi.recordArtifact({
            runId: snapshot.runId,
            nodeId: node.id,
            path: node.declaredOutputPath,
            sizeBytes: info.size,
            sha256: createHash('sha256').update(content).digest('hex'),
          })
          await this.rustApi.appendEvent({ runId: snapshot.runId, nodeId: node.id, type: 'artifact', payload: { path: node.declaredOutputPath, sizeBytes: info.size } })
          result.outputPath = node.declaredOutputPath
        } catch (error) {
          if (node.allowNoArtifact) {
            noArtifact = true
            result.error = `声明产物未生成，按 allowNoArtifact 完成：${errorMessage(error)}`
            const completionPath = join(node.outputDir, 'no-artifact-completion.json')
            writeFileSync(completionPath, JSON.stringify({
              runId: snapshot.runId,
              nodeId: node.id,
              status: 'succeeded',
              noArtifact: true,
              reason: result.error,
              completedAt: Date.now(),
            }, null, 2), 'utf8')
            await this.rustApi.recordArtifact({ runId: snapshot.runId, nodeId: node.id, path: 'no-artifact-completion.json', sizeBytes: statSync(completionPath).size })
            await this.rustApi.appendEvent({ runId: snapshot.runId, nodeId: node.id, type: 'artifact', payload: { path: 'no-artifact-completion.json', noArtifact: true } })
          } else {
            throw new Error(`节点声明产物未生成: ${node.declaredOutputPath}`)
          }
        }
      } else {
        const completionPath = join(node.outputDir, 'no-artifact-completion.json')
        writeFileSync(completionPath, JSON.stringify({
          runId: snapshot.runId,
          nodeId: node.id,
          status: 'succeeded',
          summary: summary ?? null,
          completedAt: Date.now(),
        }, null, 2), 'utf8')
        await this.rustApi.recordArtifact({ runId: snapshot.runId, nodeId: node.id, path: 'no-artifact-completion.json', sizeBytes: statSync(completionPath).size })
        await this.rustApi.appendEvent({ runId: snapshot.runId, nodeId: node.id, type: 'artifact', payload: { path: 'no-artifact-completion.json', noArtifact: true } })
      }
      result.status = 'succeeded'
      completed.add(node.id)
      await this.rustApi.nodeCompleted({
        runId: snapshot.runId,
        nodeId: node.id,
        childSessionId: child.sessionId,
        ...(summary ? { summary } : {}),
        noArtifact,
      })
      await this.rustApi.appendEvent({ runId: snapshot.runId, nodeId: node.id, type: 'succeeded', payload: { childSessionId: child.sessionId } })
    }

    const blockNode = async (node: NormalizedNode, reason: string): Promise<void> => {
      const result = results.get(node.id)!
      if (result.status !== 'queued') return
      result.status = 'failed'
      result.error = reason
      failed.add(node.id)
      await this.rustApi.nodeFailed({ runId: snapshot.runId, nodeId: node.id, error: reason })
      await this.rustApi.appendEvent({ runId: snapshot.runId, nodeId: node.id, type: 'failed', payload: { blocked: true, reason } })
    }

    const abortPromise = signal
      ? new Promise<'aborted'>((resolveAbort) => {
          if (signal.aborted) resolveAbort('aborted')
          else signal.addEventListener('abort', () => resolveAbort('aborted'), { once: true })
        })
      : undefined

    try {
      while (completed.size + failed.size + cancelled.size < nodes.length) {
        if (signal?.aborted) {
          await cancelRunning('用户取消专家团队运行')
          break
        }
        let madeProgress = false
        for (const node of nodes) {
          const result = results.get(node.id)!
          if (result.status !== 'queued') continue
          const dependencyResults = node.dependencies.map((dependency) => results.get(dependency)!)
          const failedDependency = dependencyResults.find((dependency) => dependency.status === 'failed' || dependency.status === 'cancelled')
          if (failedDependency) {
            await blockNode(node, `依赖节点失败或取消: ${failedDependency.nodeId}`)
            madeProgress = true
            continue
          }
          if (!dependencyResults.every((dependency) => dependency.status === 'succeeded')) continue
          if (running.size >= this.maxConcurrency) continue
          const execution = runNode(node).catch(async (error: unknown) => {
            const message = errorMessage(error)
            const current = results.get(node.id)!
            if (current.status === 'cancelled' || current.status === 'failed' || current.status === 'succeeded') return
            if (signal?.aborted || /已取消/.test(message)) {
              current.status = 'cancelled'
              current.error = message
              cancelled.add(node.id)
              await this.rustApi.nodeCancelled({ runId: snapshot.runId, nodeId: node.id, childSessionId: current.childSessionId, reason: message })
              await this.rustApi.appendEvent({ runId: snapshot.runId, nodeId: node.id, type: 'cancelled', payload: { reason: message } })
            } else {
              current.status = 'failed'
              current.error = message
              failed.add(node.id)
              await this.rustApi.nodeFailed({ runId: snapshot.runId, nodeId: node.id, childSessionId: current.childSessionId, error: message })
              await this.rustApi.appendEvent({ runId: snapshot.runId, nodeId: node.id, type: 'failed', payload: { error: message } })
            }
          }).finally(() => {
            running.delete(node.id)
          })
          running.set(node.id, execution)
          madeProgress = true
        }
        if (running.size > 0) {
          const finished = Promise.race(running.values()).then(() => 'finished' as const)
          const outcome = abortPromise ? await Promise.race([finished, abortPromise]) : await finished
          if (outcome === 'aborted') {
            await cancelRunning('用户取消专家团队运行')
            break
          }
          continue
        }
        if (!madeProgress) throw new Error('专家团队调度器无法推进 DAG')
      }
    } catch (error) {
      if (signal?.aborted) await cancelRunning('用户取消专家团队运行')
      else {
        await this.rustApi.completeRun({ runId: snapshot.runId, status: 'failed' })
        throw error
      }
    }

    if (running.size > 0) await Promise.all(running.values())
    const finalStatus = cancelled.size > 0
      ? 'cancelled'
      : failed.size > 0
        ? 'failed'
        : 'succeeded'
    await this.rustApi.completeRun({ runId: snapshot.runId, status: finalStatus })
    return {
      runId: snapshot.runId,
      nodes: nodes.map((node) => results.get(node.id)!),
    }
  }
}

export function createExpertTeamRunner(dependencies: ExpertTeamRunnerDependencies): ExpertTeamRunner {
  return new ExpertTeamRunner(dependencies)
}
