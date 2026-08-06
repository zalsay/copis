import type { MemoryPolicy } from '@copis/shared'
import { runtimeMemoryApiClient as memoryApiClient } from './memory-api-client-runtime'

const DEFAULT_MEMORY_POLICY: MemoryPolicy = 'writable'

export interface MemoryContextBuildInput {
  workspaceSlug?: string
  userMessage: string
  policy?: MemoryPolicy
}

/** 追加受限的 Memory 参考上下文；服务不可用时不阻断原始 Agent 任务。 */
export async function appendMemoryContext(
  base: string,
  input: MemoryContextBuildInput,
): Promise<string> {
  const policy = input.policy ?? DEFAULT_MEMORY_POLICY
  if (policy === 'off' || !input.userMessage.trim()) return base

  try {
    const response = await memoryApiClient.context({
      ...(input.workspaceSlug ? { workspaceSlug: input.workspaceSlug } : {}),
      query: input.userMessage,
      maxChars: 6_000,
    })
    if (!response.text.trim()) return base
    return `${base}\n\n<copis_memory_context>\n${response.text}\n</copis_memory_context>`
  } catch (error) {
    console.warn('[Memory] 动态 context 加载失败，继续原始 Agent 任务:', error)
    return base
  }
}
