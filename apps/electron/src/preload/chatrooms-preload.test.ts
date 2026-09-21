import { expect, test } from 'bun:test'
import { CHATROOM_IPC_CHANNELS, type ChatRoomElectronAPI } from '@copis/shared'

test('Given shared preload contract When enumerating chatroom API Then only local management methods exist', () => {
  const expected: Array<keyof ChatRoomElectronAPI> = ['listLocalRooms', 'provisionAgent', 'updateAgent', 'removeAgent', 'syncAgentSkills', 'respondPermission', 'onPermissionRequested', 'onLocalConfigChanged']
  expect(expected).toHaveLength(Object.keys(CHATROOM_IPC_CHANNELS).length)
  expect(expected).not.toContain('trustedRuntimeContext' as keyof ChatRoomElectronAPI)
})

test('Given listener registration implementation When unsubscribing Then channel names are stable', () => {
  expect(CHATROOM_IPC_CHANNELS.PERMISSION_REQUESTED).toBe('chatrooms:permission-requested')
  expect(CHATROOM_IPC_CHANNELS.LOCAL_CONFIG_CHANGED).toBe('chatrooms:local-config-changed')
})
