import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentMessage, AgentSendInput } from '@copis/shared'
import type { ExpertTeamAgentExecutor, ExpertTeamRunSnapshot } from './expert-team-runner'
import type { ExpertTeamRustApi, ExpertTeamNodeEvent, ExpertTeamNodeRef, ExpertTeamArtifact } from './expert-team-rust-client'

mock.module('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' },
  shell: {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
  BrowserWindow: class {},
  WebContentsView: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  screen: {},
}))
const { ExpertTeamRunner } = await import('./expert-team-runner')

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function rootDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'copis-expert-team-'))
  tempRoots.push(root)
  return root
}

function snapshot(nodes: ExpertTeamRunSnapshot['nodes']): ExpertTeamRunSnapshot {
  return {
    runId: 'run-1',
    parentSessionId: 'parent-1',
    channelId: 'channel-1',
    modelId: 'model-1',
    workspaceId: 'workspace-1',
    nodes,
  }
}

class FakeRustApi implements ExpertTeamRustApi {
  readonly events: ExpertTeamNodeEvent[] = []
  readonly statuses: Array<{ nodeId: string; status: string }> = []
  readonly artifacts: ExpertTeamArtifact[] = []
  claimed = false
  completedRunStatus?: string

  claimRun(): Promise<void> {
    this.claimed = true
    return Promise.resolve()
  }

  completeRun(input: { runId: string; status: 'succeeded' | 'failed' | 'cancelled' }): Promise<void> {
    if (this.completedRunStatus) return Promise.reject(new Error('run complete called twice'))
    this.completedRunStatus = input.status
    return Promise.resolve()
  }

  nodeStarted(input: ExpertTeamNodeRef & { childSessionId: string; outputDir: string }): Promise<void> {
    this.statuses.push({ nodeId: input.nodeId, status: 'running' })
    return Promise.resolve()
  }

  nodeCompleted(input: ExpertTeamNodeRef & { childSessionId: string; summary?: string; noArtifact?: boolean }): Promise<void> {
    this.statuses.push({ nodeId: input.nodeId, status: 'succeeded' })
    return Promise.resolve()
  }

  nodeFailed(input: ExpertTeamNodeRef & { childSessionId?: string; error: string }): Promise<void> {
    this.statuses.push({ nodeId: input.nodeId, status: 'failed' })
    return Promise.resolve()
  }

  nodeCancelled(input: ExpertTeamNodeRef & { childSessionId?: string; reason?: string }): Promise<void> {
    this.statuses.push({ nodeId: input.nodeId, status: 'cancelled' })
    return Promise.resolve()
  }

  appendEvent(input: ExpertTeamNodeEvent): Promise<void> {
    this.events.push(input)
    return Promise.resolve()
  }

  recordArtifact(input: ExpertTeamArtifact): Promise<void> {
    this.artifacts.push(input)
    return Promise.resolve()
  }
}

class FakeAgent implements ExpertTeamAgentExecutor {
  readonly inputs: AgentSendInput[] = []
  readonly started: string[] = []
  readonly stopped: string[] = []
  maxRunning = 0
  private running = 0
  private readonly sessions = new Map<string, string>()
  private readonly completion = new Map<string, () => void>()
  constructor(
    private readonly root: string,
    private readonly options: { failNodes?: Set<string>; holdNodes?: Set<string> } = {},
  ) {}

  createSession(input: { title: string; channelId: string; workspaceId: string; modelId?: string; parentSessionId: string; nodeId: string }): { sessionId: string } {
    const nodeId = input.title.replace('专家团队：', '')
    const sessionId = `child-${nodeId}`
    this.sessions.set(sessionId, nodeId)
    return { sessionId }
  }

  run(input: AgentSendInput, callbacks: { onError: (error: string) => void; onComplete: (messages?: AgentMessage[]) => void }): Promise<void> {
    this.inputs.push(input)
    const nodeId = this.sessions.get(input.sessionId)!
    this.started.push(nodeId)
    this.running += 1
    this.maxRunning = Math.max(this.maxRunning, this.running)
    if (this.options.holdNodes?.has(nodeId)) {
      return new Promise<void>((resolve) => {
        this.completion.set(input.sessionId, () => {
          this.running -= 1
          resolve()
        })
      })
    }
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        this.running -= 1
        if (this.options.failNodes?.has(nodeId)) callbacks.onError(`${nodeId} failed`)
        else {
          const outputDir = join(this.root, '.copis', 'expert-team-runs', 'run-1', nodeId)
          if (nodeId === 'writer') writeFileSync(join(outputDir, 'result.md'), 'artifact', 'utf8')
          callbacks.onComplete([{ id: `message-${nodeId}`, role: 'assistant', content: `${nodeId} done`, createdAt: Date.now() }])
        }
        resolve()
      }, 1)
    })
  }

  stop(sessionId: string): void {
    this.stopped.push(sessionId)
    this.completion.get(sessionId)?.()
  }
}

