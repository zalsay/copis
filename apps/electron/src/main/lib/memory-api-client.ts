import { app } from 'electron'
import { resolveCopisHttpApiPort } from '@copis/shared/config'
import {
  createMemoryApiClient,
  type MemoryApiClient,
} from './memory-api-client-runtime'

export * from './memory-api-client-runtime'

export const MEMORY_API_BASE_URL = `http://127.0.0.1:${resolveCopisHttpApiPort({
  configuredPort: process.env.COPIS_HTTP_API_PORT,
  isPackaged: app.isPackaged === true,
})}`

export const memoryApiClient: MemoryApiClient = createMemoryApiClient(MEMORY_API_BASE_URL)
