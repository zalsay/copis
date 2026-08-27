import {
  ZHIPU_COMPOSER_GROUP_NAME,
  withDefaultProviderModels,
} from '@copis/shared'
import type { Channel, ModelOption, ProviderType } from '@copis/shared'

interface BuildModelOptionsOptions {
  /** 在已有渠道 ID 过滤条件下额外允许展示的供应商。 */
  includeProviders?: readonly ProviderType[]
  /** Composer 使用产品约定的供应商分组名。 */
  useComposerProviderLabels?: boolean
}

/** 从渠道列表构建扁平化的模型选项。 */
export function buildModelOptions(
  channels: Channel[],
  filterChannelId?: string,
  filterChannelIds?: string[],
  excludedProviders?: readonly ProviderType[],
  buildOptions: BuildModelOptionsOptions = {},
): ModelOption[] {
  const options: ModelOption[] = []

  for (const channel of channels) {
    if (!channel.enabled) continue
    if (filterChannelId && channel.id !== filterChannelId) continue
    if (
      filterChannelIds
      && !filterChannelIds.includes(channel.id)
      && !buildOptions.includeProviders?.includes(channel.provider)
    ) continue
    if (excludedProviders?.includes(channel.provider)) continue

    const channelName = buildOptions.useComposerProviderLabels && channel.provider === 'zhipu'
      ? ZHIPU_COMPOSER_GROUP_NAME
      : channel.name
    for (const model of withDefaultProviderModels(channel.provider, channel.models)) {
      if (!model.enabled) continue

      options.push({
        channelId: channel.id,
        channelName,
        modelId: model.id,
        modelName: model.name,
        provider: channel.provider,
      })
    }
  }

  return options
}
