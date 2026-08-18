import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPlaywrightCoreModule } from './build-playwright-core-module'

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('Playwright 功能模块归档', () => {
  test('归档包含 Playwright driver 入口和运行时闭包', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-playwright-core-module-'))
    roots.push(root)
    const output = join(root, 'playwright-core.tar.gz')

    const archive = await buildPlaywrightCoreModule({ output })

    expect(archive).toBe(output)
    expect(existsSync(output)).toBe(true)
    const entries = execFileSync('tar', ['-tzf', output], { encoding: 'utf8' })
      .trim()
      .split(/\r?\n/)
      .map((entry) => entry.replace(/^\.\//, ''))
    expect(entries).toContain('node_modules/playwright-core/index.js')
    expect(entries).toContain('node_modules/playwright-core/package.json')
    expect(entries.some((entry) => entry.includes('ms-playwright') || entry.includes('.local-browsers') || entry.includes('.cache'))).toBe(false)
  })

  test('相同输入重复构建时归档字节保持一致', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-playwright-core-module-deterministic-'))
    roots.push(root)
    const first = join(root, 'first.tar.gz')
    const second = join(root, 'second.tar.gz')

    await buildPlaywrightCoreModule({ output: first })
    await buildPlaywrightCoreModule({ output: second })

    expect(readFileSync(second)).toEqual(readFileSync(first))
  })
})
