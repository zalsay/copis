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
  const afterFailure: string[] = []
  await expect(runChatRoomQuitCleanup({ stopChatRooms: async () => { afterFailure.push('rooms'); throw new Error('stop failed') }, stopAgents: async () => { afterFailure.push('agents') }, stopHttpApi: async () => { afterFailure.push('http') }, disposeChatRooms: async () => { afterFailure.push('dispose') } })).rejects.toThrow('stop failed')
  expect(afterFailure).toEqual(['rooms', 'agents', 'http', 'dispose'])
})
