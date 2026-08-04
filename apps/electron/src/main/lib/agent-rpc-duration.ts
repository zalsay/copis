import type { SDKMessage } from '@copis/shared'

export function attachAgentRunDuration(
  message: SDKMessage,
  startedAt: number,
  finishedAt: number,
): SDKMessage {
  if (message.type !== 'result') return message
  return {
    ...message,
    _durationMs: Math.max(0, finishedAt - startedAt),
  } as unknown as SDKMessage
}
