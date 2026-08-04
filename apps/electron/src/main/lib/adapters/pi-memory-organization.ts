import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'

/** Pi 运行中的长期记忆整理触发阈值。 */
export const PI_MEMORY_ORGANIZATION_THRESHOLD_TOKENS = 200_000

/** 用于在 Pi session 中标记一个已完成的整理周期；custom entry 不进入模型上下文。 */
export const PI_MEMORY_ORGANIZATION_CUSTOM_TYPE = 'copis_memory_organization'

/**
 * 这是隐藏的内部回合：它只负责把当前会话中已经确认、可复用的信息沉淀到
 * Copis Memory，不继续执行原始任务，也不把临时过程写成长期开销。
 */
export const PI_MEMORY_ORGANIZATION_PROMPT = `<copis_memory_organization>
这是 Copis 的系统内部维护回合。当前会话上下文 token 已超过 200,000，请现在只整理长期记忆，不继续执行原始用户任务。

执行规则：
1. 先用 memory_recall 检索当前工作区和用户记忆，再用 memory_read 读取可能相关的完整条目。
2. 从当前会话中挑选真正稳定、可复用、对未来判断有帮助的事实、决策、项目经验或明确用户偏好。
3. 已有等价记忆不要重复创建；已有记忆被纠正或演进时，使用 memory_rewrite，并携带 memory_read 返回的 expectedRevision。
4. 只有证据足够时才使用 memory_capture；临时步骤、一次性结果、长文档正文、文件路径、聊天流水账和“上下文已压缩”本身不要写入 Memory。
5. memory_capture 只能写入当前工作区；没有当前工作区或没有值得沉淀的内容时，不要强行创建条目。
6. 完成整理后只返回简短的内部状态，不要回答原始用户问题。
</copis_memory_organization>`

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
