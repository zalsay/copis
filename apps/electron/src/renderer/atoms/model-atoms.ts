import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { Channel } from '@copis/shared'

/** 全局渠道列表缓存（启动时加载一次，设置变更时刷新）。 */
export const channelsAtom = atom<Channel[]>([])

/** 渠道列表是否已完成首次加载。 */
export const channelsLoadedAtom = atom(false)

export interface SelectedModel {
  channelId: string
  modelId: string
}

/** 全局默认模型，Agent、自动化和视觉助手共用。 */
export const selectedModelAtom = atomWithStorage<SelectedModel | null>(
  'copis-selected-model',
  null,
)

/** 供错误提示等外部入口拉起模型选择器。 */
export const modelSelectorOpenAtom = atom(false)
