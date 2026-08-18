/**
 * Composer 自定义模型配置状态
 *
 * 配置由 VIP 用户在 Working 设置面板维护，持久化到 working-model-catalog.json；
 * WelcomeComposer 通过该 atom 读取并按分类展示。
 */

import { atom } from 'jotai'
import { EMPTY_WORKING_MODEL_CATALOG } from '@copis/shared'
import type { WorkingModelCatalog, WorkingModelCatalogSaveInput } from '@copis/shared'

export const workingModelCatalogAtom = atom<WorkingModelCatalog>(EMPTY_WORKING_MODEL_CATALOG)

let catalogLoadPromise: Promise<WorkingModelCatalog> | null = null
let catalogLoadGeneration = 0

function fetchWorkingModelCatalog(): Promise<WorkingModelCatalog> {
  if (!catalogLoadPromise) {
    catalogLoadPromise = window.electronAPI.getWorkingModelCatalog().catch((error: unknown) => {
      catalogLoadPromise = null
      throw error
    })
  }
  return catalogLoadPromise
}

/** 从主进程加载模型管理配置；加载失败时保留空配置。 */
export async function initializeWorkingModelCatalog(
  setCatalog: (value: WorkingModelCatalog) => void,
): Promise<void> {
  const generation = catalogLoadGeneration
  try {
    const catalog = await fetchWorkingModelCatalog()
    if (generation === catalogLoadGeneration) setCatalog(catalog)
  } catch (error) {
    if (generation === catalogLoadGeneration) {
      setCatalog(EMPTY_WORKING_MODEL_CATALOG)
      console.error('[模型管理] 加载配置失败:', error)
    }
  }
}

/** 清除当前账号的目录并使尚未完成的旧请求失效。 */
export function resetWorkingModelCatalog(
  setCatalog: (value: WorkingModelCatalog) => void,
): void {
  catalogLoadGeneration += 1
  catalogLoadPromise = null
  setCatalog(EMPTY_WORKING_MODEL_CATALOG)
}

/** 保存模型管理配置并同步 atom。 */
export async function persistWorkingModelCatalog(
  setCatalog: (value: WorkingModelCatalog) => void,
  catalog: WorkingModelCatalogSaveInput,
): Promise<WorkingModelCatalog> {
  const generation = catalogLoadGeneration
  const saved = await window.electronAPI.saveWorkingModelCatalog(catalog)
  if (generation !== catalogLoadGeneration) return saved
  catalogLoadPromise = Promise.resolve(saved)
  setCatalog(saved)
  return saved
}
