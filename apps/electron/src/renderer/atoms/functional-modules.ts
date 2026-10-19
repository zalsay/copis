import { atom } from 'jotai'
import type {
  FunctionalModuleName,
  FunctionalModuleProgressPayload,
  FunctionalModuleStartupProgressPayload,
  FunctionalModuleStatus,
} from '@copis/shared'

export const functionalModuleStatusesAtom = atom<Partial<Record<FunctionalModuleName, FunctionalModuleStatus>>>({})

export const functionalModuleProgressAtom = atom<Partial<Record<FunctionalModuleName, FunctionalModuleProgressPayload>>>({})

export const functionalModuleBusyAtom = atom<Partial<Record<FunctionalModuleName, boolean>>>({})

/** 批量检查跨设置页挂载周期保留，避免离开后重进重复发起检查。 */
export const functionalModuleCheckingAllAtom = atom(false)

export type FunctionalModuleStartupState = Omit<FunctionalModuleStartupProgressPayload, 'error'> & {
  error: string | null
}

export const functionalModuleStartupAtom = atom<FunctionalModuleStartupState>({
  phase: 'checking',
  detail: '正在检查必要组件',
  progress: 0,
  error: null,
})
