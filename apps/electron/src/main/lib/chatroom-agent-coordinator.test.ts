import { expect, test } from 'bun:test'

const coordinatorModule = await import('./chatroom-agent-coordinator')

test('Given Task 9 尚未注册协调器 When bridge 获取 Then 不创建默认实例并明确不可用', () => {
  expect(() => coordinatorModule.getChatRoomAgentCoordinator()).toThrow('聊天室协调器尚未注册')
})

test('Given 注册后替换协调器 When 旧 token 释放 Then 不得清理新实例', () => {
  const first = {
    handleInvocation: async () => 'accepted' as const,
    handleGatewayDisconnected: async () => {},
  }
  const second = {
    handleInvocation: async () => 'duplicate' as const,
    handleGatewayDisconnected: async () => {},
  }
  const releaseFirst = coordinatorModule.registerChatRoomAgentCoordinator(first)
  const releaseSecond = coordinatorModule.registerChatRoomAgentCoordinator(second)
  releaseFirst()
  expect(coordinatorModule.getChatRoomAgentCoordinator()).toBe(second)
  releaseSecond()
  expect(() => coordinatorModule.getChatRoomAgentCoordinator()).toThrow('聊天室协调器尚未注册')
})
