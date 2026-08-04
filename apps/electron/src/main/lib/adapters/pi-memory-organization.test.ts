import { describe, expect, test } from 'bun:test'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import {
  calculatePiContextTokens,
  hasPiMemoryOrganizationSinceLatestCompaction,
  PI_MEMORY_ORGANIZATION_THRESHOLD_TOKENS,
  shouldStartPiMemoryOrganization,
} from './pi-memory-organization'

function assistantMessage(overrides: Partial<Extract<AgentMessage, { role: 'assistant' }>> = {}): Extract<AgentMessage, { role: 'assistant' }> {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: '完成' }],
    api: 'openai-completions',
    provider: 'test',
    model: 'test-model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
    ...overrides,
  }
}

function customEntry(customType: string, id: string): SessionEntry {
  return {
    type: 'custom',
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    customType,
  }
}

function compactionEntry(id: string): SessionEntry {
  return {
    type: 'compaction',
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    summary: '压缩摘要',
    firstKeptEntryId: 'entry-1',
    tokensBefore: PI_MEMORY_ORGANIZATION_THRESHOLD_TOKENS + 1,
  }
}

describe('Pi 自动记忆整理阈值', () => {
  test('Given usage.totalTokens 缺失 When 使用分项 usage Then 使用 Pi 兼容的回退计算', () => {
    const message = assistantMessage({
      usage: {
        input: 190_000,
        output: 5_000,
        cacheRead: 10_000,
        cacheWrite: 1_000,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    })

    expect(calculatePiContextTokens(message)).toBe(206_000)
  })

  test('Given上下文正好 200k When 判断整理 Then 不触发', () => {
    const message = assistantMessage({
      usage: { ...assistantMessage().usage, totalTokens: PI_MEMORY_ORGANIZATION_THRESHOLD_TOKENS },
    })

    expect(shouldStartPiMemoryOrganization({
      message,
      toolResultCount: 0,
      thresholdCrossed: true,
      alreadyOrganizedSinceCompaction: false,
      organizationScheduled: false,
    })).toBe(false)
  })

  test('Given无工具的 assistant turn 超过 200k When 判断整理 Then 触发一次', () => {
    const message = assistantMessage({
      usage: { ...assistantMessage().usage, totalTokens: PI_MEMORY_ORGANIZATION_THRESHOLD_TOKENS + 1 },
    })

    expect(shouldStartPiMemoryOrganization({
      message,
      toolResultCount: 0,
      thresholdCrossed: true,
      alreadyOrganizedSinceCompaction: false,
      organizationScheduled: false,
    })).toBe(true)
  })

  test('Given当前仍有工具结果或已经整理过 When 判断整理 Then 不打断原任务且不重复触发', () => {
    const message = assistantMessage({
      usage: { ...assistantMessage().usage, totalTokens: PI_MEMORY_ORGANIZATION_THRESHOLD_TOKENS + 1 },
    })

    expect(shouldStartPiMemoryOrganization({
      message,
      toolResultCount: 1,
      thresholdCrossed: true,
      alreadyOrganizedSinceCompaction: false,
      organizationScheduled: false,
    })).toBe(false)
    expect(shouldStartPiMemoryOrganization({
      message,
      toolResultCount: 0,
      thresholdCrossed: true,
      alreadyOrganizedSinceCompaction: true,
      organizationScheduled: false,
    })).toBe(false)
  })
})

describe('Pi 自动记忆整理周期 marker', () => {
  test('Given已有整理 marker When没有新的压缩 Then认为当前周期已整理', () => {
    expect(hasPiMemoryOrganizationSinceLatestCompaction([
      customEntry('copis_memory_organization', 'marker-1'),
    ])).toBe(true)
  })

  test('Given整理 marker 后发生压缩 When检查当前周期 Then允许下一次整理', () => {
    expect(hasPiMemoryOrganizationSinceLatestCompaction([
      customEntry('copis_memory_organization', 'marker-1'),
      compactionEntry('compaction-1'),
    ])).toBe(false)
  })
})
