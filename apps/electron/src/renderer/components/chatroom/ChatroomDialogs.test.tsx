import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('聊天室创建加入契约', () => {
  test('加入规范化大小写并校验四位分享码', () => {
    const source = readFileSync(new URL('./ChatroomJoinDialog.tsx', import.meta.url), 'utf8')
    expect(source).toContain("toUpperCase()")
    expect(source).toContain('/^[A-Z0-9]{4}$/')
    expect(source).toContain('openChatRoomTab')
  })
  test('创建最多配置三个 Agent，且创建后逐个 provision', () => {
    const source = readFileSync(new URL('./ChatroomCreateDialog.tsx', import.meta.url), 'utf8')
    expect(source).toContain('selected.length >= 3')
    expect(source).toContain('createRoom')
    expect(source).toContain('memorySharingEnabled: false')
    expect(source).toContain('skillSharingEnabled: false')
  })
})
