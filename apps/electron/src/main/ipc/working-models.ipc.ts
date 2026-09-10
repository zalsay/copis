import { ipcMain } from 'electron'
import { WORKING_IPC_CHANNELS, type WorkingModelLatencyMap, type WorkingModelCatalogSaveInput, type WorkingTestCustomModelInput } from '@copis/shared'
import { getWorkingModelLatencies } from '../lib/working-model-latencies'
import { getDshCordisStatus, reloadDshCordisPlugins } from '../lib/dsh-cordis-service'
import { assertWorkingModelCatalogVip, getWorkingModelCatalog, saveWorkingModelCatalog, testWorkingCustomModelConnection } from '../lib/working-model-catalog'
import { getWorkingModelCatalogAccess } from '../lib/working-model-catalog-access'

export function registerWorkingModelsIpcHandlers(): void {
  ipcMain.handle(
    WORKING_IPC_CHANNELS.GET_MODEL_LATENCIES,
    async (): Promise<WorkingModelLatencyMap> => {
      return getWorkingModelLatencies()
    }
  )

  ipcMain.handle(WORKING_IPC_CHANNELS.GET_MODEL_CATALOG, async () => {
    const access = getWorkingModelCatalogAccess()
    assertWorkingModelCatalogVip(access.isVip)
    return getWorkingModelCatalog(access.isVip, access.ownerId)
  })

  ipcMain.handle(WORKING_IPC_CHANNELS.SAVE_MODEL_CATALOG, async (_, catalog: WorkingModelCatalogSaveInput) => {
    const access = getWorkingModelCatalogAccess()
    assertWorkingModelCatalogVip(access.isVip)
    const saved = saveWorkingModelCatalog(catalog, access.isVip, access.ownerId)
    if (getDshCordisStatus().running) await reloadDshCordisPlugins({ startIfNeeded: false })
    return saved
  })

  ipcMain.handle(WORKING_IPC_CHANNELS.TEST_MODEL_CONNECTION, async (_, input: WorkingTestCustomModelInput) => {
    const access = getWorkingModelCatalogAccess()
    assertWorkingModelCatalogVip(access.isVip)
    return testWorkingCustomModelConnection(input, access.isVip, access.ownerId)
  })
}
