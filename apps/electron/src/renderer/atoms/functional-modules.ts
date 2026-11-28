import { atom } from 'jotai'
import type {
  FunctionalModuleName,
  FunctionalModuleProgressPayload,
  FunctionalModuleStartupProgressPayload,
  FunctionalModuleStatus,
} from '@copis/shared'

type FunctionalModuleStatuses = Partial<Record<FunctionalModuleName, FunctionalModuleStatus>>

export const functionalModuleStatusesAtom = atom<FunctionalModuleStatuses>({})

/** 本机列表刷新时保留同一个已安装版本的远端检查结果。 */
export function mergeLocalFunctionalModuleStatuses(
  current: FunctionalModuleStatuses,
  modules: FunctionalModuleStatus[],
): FunctionalModuleStatuses {
  const merged = { ...current }
  for (const status of modules) {
    const previous = current[status.name]
    const sameInstallation = previous && previous.version === status.version && previous.path === status.path
      && previous.installed === status.installed && previous.localIssue === status.localIssue
    merged[status.name] = sameInstallation && status.availableVersion === null
      ? { ...status, availableVersion: previous.availableVersion, updateAvailable: previous.updateAvailable, updateError: previous.updateError }
      : status
  }
  return merged
}

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
