import type { ProviderType } from './channel'

/** 模型选择器使用的扁平化渠道和模型组合。 */
export interface ModelOption {
  channelId: string
  channelName: string
  modelId: string
  modelName: string
  provider: ProviderType
}
