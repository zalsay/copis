import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '..')
const rootPackage = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>
  devDependencies?: Record<string, string>
}
const electronPackage = JSON.parse(
  readFileSync(join(repoRoot, 'apps/electron/package.json'), 'utf8'),
) as {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
const electronBuilder = readFileSync(
  join(repoRoot, 'apps/electron/electron-builder.yml'),
  'utf8',
)

describe('功能模块发布边界', () => {
  test('Electron 只负责下载，COS 上传工具属于仓库级开发脚本', () => {
    expect(electronPackage.dependencies?.['cos-nodejs-sdk-v5']).toBeUndefined()
    expect(electronPackage.devDependencies?.['cos-nodejs-sdk-v5']).toBeUndefined()
    expect(electronPackage.scripts?.['publish:functional-modules']).toBeUndefined()
    expect(rootPackage.devDependencies?.['cos-nodejs-sdk-v5']).toBe('3.0.0')
    expect(rootPackage.scripts?.['publish:functional-modules']).toBeDefined()
    expect(existsSync(join(repoRoot, 'apps/electron/scripts/publish-functional-modules.ts'))).toBe(false)
    expect(existsSync(join(repoRoot, 'scripts/publish-functional-modules.ts'))).toBe(true)
    expect(electronBuilder).toContain('!node_modules/cos-nodejs-sdk-v5/**')
  })
})
