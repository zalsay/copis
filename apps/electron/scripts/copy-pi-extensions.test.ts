import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePackageSourceDir } from './copy-pi-extensions'

describe('Pi 扩展运行时依赖解析', () => {
  test('Given Bun isolated 布局 When 扩展仅存在于 .bun/node_modules Then 可以解析扩展包', () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-pi-extensions-'))
    try {
      const virtualNodeModules = join(root, 'node_modules', '.bun', 'node_modules')
      const packageDir = join(virtualNodeModules, 'pi-web-access')
      mkdirSync(packageDir, { recursive: true })
      writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
        name: 'pi-web-access',
        version: '0.22.0',
      }))

      expect(resolvePackageSourceDir('pi-web-access', [
        join(root, 'apps', 'electron', 'node_modules'),
        virtualNodeModules,
        join(root, 'node_modules'),
      ])).toBe(realpathSync(packageDir))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
