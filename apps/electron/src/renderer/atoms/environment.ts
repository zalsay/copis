/**
 * 环境检测状态管理
 *
 * 管理环境检测结果、运行时状态、下载态以及派生的 UI 判断。
 */

import { atom } from 'jotai'
import type {
  EnvironmentCheckResult,
  RuntimeStatus,
} from '@copis/shared'

/**
 * 环境检测结果 Atom
 * 存储最后一次环境检测的完整结果
 */
export const environmentCheckResultAtom = atom<EnvironmentCheckResult | null>(null)

/**
 * 运行时状态 Atom（包含 Windows Shell 检测结果）
 */
export const runtimeStatusAtom = atom<RuntimeStatus | null>(null)

/**
 * 是否正在检测环境 Atom
 */
export const isCheckingEnvironmentAtom = atom(false)

/**
 * 是否存在环境问题 Atom（派生，仅用于 macOS / 旧逻辑）
 */
export const hasEnvironmentIssuesAtom = atom((get) => {
  const result = get(environmentCheckResultAtom)
  if (!result) return false
  return result.hasIssues
})

/**
 * Windows Shell 环境是否可用（Git Bash 或 WSL 任一可用即 true）
 * 非 Windows 平台返回 true（无此门槛）
 */
export const isShellEnvironmentOkAtom = atom((get) => {
  const runtime = get(runtimeStatusAtom)
  if (!runtime) return true
  if (!runtime.shell) return true // 非 Windows
  return !!(runtime.shell.gitBash?.available || runtime.shell.wsl?.available)
})

/**
 * Node.js 是否可用（软需求，仅影响提示不阻塞）
 */
export const isNodeJsOkAtom = atom((get) => {
  const runtime = get(runtimeStatusAtom)
  if (!runtime) return true
  return !!runtime.node?.available
})

/**
 * 全局环境检测 Dialog 开关（错误卡片的「打开环境检测」按钮会置 true）
 */
export const environmentCheckDialogOpenAtom = atom(false)
