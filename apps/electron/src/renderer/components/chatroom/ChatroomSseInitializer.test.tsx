import { describe, expect, test } from 'bun:test'
import { getChatRoomAccountKey, shouldSubscribeChatRoomRooms } from './ChatroomSseInitializer'

describe('聊天室全局实时初始化账户边界', () => {
  test('未登录与不同账号使用不同的房间订阅边界', () => {
    expect(getChatRoomAccountKey(null)).toBe('anonymous')
    expect(getChatRoomAccountKey({ authenticated: false, user: null, backendUrl: 'http://test' })).toBe('anonymous')
    expect(getChatRoomAccountKey({ authenticated: true, user: { id: 'account-a' }, backendUrl: 'http://test' })).toBe('authenticated:account-a')
    expect(getChatRoomAccountKey({ authenticated: true, user: { id: 'account-b' }, backendUrl: 'http://test' })).not.toBe('authenticated:account-a')
  })
  test('账号切换后的首个 rooms effect 不会把旧账号房间交给新连接', () => {
    expect(shouldSubscribeChatRoomRooms('authenticated:account-b', undefined)).toBe(false)
    expect(shouldSubscribeChatRoomRooms('authenticated:account-b', 'authenticated:account-b')).toBe(true)
    expect(shouldSubscribeChatRoomRooms('anonymous', 'authenticated:account-a')).toBe(false)
  })
})
