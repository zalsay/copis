import type { MemoryPolicy } from '@copis/shared'

export type MemoryCapabilityProfile = 'default' | 'chatroom'

const MEMORY_TOOL_NAMES = {
  off: [],
  visible: ['memory_recall', 'memory_read'],
  writable: ['memory_recall', 'memory_read', 'memory_capture', 'memory_rewrite'],
} as const satisfies Record<MemoryPolicy, readonly string[]>

export function memoryToolNamesForPolicy(policy: MemoryPolicy): readonly string[] {
  return MEMORY_TOOL_NAMES[policy]
}

/** 聊天室必须显式开启只读 Memory；缺省或 writable 均 fail closed。 */
export function resolveMemoryPolicyForProfile(
  profile: MemoryCapabilityProfile | undefined,
  policy: MemoryPolicy | undefined,
): MemoryPolicy {
  if (profile === 'chatroom') return policy === 'visible' ? 'visible' : 'off'
  return policy ?? 'writable'
}
