/**
 * 工作区开发项目固定状态管理
 *
 * 右侧项目列表的图钉与左侧边栏「我的项目」分组共享同一份固定数据，
 * 点击图钉后两侧即时同步。
 */

import { atom } from 'jotai'

/** 固定到「我的项目」的开发项目路径，按工作区 slug 分组 */
export const pinnedDevProjectsAtom = atom<Record<string, string[]>>({})

/**
 * 从主进程加载固定项目设置
 */
export async function initializePinnedDevProjects(
  setPinnedDevProjects: (value: Record<string, string[]>) => void,
): Promise<void> {
  try {
    const settings = await window.electronAPI.getSettings()
    const value = settings.pinnedDevProjects
    setPinnedDevProjects(Array.isArray(value) ? {} : value ?? {})
  } catch (error) {
    console.error('[固定项目] 初始化失败:', error)
  }
}

/**
 * 切换指定工作区项目的固定状态并持久化
 *
 * 先乐观更新原子状态，持久化失败时回滚并抛出错误。
 */
export async function togglePinnedDevProject(
  setPinnedDevProjects: (value: Record<string, string[]>) => void,
  current: Record<string, string[]>,
  workspaceSlug: string,
  projectPath: string,
): Promise<void> {
  const currentList = current[workspaceSlug] ?? []
  const nextList = currentList.includes(projectPath)
    ? currentList.filter((path) => path !== projectPath)
    : [...currentList, projectPath]
  const next = { ...current, [workspaceSlug]: nextList }
  setPinnedDevProjects(next)
  try {
    await window.electronAPI.updateSettings({ pinnedDevProjects: next })
  } catch (error) {
    setPinnedDevProjects(current)
    throw error
  }
}
