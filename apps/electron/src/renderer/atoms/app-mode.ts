/**
 * App Mode Atom - 应用模式状态
 *
 * 模式：
 * - 'agent': 标准智能体模式（Pi runtime 底座，多标签页，对话与工具）
 * - 'creation': 创造模式（DSH Cordis Web 底座，全 Web 自更新与 HMR）
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { DshCordisStatus } from '@copis/shared'
import { agentRuntimeAtom } from './agent-atoms'

export type AppMode = 'agent' | 'creation'

export function normalizeAppMode(value: unknown): AppMode {
  if (value === 'creation' || value === 'dsh' || value === 'ptc') {
    return 'creation'
  }
  return 'agent'
}

/** App 模式，自动持久化到 localStorage */
export const appModeAtom = atomWithStorage<AppMode>('copis-app-mode', 'agent')

/** 创造模式进入确认弹窗：是否勾选了“下次不再提醒”，自动持久化到 localStorage */
export const creationModeSkipConfirmAtom = atomWithStorage<boolean>(
  'copis-creation-mode-skip-confirm',
  false,
)

/** DSH Cordis 创造模式服务状态 */
export const dshCordisStatusAtom = atom<DshCordisStatus>({
  running: false,
})

/** 模式切换与 Runtime 同步写 atom */
export const setAppModeAndRuntimeAtom = atom(
  null,
  (_get, set, nextMode: AppMode) => {
    const normalized = normalizeAppMode(nextMode)
    set(appModeAtom, normalized)
    if (normalized === 'creation') {
      set(agentRuntimeAtom, 'dsh')
    } else {
      set(agentRuntimeAtom, 'pi')
    }
    if (typeof window !== 'undefined' && window.electronAPI?.updateSettings) {
      window.electronAPI.updateSettings({ appMode: normalized }).catch(console.error)
    }
  },
)
