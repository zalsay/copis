export async function runChatRoomQuitCleanup(input: {
  stopChatRooms: () => Promise<void>
  stopAgents: () => Promise<void>
  stopHttpApi: () => Promise<void>
  disposeChatRooms: () => Promise<void>
}): Promise<void> {
  await input.stopChatRooms()
  await input.stopAgents()
  await input.stopHttpApi()
  await input.disposeChatRooms()
}
