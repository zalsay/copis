export async function runChatRoomQuitCleanup(input: {
  stopChatRooms: () => Promise<void>
  stopAgents: () => Promise<void>
  stopHttpApi: () => Promise<void>
  disposeChatRooms: () => Promise<void>
}): Promise<void> {
  let firstError: unknown
  for (const phase of [input.stopChatRooms, input.stopAgents, input.stopHttpApi, input.disposeChatRooms]) {
    try { await phase() } catch (error) { firstError ??= error }
  }
  if (firstError) throw firstError
}
