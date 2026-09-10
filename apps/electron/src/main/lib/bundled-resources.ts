import { app } from 'electron'
import { join } from 'node:path'

export function getBundledResourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : join(__dirname, 'resources')
}
