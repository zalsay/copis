/**
 * Professional Mode Atoms - 专业模式（Codex Harness）状态管理
 *
 * 统一管理专业模式开关状态、Codex App Server 运行状态与双向切换动作。
 */

import { atom } from 'jotai'
import type { CodexAppServerStatus } from '@/types/settings'
import {
  COPIS_WORKING_CHANNEL_ID,
  COPIS_WORKING_FAST_MODEL_ID,
  COPIS_WORKING_GLOBAL_MODEL_ID,
  isCopisWorkingChannelId,
  isWorkingCustomModelChannelId,
} from '@copis/shared'
import { selectedModelAtom } from './model-atoms'
import { agentChannelIdAtom, agentModelIdAtom } from './agent-atoms'

/** 专业模式开启状态（与 settings 同步） */
export const professionalModeAtom = atom<boolean>(false)

/** Codex App Server 实时运行状态 */
export const codexAppServerStatusAtom = atom<CodexAppServerStatus>({
  running: false,
})

/**
 * 双向切换专业模式 Action
 *
 * - 乐观更新 professionalModeAtom
 * - 写入持久化设置
 * - 启动或停止 Codex App Server
 * - 若开启专业模式时当前模型为不支持的第三方 Provider 或通识模型 (global)，自动安全回退至 Copis 快速模型 (fast)
 */
export const toggleProfessionalModeAtom = atom(
  (get) => get(professionalModeAtom),
  async (get, set, enable?: boolean) => {
    const current = get(professionalModeAtom)
    const next = enable !== undefined ? enable : !current
    set(professionalModeAtom, next)

    try {
      if (next) {
        const status = await window.electronAPI.startCodexAppServer()
        set(codexAppServerStatusAtom, status)

        // 校验当前选中模型，若属于被过滤的第三方渠道或 global 模型，自动回退到 Copis 快速模型
        const selected = get(selectedModelAtom)
        if (selected) {
          const isCopisDefault = selected.channelId === COPIS_WORKING_CHANNEL_ID && selected.modelId !== COPIS_WORKING_GLOBAL_MODEL_ID
          const isCustom = isWorkingCustomModelChannelId(selected.channelId)
          if (!isCopisDefault && !isCustom) {
            set(selectedModelAtom, {
              channelId: COPIS_WORKING_CHANNEL_ID,
              modelId: COPIS_WORKING_FAST_MODEL_ID,
            })
          }
        }

        const agentChannelId = get(agentChannelIdAtom)
        const isAgentChannelCopisDefault = agentChannelId === COPIS_WORKING_CHANNEL_ID
        const isAgentChannelCustom = isWorkingCustomModelChannelId(agentChannelId ?? '')
        if (!isAgentChannelCopisDefault && !isAgentChannelCustom) {
          set(agentChannelIdAtom, COPIS_WORKING_CHANNEL_ID)
          set(agentModelIdAtom, COPIS_WORKING_FAST_MODEL_ID)
        } else if (isAgentChannelCopisDefault) {
          const agentModelId = get(agentModelIdAtom)
          if (!agentModelId || agentModelId === COPIS_WORKING_GLOBAL_MODEL_ID) {
            set(agentModelIdAtom, COPIS_WORKING_FAST_MODEL_ID)
          }
        }
      } else {
        await window.electronAPI.stopCodexAppServer()
        set(codexAppServerStatusAtom, { running: false })
      }
      await window.electronAPI.updateSettings({ professionalMode: next })
      return next
    } catch (error) {
      console.error('[专业模式] 切换状态失败:', error)
      // 回滚状态
      set(professionalModeAtom, current)
      throw error
    }
  },
)
