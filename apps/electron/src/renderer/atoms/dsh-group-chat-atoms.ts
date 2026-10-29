/**
 * DSH 群聊协作全局 Jotai 状态树（DSH Group Chat Atoms）
 * 
 * 严格遵守零交叉原则：
 * - 独立于 chatroom-atoms.ts，仅服务于 DSH 群聊
 * - 提供细粒度响应式状态管理（群列表、消息流、任务看板、执行下钻）
 */

import { atom } from 'jotai'
import type {
  DshGroupChatSummary,
  DshGroupChatDetail,
  DshGroupChatMessage,
  DshGroupTaskBoard,
  DshGroupInvocation,
  DshAvailableModelGroup,
} from '@copis/shared'

// 群聊列表与加载状态
export const dshGroupListAtom = atom<DshGroupChatSummary[]>([])
export const dshGroupListLoadingAtom = atom<boolean>(false)

// 当前激活的群聊 ID 与详细信息
export const dshActiveGroupIdAtom = atom<string | null>(null)
export const dshActiveGroupDetailAtom = atom<DshGroupChatDetail | null>(null)

// 按群隔离的消息流缓存 Map: groupId -> DshGroupChatMessage[]
export const dshMessagesMapAtom = atom<Record<string, DshGroupChatMessage[]>>({})

// 获取当前激活群消息的派生 Atom
export const dshActiveMessagesAtom = atom<DshGroupChatMessage[]>((get) => {
  const activeGroupId = get(dshActiveGroupIdAtom)
  if (!activeGroupId) return []
  const map = get(dshMessagesMapAtom)
  return map[activeGroupId] || []
})

// 按群隔离的任务看板缓存 Map: groupId -> DshGroupTaskBoard
export const dshTasksMapAtom = atom<Record<string, DshGroupTaskBoard>>({})

// 获取当前激活群看板的派生 Atom
export const dshActiveTaskBoardAtom = atom<DshGroupTaskBoard | null>((get) => {
  const activeGroupId = get(dshActiveGroupIdAtom)
  if (!activeGroupId) return null
  const map = get(dshTasksMapAtom)
  return map[activeGroupId] || null
})

// 右侧协作抽屉类型
export type DshGroupDrawerType = 'none' | 'tasks' | 'invocation' | 'members' | 'records' | 'agents'
export const dshActiveDrawerAtom = atom<DshGroupDrawerType>('none')

// 默认兜底可用模型列表（保障无网络或冷启动下拉框立即可选）
export const DSH_DEFAULT_AVAILABLE_MODELS: DshAvailableModelGroup[] = [
  {
    channelId: 'copis-working-deepseek',
    channelName: 'DeepSeek',
    models: [
      { id: 'deepseek-v4-flash', name: '快速 (v4 Flash)' },
      { id: 'deepseek-v4-pro', name: '专业 (v4 Pro)' },
    ],
  },
]

// 可用模型列表缓存（默认包含 DeepSeek 兜底，后续由后端 IPC 异步刷新）
export const dshAvailableModelsAtom = atom<DshAvailableModelGroup[]>(DSH_DEFAULT_AVAILABLE_MODELS)

// 当前下钻查看的执行轨迹 ID 与详情
export const dshActiveInvocationIdAtom = atom<string | null>(null)
export const dshActiveInvocationAtom = atom<DshGroupInvocation | null>(null)

// 对话框开关状态
export const dshCreateGroupDialogOpenAtom = atom<boolean>(false)
export const dshAgentSelectionDialogOpenAtom = atom<boolean>(false)

// 引用回复暂存状态
export interface DshPendingQuote {
  messageId: string
  authorName: string
  text: string
}
export const dshPendingQuoteAtom = atom<DshPendingQuote | null>(null)
