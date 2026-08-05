import { atom } from 'jotai'
import type { FunctionalModuleName, FunctionalModuleProgressPayload, FunctionalModuleStatus } from '@copis/shared'

export const functionalModuleStatusesAtom = atom<Partial<Record<FunctionalModuleName, FunctionalModuleStatus>>>({})

export const functionalModuleProgressAtom = atom<Partial<Record<FunctionalModuleName, FunctionalModuleProgressPayload>>>({})

export const functionalModuleBusyAtom = atom<Partial<Record<FunctionalModuleName, boolean>>>({})
