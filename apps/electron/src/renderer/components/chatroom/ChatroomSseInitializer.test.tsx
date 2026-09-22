import { describe, expect, test } from 'bun:test'
import { getChatRoomAccountKey } from './ChatroomSseInitializer'

describe('聊天室全局实时初始化账户边界', () => {
  test('未登录与不同账号使用不同的房间订阅边界', () => {
    expect(getChatRoomAccountKey(null)).toBe('anonymous')
    expect(getChatRoomAccountKey({ authenticated: false })).toBe('anonymous')
    expect(getChatRoomAccountKey({ authenticated: true, user: { id: 'account-a' } })).toBe('authenticated:account-a')
    expect(getChatRoomAccountKey({ authenticated: true, user: { id: 'account-b' } })).not.toBe('authenticated:account-a')
  })
})
