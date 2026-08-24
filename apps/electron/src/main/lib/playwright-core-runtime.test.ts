import { describe, expect, mock, test } from 'bun:test'
import { join } from 'node:path'

mock.module('electron', () => ({
  app: { isPackaged: false },
}))

const { resolvePlaywrightCoreEntrypoint } = await import('./playwright-core-runtime')

describe('Playwright runtime 入口', () => {
  test('开发模式从仓库依赖解析 driver 入口', () => {
    const entrypoint = resolvePlaywrightCoreEntrypoint({ isPackaged: false })

    expect(entrypoint.endsWith(join('playwright-core', 'index.js'))).toBe(true)
  })

  test('正式模式缺少 active 指针时回退到随应用打包的 driver', () => {
    const entrypoint = resolvePlaywrightCoreEntrypoint({
      isPackaged: true,
      modulesRoot: join('/tmp', 'copis-missing-modules'),
      bundledEntrypoint: '/Applications/Copis.app/Contents/Resources/app.asar/node_modules/playwright-core/index.js',
    })

    expect(entrypoint).toContain('node_modules/playwright-core/index.js')
  })
})
