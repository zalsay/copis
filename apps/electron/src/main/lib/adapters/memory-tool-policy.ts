import type { MemoryPolicy } from '@copis/shared'

const MEMORY_TOOL_NAMES = {
  off: [],
  visible: ['memory_recall', 'memory_read'],
  writable: ['memory_recall', 'memory_read', 'memory_capture', 'memory_rewrite'],
} as const satisfies Record<MemoryPolicy, readonly string[]>

export function memoryToolNamesForPolicy(policy: MemoryPolicy): readonly string[] {
  return MEMORY_TOOL_NAMES[policy]
}
