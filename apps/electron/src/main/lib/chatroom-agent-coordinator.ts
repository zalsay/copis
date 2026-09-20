import type { ChatRoomAgentInvocation } from '@copis/shared'

/** Task 7 的最小注册接缝；Task 9 将在此模块中实现真正的协调器。 */
export interface ChatRoomAgentCoordinatorFacade {
  handleInvocation(input: ChatRoomAgentInvocation): Promise<'accepted' | 'duplicate'>
  handleGatewayDisconnected(): Promise<void>
}

let registeredCoordinator: ChatRoomAgentCoordinatorFacade | undefined
let registrationToken = 0

/** 由应用生命周期在 Task 9 初始化时注册；此处不创建默认实例。 */
export function registerChatRoomAgentCoordinator(
  coordinator: ChatRoomAgentCoordinatorFacade,
): () => void {
  const token = ++registrationToken
  registeredCoordinator = coordinator
  return () => {
    if (registrationToken === token && registeredCoordinator === coordinator) {
      registeredCoordinator = undefined
    }
  }
}

export function getChatRoomAgentCoordinator(): ChatRoomAgentCoordinatorFacade {
  if (!registeredCoordinator) throw new Error('聊天室协调器尚未注册')
  return registeredCoordinator
}
