import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { MemoryPolicy } from '@copis/shared'

/** Pi 运行中的长期记忆整理触发阈值。 */
export const PI_MEMORY_ORGANIZATION_THRESHOLD_TOKENS = 200_000

/** 用于在 Pi session 中标记一个已完成的整理周期；custom entry 不进入模型上下文。 */
export const PI_MEMORY_ORGANIZATION_CUSTOM_TYPE = 'copis_memory_organization'

export function shouldUsePiMemoryMaintenanceQueue(input: {
  memoryPolicy: MemoryPolicy | undefined
  hasRunner: boolean
}): boolean {
  return input.memoryPolicy === 'writable' && input.hasRunner
}

/** 按 Pi 的规则计算最近一次模型响应代表的上下文 token 数。 */
export function calculatePiContextTokens(message: AgentMessage): number | undefined {
  if (message.role !== 'assistant') return undefined
  const usage = message.usage
  const tokens = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite
  return Number.isFinite(tokens) && tokens > 0 ? tokens : undefined
}

/**
 * 判断当前 assistant turn 是否已经到达可以插入内部整理回合的安全边界。
 * 有工具结果时仍处于原始任务的工具链中，必须等到无工具的 assistant turn 再整理。
 */
export function shouldStartPiMemoryOrganization(options: {
  message: AgentMessage
  toolResultCount: number
  thresholdCrossed: boolean
  alreadyOrganizedSinceCompaction: boolean
  organizationScheduled: boolean
}): boolean {
  if (
    !options.thresholdCrossed
    || options.toolResultCount > 0
    || options.alreadyOrganizedSinceCompaction
    || options.organizationScheduled
    || options.message.role !== 'assistant'
    || options.message.stopReason === 'error'
    || options.message.stopReason === 'aborted'
  ) {
    return false
  }

  const hasToolCall = options.message.content.some((block) => block.type === 'toolCall')
  if (hasToolCall) return false

  const tokens = calculatePiContextTokens(options.message)
  return tokens !== undefined && tokens > PI_MEMORY_ORGANIZATION_THRESHOLD_TOKENS
}

/** 判断当前压缩周期是否已经完成过一次长期记忆整理。 */
export function hasPiMemoryOrganizationSinceLatestCompaction(entries: readonly SessionEntry[]): boolean {
  let organized = false
  for (const entry of entries) {
    if (entry.type === 'compaction') {
      organized = false
    } else if (entry.type === 'custom' && entry.customType === PI_MEMORY_ORGANIZATION_CUSTOM_TYPE) {
      organized = true
    }
  }
  return organized
}
