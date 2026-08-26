import type { SDKAssistantMessage, SDKMessage, SDKTextBlock } from '@copis/shared'

export interface NextStepSuggestion {
  type?: 'summarize-workflow' | 'session-summary' | 'automation' | string
  title: string
  description?: string
  action?: string
}

interface NextStepsPayload {
  next_steps?: unknown[]
  nextSteps?: unknown[]
  suggestions?: unknown[]
}

function normalizeNextStep(item: unknown): NextStepSuggestion | null {
  if (!item || typeof item !== 'object') return null
  const record = item as Record<string, unknown>
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  if (!title) return null

  const type = typeof record.type === 'string' ? record.type.trim() : undefined
  const description = typeof record.description === 'string' ? record.description.trim() : undefined
  const action = typeof record.action === 'string' ? record.action.trim() : undefined

  return {
    title,
    ...(type ? { type } : {}),
    ...(description ? { description } : {}),
    ...(action ? { action } : {}),
  }
}

function parseJsonPayload(rawJson: string): NextStepSuggestion[] {
  try {
    const parsed = JSON.parse(rawJson) as unknown
    if (!parsed || typeof parsed !== 'object') return []

    let rawList: unknown[] = []
    if (Array.isArray(parsed)) {
      rawList = parsed
    } else {
      const payload = parsed as NextStepsPayload
      if (Array.isArray(payload.next_steps)) {
        rawList = payload.next_steps
      } else if (Array.isArray(payload.nextSteps)) {
        rawList = payload.nextSteps
      } else if (Array.isArray(payload.suggestions)) {
        rawList = payload.suggestions
      }
    }

    return rawList.map(normalizeNextStep).filter((item): item is NextStepSuggestion => item !== null)
  } catch {
    return []
  }
}

const NEXT_STEPS_FENCE_REGEX = /```(?:json:next-steps|json:next_steps|json:nextsteps)\s*\n([\s\S]*?)\n```/i
const GENERIC_JSON_FENCE_REGEX = /```(?:json)?\s*\n(\s*\{[\s\S]*?"(?:next_steps|nextSteps)"[\s\S]*?\})\s*\n```/i
const XML_TAG_REGEX = /<next_step_suggestions>([\s\S]*?)<\/next_step_suggestions>/i

/**
 * 从消息文本中解析下一步建议 (Next Steps)
 */
export function extractNextStepSuggestions(text: string): NextStepSuggestion[] {
  if (!text || typeof text !== 'string') return []

  // 1. 优先匹配专用 fenced block: ```json:next-steps ... ```
  const dedicatedMatch = text.match(NEXT_STEPS_FENCE_REGEX)
  if (dedicatedMatch?.[1]) {
    const list = parseJsonPayload(dedicatedMatch[1])
    if (list.length > 0) return list
  }

  // 2. 匹配 XML 标签: <next_step_suggestions> ... </next_step_suggestions>
  const xmlMatch = text.match(XML_TAG_REGEX)
  if (xmlMatch?.[1]) {
    const list = parseJsonPayload(xmlMatch[1])
    if (list.length > 0) return list
  }

  // 3. 兜底匹配包含 next_steps 的普通 json 代码块
  const genericMatch = text.match(GENERIC_JSON_FENCE_REGEX)
  if (genericMatch?.[1]) {
    const list = parseJsonPayload(genericMatch[1])
    if (list.length > 0) return list
  }

  return []
}

/**
 * 从助手文本中移除 next-steps 代码块，避免气泡内渲染原始 JSON 噪音
 */
export function stripNextStepsBlock(text: string): string {
  if (!text || typeof text !== 'string') return text

  return text
    .replace(NEXT_STEPS_FENCE_REGEX, '')
    .replace(XML_TAG_REGEX, '')
    .replace(GENERIC_JSON_FENCE_REGEX, '')
    .trimEnd()
}

/**
 * 从最新消息列表中提取最后一条已完成助手消息中的 Next Steps
 */
export function extractLatestAssistantNextSteps(messages: SDKMessage[]): NextStepSuggestion[] {
  if (!Array.isArray(messages) || messages.length === 0) return []

  // 找到最后一条有实质内容的消息
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (!msg) continue

    // 若最后一条有效消息是 user，说明用户已发送新消息，不应继续展示上轮建议
    if (msg.type === 'user') return []

    if (msg.type === 'assistant') {
      const assistantMsg = msg as SDKAssistantMessage
      const content = assistantMsg.message?.content
      if (!Array.isArray(content)) continue

      const fullText = content
        .filter((block): block is SDKTextBlock => block.type === 'text' && typeof (block as SDKTextBlock).text === 'string')
        .map((block) => block.text)
        .join('\n')

      const suggestions = extractNextStepSuggestions(fullText)
      if (suggestions.length > 0) return suggestions
      return []
    }
  }

  return []
}
