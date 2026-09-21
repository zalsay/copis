import { expect, test } from 'bun:test'
import { runChatRoomQuitCleanup } from './lib/chatroom-lifecycle'

test('Given app quit When cleanup runs Then production helper enforces ordered phases and propagates failure', async () => {
  const order: string[] = []
  await runChatRoomQuitCleanup({
    stopChatRooms: async () => { order.push('coordinator.stopAll:app_quit') },
    stopAgents: async () => { order.push('agents.stopAll') },
    stopHttpApi: async () => { order.push('httpApi.stop') },
    disposeChatRooms: async () => { order.push('coordinator.dispose') },
  })
  expect(order).toEqual(['coordinator.stopAll:app_quit', 'agents.stopAll', 'httpApi.stop', 'coordinator.dispose'])
  await expect(runChatRoomQuitCleanup({ stopChatRooms: async () => { throw new Error('stop failed') }, stopAgents: async () => {}, stopHttpApi: async () => {}, disposeChatRooms: async () => {} })).rejects.toThrow('stop failed')
})
