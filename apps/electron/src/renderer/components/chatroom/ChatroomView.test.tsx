import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./ChatroomView.tsx', import.meta.url), 'utf8')

describe('聊天室房间视图契约', () => {
  test('房间按 roomId 加载消息并使用成员面板', () => {
    expect(source).toContain('getMessages(roomId')
    expect(source).toContain('<ChatroomMembersPanel')
    expect(source).toContain('<ChatroomComposer')
  })
})
