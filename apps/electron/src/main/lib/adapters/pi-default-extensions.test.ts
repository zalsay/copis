import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDefaultPiExtensionEntries } from './pi-default-extensions'

const originalExtensionsDir = process.env.COPIS_PI_EXTENSIONS_DIR
const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  if (originalExtensionsDir === undefined) {
    delete process.env.COPIS_PI_EXTENSIONS_DIR
  } else {
    process.env.COPIS_PI_EXTENSIONS_DIR = originalExtensionsDir
  }
})

describe('Copis 默认 Pi 扩展解析', () => {
  test('Given COPIS_PI_EXTENSIONS_DIR 指向内置扩展目录 When 解析默认扩展 Then 返回该目录下的入口', () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-pi-ext-'))
    tempRoots.push(root)
    const pkgDir = join(root, 'node_modules', 'pi-web-access')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'index.ts'), 'export default () => {}\n', 'utf-8')
    process.env.COPIS_PI_EXTENSIONS_DIR = root

    expect(resolveDefaultPiExtensionEntries()).toEqual([join(pkgDir, 'index.ts')])
  })

  test('Given 环境变量指向空目录 When 解析默认扩展 Then 回退到 node_modules 解析', () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-pi-ext-missing-'))
    tempRoots.push(root)
    process.env.COPIS_PI_EXTENSIONS_DIR = root

    const entries = resolveDefaultPiExtensionEntries()
    expect(entries.length).toBe(1)
    expect(entries[0]).toContain('pi-web-access')
    expect(entries[0]).toMatch(/index\.ts$/)
  })
})
