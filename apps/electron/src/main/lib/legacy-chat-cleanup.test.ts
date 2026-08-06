import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupLegacyChatData } from './legacy-chat-cleanup'

describe('legacy Chat 数据清理', () => {
  test('删除旧 Chat 索引、消息和按旧 conversation ID 归属的附件', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'copis-chat-cleanup-'))
    writeFileSync(join(configDir, 'conversations.json'), JSON.stringify({
      version: 1,
      conversations: [{ id: 'legacy-1' }, { id: 'legacy-2' }],
    }))
    mkdirSync(join(configDir, 'conversations'), { recursive: true })
    writeFileSync(join(configDir, 'conversations', 'legacy-1.jsonl'), '{}\n')
    mkdirSync(join(configDir, 'attachments', 'legacy-1'), { recursive: true })
    mkdirSync(join(configDir, 'attachments', 'agent-session-1'), { recursive: true })
    mkdirSync(join(configDir, 'agent-sessions'), { recursive: true })
    writeFileSync(join(configDir, 'agent-sessions', 'agent-session-1.jsonl'), '{}\n')

    const result = cleanupLegacyChatData(configDir)

    expect(result.conversationIds).toEqual(['legacy-1', 'legacy-2'])
    expect(existsSync(join(configDir, 'conversations.json'))).toBe(false)
    expect(existsSync(join(configDir, 'conversations'))).toBe(false)
    expect(existsSync(join(configDir, 'attachments', 'legacy-1'))).toBe(false)
    expect(existsSync(join(configDir, 'attachments', 'agent-session-1'))).toBe(true)
    expect(existsSync(join(configDir, 'agent-sessions', 'agent-session-1.jsonl'))).toBe(true)
  })

  test('没有旧数据和重复执行都正常通过', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'copis-chat-cleanup-'))
    expect(() => cleanupLegacyChatData(configDir)).not.toThrow()
    expect(() => cleanupLegacyChatData(configDir)).not.toThrow()
  })
})