describe('ExpertTeamRunner', () => {
  test('按 DAG 调度且最多同时运行配置并发数，Pi runtime 固定', async () => {
    const root = rootDir()
    const rust = new FakeRustApi()
    const agent = new FakeAgent(root)
    const result = await new ExpertTeamRunner({ workspaceRoot: root, rustApi: rust, agent, maxConcurrency: 2 }).run(snapshot([
      { id: 'research', role: 'researcher', task: 'research' },
      { id: 'review', role: 'reviewer', task: 'review' },
      { id: 'writer', role: 'writer', task: 'write', dependsOn: ['research', 'review'], outputPath: 'result.md' },
    ]))

    expect(result.nodes.every((node) => node.status === 'succeeded')).toBe(true)
    expect(rust.claimed).toBe(true)
    expect(rust.completedRunStatus).toBe('succeeded')
    expect(agent.maxRunning).toBeLessThanOrEqual(2)
    expect(agent.started.indexOf('writer')).toBeGreaterThan(agent.started.indexOf('research'))
    expect(agent.started.indexOf('writer')).toBeGreaterThan(agent.started.indexOf('review'))
    expect(agent.inputs.every((input) => input.agentRuntime === 'pi' && input.triggeredBy === 'delegation')).toBe(true)
    expect(agent.inputs.every((input) => input.permissionModeOverride === 'bypassPermissions')).toBe(true)
    expect(rust.artifacts.some((artifact) => artifact.nodeId === 'writer' && artifact.path === 'result.md')).toBe(true)
  })

  test('节点失败会阻止依赖节点', async () => {
    const root = rootDir()
    const rust = new FakeRustApi()
    const agent = new FakeAgent(root, { failNodes: new Set(['bad']) })
    const result = await new ExpertTeamRunner({ workspaceRoot: root, rustApi: rust, agent }).run(snapshot([
      { id: 'bad', role: 'executor', task: 'fail' },
      { id: 'dependent', role: 'writer', task: 'blocked', dependsOn: ['bad'] },
    ]))
    expect(result.nodes.find((node) => node.nodeId === 'bad')?.status).toBe('failed')
    expect(result.nodes.find((node) => node.nodeId === 'dependent')?.status).toBe('failed')
    expect(agent.started).toEqual(['bad'])
    expect(rust.completedRunStatus).toBe('failed')
  })

  test('AbortController 会停止运行节点并取消剩余节点', async () => {
    const root = rootDir()
    const rust = new FakeRustApi()
    const agent = new FakeAgent(root, { holdNodes: new Set(['held']) })
    const controller = new AbortController()
    const run = new ExpertTeamRunner({ workspaceRoot: root, rustApi: rust, agent }).run(snapshot([
      { id: 'held', role: 'executor', task: 'hold' },
      { id: 'later', role: 'writer', task: 'later', dependsOn: ['held'] },
    ]), controller.signal)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    controller.abort()
    const result = await run
    expect(result.nodes.every((node) => node.status === 'cancelled')).toBe(true)
    expect(agent.stopped).toEqual(['child-held'])
    expect(rust.statuses.some((status) => status.status === 'cancelled')).toBe(true)
    expect(rust.completedRunStatus).toBe('cancelled')
  })

  test('拒绝循环依赖和绝对产物路径', async () => {
    const root = rootDir()
    const rust = new FakeRustApi()
    const agent = new FakeAgent(root)
    await expect(new ExpertTeamRunner({ workspaceRoot: root, rustApi: rust, agent }).run(snapshot([
      { id: 'a', role: 'executor', task: 'a', dependsOn: ['b'] },
      { id: 'b', role: 'executor', task: 'b', dependsOn: ['a'] },
    ]))).rejects.toThrow('依赖存在环')
    await expect(new ExpertTeamRunner({ workspaceRoot: root, rustApi: rust, agent }).run(snapshot([
      { id: 'a', role: 'executor', task: 'a', outputPath: '/tmp/out' },
    ]))).rejects.toThrow('相对路径')
  })
})
