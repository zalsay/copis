import { getBrandLogoDirectory } from './bundled-resources'
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function resolveAppIconPath(variantId: string): string | null {
  const resourcesDir = (app.isPackaged ? process.resourcesPath : join(__dirname, 'resources'))
  if (!variantId || variantId === 'default') {
    return join(resourcesDir, 'icon.png')
  }
  const variant = join(getBrandLogoDirectory(), `copis-${variantId}.png`)
  return existsSync(variant) ? variant : join(resourcesDir, 'icon.png')
}
