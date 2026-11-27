import {
  BUILTIN_CHANNEL_DEFINITIONS, COPIS_WORKING_DEEPSEEK_CHANNEL_ID,
  getCopisWorkingModelDisplayName, isWorkingCustomModelChannelId, workingModelCatalogToOptions,
  type DshRoomModelCatalog, type DshRoomModelSelection, type WorkingCustomModel,
} from '@copis/shared'
import { getSettings } from '../settings-service'
import { getWorkingApiClient } from '../working-api-service'
import { getWorkingTokenStore } from '../working-auth-store'
import { getWorkingModelCatalog } from '../working-model-catalog'

import { nativeRoomModels, RoomModelError, supportsRoomEndpoint } from './shared-room-native-models'
export { RoomModelError }

export function assertRoomModelOwner(userId: string) {
  if (typeof userId !== 'string' || !userId || userId !== userId.trim() ||
      String(getWorkingApiClient().getCachedUser()?.id ?? '') !== userId ||
      String(getWorkingTokenStore().getUser()?.id ?? '') !== userId) {
    throw new RoomModelError('共享已撤回或群主账号已切换')
  }
}

/** Copis 账号模型目录目前支持两种协议，不接受在地址里携带凭据或查询参数。 */
export function supportsRoomCustomModel(model: WorkingCustomModel): boolean {
  return (model.protocol === 'openai-responses' || model.protocol === 'anthropic-messages') && supportsRoomEndpoint(model.protocol, model.baseUrl)
}

function readOptions(userId: string): DshRoomModelCatalog['options'] {
  const builtins = Object.entries(BUILTIN_CHANNEL_DEFINITIONS.groups).flatMap(([channelId, group]) =>
    group.models.map(({ id: modelId, name }) => ({ channelId, modelId, name: getCopisWorkingModelDisplayName(channelId, modelId, name) })))
  const catalog = getWorkingModelCatalog(true, userId)
  const custom = workingModelCatalogToOptions({ ...catalog, models: catalog.models.filter(supportsRoomCustomModel) })
  return [...builtins, ...custom.map(({ channelId, modelId, modelName }) => ({ channelId, modelId, name: modelName })),
    ...nativeRoomModels(userId, catalog.models).map(({channelId, modelId, name}) => ({channelId, modelId, name}))]
}

/** 目录枚举不解密或探测模型。只有打开会话才验证所选凭据及已安装适配器。 */
export function getRoomModelCatalog(userId: string, effective?: DshRoomModelSelection): DshRoomModelCatalog {
  try {
    assertRoomModelOwner(userId)
    const options = readOptions(userId)
    let selected: DshRoomModelSelection | undefined
    if (effective !== undefined) {
      // 必须精确匹配两个字段，失效的覆盖不能被默认模型冒充。
      selected = options.find(o => o.channelId === effective?.channelId && o.modelId === effective?.modelId)
    } else {
      const { agentChannelId, agentModelId } = getSettings()
      const channelId = agentChannelId ?? COPIS_WORKING_DEEPSEEK_CHANNEL_ID
      // 原 runtime 对自定义渠道把空字符串也视为未指定，内置渠道仅接受 nullish 缺省。
      const first = agentModelId == null || (agentModelId === '' && isWorkingCustomModelChannelId(channelId))
      selected = options.find(o => o.channelId === channelId && (first || o.modelId === agentModelId))
    }
    // 失效时仍提供可选项，但不声称任何模型已生效。
    return { current: selected ? { channelId: selected.channelId, modelId: selected.modelId } : null, options }
  } catch (error) {
    if (error instanceof RoomModelError) throw error
    throw new RoomModelError('无法读取群主的模型配置')
  }
}
