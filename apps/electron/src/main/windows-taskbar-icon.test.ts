import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mainSource = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8')

describe('Windows 任务栏图标', () => {
  test('Given 打包应用原地升级 When 主窗口就绪 Then 重新设置已加载的 NativeImage', () => {
    expect(mainSource).toContain('nativeImage.createFromPath(iconPath)')
    expect(mainSource).toContain("process.platform === 'win32' && appIcon?.isEmpty() === false")
    expect(mainSource).toContain('mainWindow?.setIcon(appIcon)')
  })
})
