import { app } from 'electron'
import { join } from 'node:path'

export function resolveAppIconPath(variantId: string): string | null {
  const resourcesDir = (app.isPackaged ? process.resourcesPath : join(__dirname, 'resources'))
  if (!variantId || variantId === 'default') {
    return join(resourcesDir, 'icon.png')
  }
  return join(resourcesDir, 'copis-logos', `copis-${variantId}.png`)
}
