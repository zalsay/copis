import type {
  MemoryCaptureBatchInput,
  MemoryKind,
  MemoryPolicy,
  ProviderType,
} from '@copis/shared'
import { getAdapter, type ProviderRequest } from '@copis/core'
import { getFetchFn } from '../proxy-fetch'

/** QM per-turn 静默 flush 窗口。 */
export const MEMORY_CAPTURE_QUIET_MS = 180_000
/** QM per-turn 的最大 burst 轮数。 */
export const MEMORY_CAPTURE_MAX_TURNS = 10
const MEMORY_CAPTURE_MAX_TRANSCRIPT_CHARS = 24_000
const MEMORY_CAPTURE_MAX_FACTS = 20
const MEMORY_CAPTURE_MAX_FIELD_CHARS = 600

export interface CompletedAgentTurn {
  sessionId: string
  workspaceSlug: string
  userInput: string
  assistantReply: string
  autonomous: boolean
  memoryPolicy?: MemoryPolicy
  /** 当前渠道的隐藏抽取器；只保存在内存 burst 中，不落盘。 */
  extractor?: MemoryFactExtractor
  /** 达到 scratch 阈值后触发同一 workspace 的 consolidation 队列。 */
  maintenanceRunner?: () => Promise<void>
}

export interface MemoryCaptureFact {
  title: string
  content: string
  tags: string[]
  kind?: MemoryKind
}

export interface MemoryFactExtractor {
  (turns: readonly CompletedAgentTurn[]): Promise<string>
}

export interface MemoryAutoCaptureOptions {
  captureBatch?: (input: MemoryCaptureBatchInput) => Promise<unknown>
  extractor?: MemoryFactExtractor
  quietMs?: number
  maxTurns?: number
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

interface BurstState {
  key: string
  workspaceSlug: string
  turns: CompletedAgentTurn[]
  timer?: ReturnType<typeof setTimeout>
  flushing?: Promise<void>
}

function isMemoryKind(value: string): boolean {
  return value === 'fact'
    || value === 'preference'
    || value === 'decision'
    || value === 'project'
    || value === 'scratch'
}

function trimField(value: string, maxChars: number): string {
  return value.trim().slice(0, maxChars)
}

function parseFactLine(line: string): MemoryCaptureFact | undefined {
  const raw = line.slice(2).trim()
  if (!raw) return undefined

  // 允许模型输出 `- [kind] title: content`，kind 只用于校验，最终统一落为 scratch。
  const bracketed = raw.match(/^\[([^\]]+)\]\s*(.+?)\s*:\s*(.+)$/)
  if (bracketed) {
    const kind = bracketed[1]?.trim().toLowerCase()
    if (kind && !isMemoryKind(kind)) return undefined
    const title = trimField(bracketed[2] ?? '', 160)
    const content = trimField(bracketed[3] ?? '', MEMORY_CAPTURE_MAX_FIELD_CHARS)
    return title && content ? { title, content, tags: ['auto-capture'], kind: kind as MemoryKind } : undefined
  }

  const pipeSeparated = raw.split('|').map((value) => value.trim())
  if (pipeSeparated.length === 3 && isMemoryKind(pipeSeparated[0] ?? '')) {
    const title = trimField(pipeSeparated[1] ?? '', 160)
    const content = trimField(pipeSeparated[2] ?? '', MEMORY_CAPTURE_MAX_FIELD_CHARS)
    return title && content ? { title, content, tags: ['auto-capture'], kind: pipeSeparated[0] as MemoryKind } : undefined
  }

  const colonIndex = raw.indexOf(':')
  const title = trimField(colonIndex > 0 ? raw.slice(0, colonIndex) : '自动捕获事实', 160)
  const content = trimField(colonIndex > 0 ? raw.slice(colonIndex + 1) : raw, MEMORY_CAPTURE_MAX_FIELD_CHARS)
  return title && content ? { title, content, tags: ['auto-capture'] } : undefined
}

