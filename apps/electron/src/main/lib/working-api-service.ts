import { WorkingApiClient } from './working-api-client'
import { getWorkingTokenStore } from './working-auth-store'

let workingApiClient: WorkingApiClient | null = null

/** Main-process singleton that owns the persisted Working credential store. */
export function getWorkingApiClient(): WorkingApiClient {
  if (!workingApiClient) {
    workingApiClient = new WorkingApiClient({ tokenStore: getWorkingTokenStore() })
  }
  return workingApiClient
}

export function resetWorkingApiClientForTests(): void {
  workingApiClient = null
}
