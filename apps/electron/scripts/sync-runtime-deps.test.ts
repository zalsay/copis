import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EXTERNAL_RUNTIME_PACKAGES, syncRuntimeDeps } from './sync-runtime-deps'

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('主进程 external runtime 依赖', () => {
  test('包含 playwright-core 且能复制其依赖闭包', () => {
    expect(EXTERNAL_RUNTIME_PACKAGES).toContain('playwright-core')

    const root = mkdtempSync(join(tmpdir(), 'copis-runtime-deps-'))
    roots.push(root)
    const source = join(root, 'source', 'node_modules')
    const target = join(root, 'target', 'node_modules')
    const playwright = join(source, 'playwright-core')
    mkdirSync(playwright, { recursive: true })
    writeFileSync(join(playwright, 'package.json'), JSON.stringify({ name: 'playwright-core', version: '1.62.1' }))
    writeFileSync(join(playwright, 'index.js'), 'module.exports = {}\n')

    syncRuntimeDeps({
      sourceNodeModules: source,
      targetNodeModules: target,
      externalRuntimePackages: ['playwright-core'],
    })

    expect(existsSync(join(target, 'playwright-core', 'index.js'))).toBe(true)
  })
})
