import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateLegacyConfigDirectory, resolveConfigDir, resolveConfigDirName } from './paths'

describe('CLI 配置目录改名迁移', () => {
  test('Given COPIS_DEV=1 When 解析配置目录 Then 使用新的开发目录', () => {
    expect(resolveConfigDirName({ copisDev: '1' })).toBe('.copis-dev')
  })

  test('Given 显式配置目录 When 解析 CLI 配置 Then 不受环境变量影响', () => {
    expect(resolveConfigDir({ configDir: '/tmp/custom-copis', dev: true })).toBe('/tmp/custom-copis')
  })

  test('Given 只有旧正式目录 When 迁移配置 Then 使用新的正式目录', () => {
    const home = mkdtempSync(join(tmpdir(), 'copis-cli-paths-'))
    const legacyDir = join(home, '.proma')
    const targetDir = join(home, '.copis')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'marker.txt'), 'legacy', 'utf-8')

    try {
      migrateLegacyConfigDirectory(home, '.copis')

      expect(existsSync(legacyDir)).toBe(false)
      expect(readFileSync(join(targetDir, 'marker.txt'), 'utf-8')).toBe('legacy')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
