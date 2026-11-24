import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { DshCordisStatus } from '@copis/shared'
import { agentRuntimeAtom } from './agent-atoms'

export type AppMode = 'agent' | 'creation'

export function normalizeAppMode(_value: unknown): AppMode {
  return 'creation'
}

const storedAppModeAtom = atomWithStorage<AppMode>('copis-app-mode', 'creation')
/** 旧配置及旧调用均不能切回标准 Agent 前端。 */
export const appModeAtom = atom(
  (get) => normalizeAppMode(get(storedAppModeAtom)),
  (_get, set, value: AppMode) => set(storedAppModeAtom, normalizeAppMode(value)),
)

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
    set(agentRuntimeAtom, 'dsh')
    if (typeof window !== 'undefined' && window.electronAPI?.updateSettings) {
      window.electronAPI.updateSettings({ appMode: normalized }).catch(console.error)
    }
  },
)
