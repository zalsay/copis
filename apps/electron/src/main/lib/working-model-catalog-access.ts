import { getWorkingApiClient } from './working-api-service'
import { getWorkingModelCatalogOwnerId } from './working-model-catalog'

export function getWorkingModelCatalogAccess(): { isVip: boolean; ownerId?: string } {
  const user = getWorkingApiClient().getCachedUser()
  return {
    isVip: user?.isVip === true,
    ownerId: getWorkingModelCatalogOwnerId(user),
  }
}
