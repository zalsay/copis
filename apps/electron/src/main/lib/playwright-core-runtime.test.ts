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
})
