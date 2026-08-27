import { isAgentCompatibleProvider, isCopisWorkingChannelId, type Channel } from '@copis/shared'

/**
 * Pi runtime 可用渠道由「渠道已启用 + 协议兼容」派生。
 */
export function getEnabledAgentChannelIds(
  channels: readonly Pick<Channel, 'id' | 'enabled' | 'provider'>[],
): string[] {
  return channels
    .filter((channel) => channel.enabled && (
      isCopisWorkingChannelId(channel.id) || isAgentCompatibleProvider(channel.provider)
    ))
    .map((channel) => channel.id)
}
