import { getDesktopResourcesDir } from './config-paths'
import { app } from 'electron'
import { join } from 'node:path'

export function getBundledResourcesDir(): string {
  return app.isPackaged && process.resourcesPath ? getDesktopResourcesDir() : join(__dirname, 'resources')
}

export function getBrandLogoDirectory(): string {
  return app.isPackaged
    ? join(getBundledResourcesDir(), 'copis-logos')
    : join(app.getAppPath(), 'src/renderer/assets/bots/copis-logos')
}
