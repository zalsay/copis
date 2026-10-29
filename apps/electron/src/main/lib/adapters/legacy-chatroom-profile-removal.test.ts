import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const readAdapter = (name: string): string => readFileSync(join(import.meta.dir, name), 'utf8')

describe('旧聊天室 adapter 特例移除', () => {
  test('Given 普通 Agent adapters When 检查能力选择 Then 只保留通用 MemoryPolicy 与安全条件', () => {
    const piAdapter = readAdapter('pi-agent-adapter.ts')
    const builtinTools = readAdapter('pi-builtin-tools.ts')
    const memoryPolicy = readAdapter('memory-tool-policy.ts')
    const codexAdapter = readAdapter('codex-app-server-adapter.ts')
    const promptBuilder = readFileSync(join(import.meta.dir, '../agent-prompt-builder.ts'), 'utf8')
    const chromeCapability = readFileSync(join(import.meta.dir, '../chrome-desktop-capability.ts'), 'utf8')

    expect(piAdapter).not.toContain('capabilityProfile')
    expect(piAdapter).not.toContain('memoryWorkspaceSlug')
    expect(builtinTools).not.toContain('capabilityProfile')
    expect(builtinTools).not.toContain('resolveMemoryPolicyForProfile')
    expect(memoryPolicy).not.toContain('MemoryCapabilityProfile')
    expect(memoryPolicy).not.toContain('resolveMemoryPolicyForProfile')
    expect(codexAdapter).not.toContain("!== 'chatroom'")
    expect(promptBuilder).not.toContain('buildChatRoomPublicAgentRosterPrompt')
    expect(promptBuilder).not.toContain('聊天室结构化输出')
    expect(chromeCapability).not.toContain('isChatroomRun')

    for (const generalSafetyRule of [
      "currentPlatform !== 'darwin'",
      "options.triggeredBy !== 'user'",
      'options.isAutomationRun === true',
      'options.isDelegationRun === true',
      'options.isRemoteBotRun === true',
      'options.isPaymentRun === true',
      'options.isSessionProfessional === true',
      'options.imageInputSupported !== true',
    ]) {
      expect(chromeCapability).toContain(generalSafetyRule)
    }
  })
})
