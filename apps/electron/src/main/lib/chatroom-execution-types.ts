/** Main/Rust 私有 socket 来源戳；不进入 shared DTO、IPC 或 Renderer。 */
export interface ChatRoomGatewayOrigin {
  clientGeneration: number
  socketGeneration: number
  authEpoch: number
}

export interface ChatRoomTrustedInvocationEnvelope {
  invocation: import('@copis/shared').ChatRoomAgentInvocation
  gatewayOrigin: ChatRoomGatewayOrigin
}

export interface ChatRoomExecutionBindingInput extends ChatRoomTrustedInvocationEnvelope {
  targetAgentId: string
  sessionId: string
  workerRunId: string
}

export type ChatRoomTrustedFailureResult = 'handled' | 'ignored' | 'retry'
