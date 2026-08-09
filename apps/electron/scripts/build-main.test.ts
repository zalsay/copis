import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_FUNCTIONAL_MODULE_MANIFEST_URL,
  loadBuildEnvironment,
  resolveManifestBuildConfig,
} from './build-main'

describe('Electron 主进程构建配置', () => {
  test('优先使用构建环境中的功能模块 manifest 地址并注入 define', () => {
    expect(resolveManifestBuildConfig({
      COPIS_FUNCTIONAL_MODULE_MANIFEST_URL: 'https://build.example.com/stable/manifest.json',
    })).toEqual({
      __COPIS_FUNCTIONAL_MODULE_MANIFEST_URL__: '"https://build.example.com/stable/manifest.json"',
    })
  })

  test('未提供 manifest 地址时使用正式版默认地址', () => {
    expect(resolveManifestBuildConfig({})).toEqual({
      __COPIS_FUNCTIONAL_MODULE_MANIFEST_URL__: JSON.stringify(DEFAULT_FUNCTIONAL_MODULE_MANIFEST_URL),
    })
  })

  test('从仓库 .env 读取构建时 manifest 地址，显式环境变量优先', () => {
    const dir = mkdtempSync(join(tmpdir(), 'copis-build-main-'))
    const envPath = join(dir, '.env')
    writeFileSync(envPath, 'COPIS_FUNCTIONAL_MODULE_MANIFEST_URL=https://file.example.com/manifest.json\n')
    try {
      expect(loadBuildEnvironment(envPath, {})).toMatchObject({
        COPIS_FUNCTIONAL_MODULE_MANIFEST_URL: 'https://file.example.com/manifest.json',
      })
      expect(loadBuildEnvironment(envPath, {
        COPIS_FUNCTIONAL_MODULE_MANIFEST_URL: 'https://env.example.com/manifest.json',
      })).toMatchObject({
        COPIS_FUNCTIONAL_MODULE_MANIFEST_URL: 'https://env.example.com/manifest.json',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