/** 严格解析隐藏抽取回合：只能是 NONE 或每行一个 Markdown bullet。 */
export function parseMemoryFacts(output: string): MemoryCaptureFact[] {
  const normalized = output.trim()
  if (!normalized || normalized === 'NONE') return []

  const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0 || lines.some((line) => !line.startsWith('- '))) return []

  const facts: MemoryCaptureFact[] = []
  for (const line of lines) {
    const fact = parseFactLine(line)
    if (!fact) return []
    facts.push(fact)
    if (facts.length >= MEMORY_CAPTURE_MAX_FACTS) break
  }
  return facts
}

function cleanTranscriptText(value: string): string {
  return value
    .replace(/(?:sk|pk|api[_ -]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1: [redacted]')
    .replace(/(?:https?|file):\/\/[^\s)]+/gi, '[path-or-url]')
    .slice(0, 8_000)
}

export function buildMemoryExtractionPrompt(turns: readonly CompletedAgentTurn[]): string {
  const transcript = turns.map((turn, index) => [
    `回合 ${index + 1}（${turn.autonomous ? '自动任务' : '用户任务'}）`,
    `用户：${cleanTranscriptText(turn.userInput)}`,
    `助手：${cleanTranscriptText(turn.assistantReply)}`,
  ].join('\n')).join('\n\n').slice(-MEMORY_CAPTURE_MAX_TRANSCRIPT_CHARS)

  return `<copis_memory_auto_capture>
这是 Copis 的隐藏记忆抽取回合，只分析下面的已完成回合，不回答原始用户问题。

只输出以下两种形式之一：
1. 没有稳定、未来仍有用的信息时只输出 NONE
2. 每行一个 Markdown bullet，格式为 - [fact|preference|decision|project|scratch] 标题: 内容

只记录用户明确说过、未来仍可能有用的偏好、身份、项目长期事实、持久决策和工作方式。禁止记录 secret、一次性 trivia、系统 endpoint/header、文件路径、tool schema、长文档正文或助手自行推导的偏好。
自动任务回合只能记录运行状态、阻塞和结果，不能生成用户偏好、用户身份或跨项目事实。
每条内容保持简短，不要输出解释、JSON、编号或额外段落。

${transcript}
</copis_memory_auto_capture>`
}

function increaseExtractionBudget(request: ProviderRequest): ProviderRequest {
  try {
    const body = JSON.parse(request.body) as Record<string, unknown>
    if (typeof body.max_tokens === 'number') body.max_tokens = 512
    const generationConfig = body.generationConfig
    if (typeof generationConfig === 'object' && generationConfig !== null && !Array.isArray(generationConfig)) {
      body.generationConfig = { ...(generationConfig as Record<string, unknown>), maxOutputTokens: 512 }
    }
    return { ...request, body: JSON.stringify(body) }
  } catch {
    return request
  }
}

/** 使用当前渠道执行一次不展示的文本回合。 */
export async function runMemoryTextTurn(input: {
  provider: ProviderType
  baseUrl?: string
  apiKey: string
  modelId: string
  proxyUrl?: string
  prompt: string
}): Promise<string> {
  const adapter = getAdapter(input.provider)
  const request = increaseExtractionBudget(adapter.buildTitleRequest({
    baseUrl: input.baseUrl ?? '',
    apiKey: input.apiKey,
    modelId: input.modelId,
    prompt: input.prompt,
  }))
  const response = await getFetchFn(input.proxyUrl)(request.url, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`记忆抽取请求失败（HTTP ${response.status}）`)
  const payload = await response.json() as unknown
  return adapter.parseTitleResponse(payload) ?? ''
}

export async function extractMemoryFactsWithProvider(input: {
  provider: ProviderType
  baseUrl?: string
  apiKey: string
  modelId: string
  proxyUrl?: string
  turns: readonly CompletedAgentTurn[]
}): Promise<string> {
  return runMemoryTextTurn({
    ...input,
    prompt: buildMemoryExtractionPrompt(input.turns),
  })
}

function stateKey(turn: CompletedAgentTurn): string {
  return `${turn.workspaceSlug}\u0000${turn.sessionId}\u0000${turn.autonomous ? 'auto' : 'user'}`
}

function toBatchItems(facts: readonly MemoryCaptureFact[]): MemoryCaptureBatchInput['items'] {
  return facts.map((fact) => ({
    kind: 'scratch' as const,
    title: fact.title,
    content: fact.content,
    tags: fact.tags,
  }))
}

export class MemoryAutoCapture {
  private readonly bursts = new Map<string, BurstState>()
  private readonly captureBatch: (input: MemoryCaptureBatchInput) => Promise<unknown>
  private readonly defaultExtractor?: MemoryFactExtractor
  private readonly quietMs: number
  private readonly maxTurns: number
  private readonly setTimeoutFn: typeof setTimeout
  private readonly clearTimeoutFn: typeof clearTimeout

  constructor(options: MemoryAutoCaptureOptions = {}) {
    this.captureBatch = options.captureBatch ?? (async (input) => {
      const { memoryApiClient } = await import('../memory-api-client')
      return memoryApiClient.captureBatch(input)
    })
    this.defaultExtractor = options.extractor
    this.quietMs = options.quietMs ?? MEMORY_CAPTURE_QUIET_MS
    this.maxTurns = options.maxTurns ?? MEMORY_CAPTURE_MAX_TURNS
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout
  }

  async onTurnEnd(turn: CompletedAgentTurn): Promise<void> {
    if (turn.memoryPolicy !== 'writable' || !turn.workspaceSlug || !turn.userInput.trim() || !turn.assistantReply.trim()) return

    const key = stateKey(turn)
    const state = this.bursts.get(key) ?? { key, workspaceSlug: turn.workspaceSlug, turns: [] }
    state.turns.push(turn)
    this.bursts.set(key, state)
    this.restartQuietTimer(state)

    if (state.turns.length >= this.maxTurns) {
      await this.flush(turn.workspaceSlug, 'turn_limit')
    }
  }

  async flush(workspaceSlug: string, reason: 'quiet' | 'turn_limit' | 'manual'): Promise<void> {
    const states = [...this.bursts.values()].filter((state) => state.workspaceSlug === workspaceSlug)
    await Promise.all(states.map((state) => this.flushState(state, reason)))
  }

  dispose(sessionId: string): void {
    for (const [key, state] of this.bursts) {
      if (!state.turns.some((turn) => turn.sessionId === sessionId)) continue
      this.clearTimer(state)
      this.bursts.delete(key)
    }
  }

  disposeAll(): void {
    for (const state of this.bursts.values()) this.clearTimer(state)
    this.bursts.clear()
  }

  private clearTimer(state: BurstState): void {
    if (state.timer) {
      this.clearTimeoutFn(state.timer)
      state.timer = undefined
    }
  }

  private restartQuietTimer(state: BurstState): void {
    this.clearTimer(state)
    state.timer = this.setTimeoutFn(() => {
      state.timer = undefined
      void this.flushState(state, 'quiet').catch((error) => {
        console.warn('[Memory] 静默自动捕获失败:', error)
      })
    }, this.quietMs)
    const timerWithUnref = state.timer as unknown as { unref?: () => void }
    timerWithUnref.unref?.()
  }

  private async flushState(state: BurstState, reason: 'quiet' | 'turn_limit' | 'manual'): Promise<void> {
    if (state.flushing) return state.flushing
    this.clearTimer(state)
    const turns = [...state.turns]
    const extractor = turns.at(-1)?.extractor ?? this.defaultExtractor
    if (turns.length === 0 || !extractor) {
      this.bursts.delete(state.key)
      return
    }

    const run = (async () => {
      try {
        const output = await extractor(turns)
        const parsedFacts = parseMemoryFacts(output)
        const facts = turns.every((turn) => turn.autonomous)
          ? parsedFacts.filter((fact) => fact.kind === 'scratch')
          : parsedFacts
        if (facts.length > 0) {
          await this.captureBatch({ workspaceSlug: state.workspaceSlug, items: toBatchItems(facts) })
          await turns.at(-1)?.maintenanceRunner?.()
          console.log(`[Memory] 自动捕获完成: workspace=${state.workspaceSlug}, reason=${reason}, facts=${facts.length}`)
        } else {
          console.log(`[Memory] 自动捕获无可沉淀事实: workspace=${state.workspaceSlug}, reason=${reason}`)
        }
      } catch (error) {
        console.warn('[Memory] 自动捕获抽取失败，本次不写入记忆:', error)
      } finally {
        this.bursts.delete(state.key)
      }
    })()
    state.flushing = run
    await run
  }
}
