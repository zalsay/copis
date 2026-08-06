/**
 * App Mode Atom - 应用模式状态
 *
 * 旧版本曾包含 Chat 模式；当前运行时只允许 Agent。
 */

import { atomWithStorage } from 'jotai/utils'

export type AppMode = 'agent'

export function normalizeAppMode(_value: unknown): AppMode {
  return 'agent'
}

/** App 模式，自动持久化到 localStorage */
export const appModeAtom = atomWithStorage<AppMode>('copis-app-mode', 'agent')
