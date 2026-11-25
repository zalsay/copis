import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildFunctionalModuleBinaryInputs, validateExistingModulesForSingleModuleRelease } from './publish-functional-modules'
import { mergeFunctionalModuleManifests } from './functional-module-manifest-merge'
import { applyFunctionalModuleVersionLocks, loadFunctionalModuleVersionLocks } from './functional-module-version-lock'

const base = { rustOnly: false, rustBinary: '/rust', rustVersion: '9.9.9', officeCliBinary: '/office', officeCliVersion: '1.0.143', nodeRuntimeArchive: '/node.tar.gz', alipayBotArchive: '/alipay.tar.gz', playwrightCoreArchive: '/playwright.tar.gz', pythonRuntimeArchive: '/python.tar.gz', agentlyCliArchive: '/agently.tar.gz', dshArchive: '/dsh.tar.gz', chromeDesktopCliArchive: '/chrome.tar.gz', chromeDesktopCliVersion: '0.1.0', platform: 'darwin' as const, arch: 'arm64' as const }
describe('Chrome 独立模块发布入口', () => {
  test('Given Chrome-only When 生成输入 Then 仅产生独立 macOS 可选归档并保留顶层入口', () => {
    const modules = buildFunctionalModuleBinaryInputs({ ...base, chromeDesktopCliOnly: true })
    expect(modules).toEqual([{ module: 'chrome-desktop-cli', version: '0.1.0', platform: 'darwin', arch: 'arm64', binaryPath: '/chrome.tar.gz', format: 'tar.gz', entrypoint: 'copis-chrome-0.1.0-darwin-arm64/mcc', required: false }])
    expect(applyFunctionalModuleVersionLocks(modules, loadFunctionalModuleVersionLocks())[0]?.entrypoint).toBe('copis-chrome-0.3.6-darwin-arm64/mcc')
  })
  test('Given 全量发布 When darwin Then 包含 Chrome When win/linux Then 跳过', () => {
    expect(buildFunctionalModuleBinaryInputs(base).some(m => m.module === 'chrome-desktop-cli')).toBe(true)
    for (const platform of ['win32', 'linux'] as const) {
      expect(buildFunctionalModuleBinaryInputs({ ...base, platform }).some(m => m.module === 'chrome-desktop-cli')).toBe(false)
      expect(() => buildFunctionalModuleBinaryInputs({ ...base, platform, chromeDesktopCliOnly: true })).toThrow('仅支持 macOS')
    }
    expect(() => buildFunctionalModuleBinaryInputs({ ...base, chromeDesktopCliOnly: true, codexCliOnly: true })).toThrow('不能同时使用')
  })
  test('Given Chrome-only When 远端缺必要模块 Then 拒绝发布', () => {
    expect(() => validateExistingModulesForSingleModuleRelease({ ...base, officeCliOnly: false, nodeRuntimeOnly: false, alipayBotOnly: false, chromeDesktopCliOnly: true, manifest: undefined })).toThrow('缺少')
  })
  test('Given Chrome 增量 manifest When 合并 Then 保留其他模块和平台', () => {
    const artifact = { version: '1.0.0', url: 'https://example.invalid/archive', sha256: 'a'.repeat(64), size: 1, format: 'tar.gz' as const, entrypoint: 'bin/node', required: true }
    const existing = { schema: 1, channel: 'stable', platforms: { 'darwin-arm64': { modules: { 'node-runtime': artifact } }, 'win32-x64': { modules: { 'node-runtime': artifact } } } }
    const incoming = { schema: 1, channel: 'stable', platforms: { 'darwin-arm64': { modules: { 'chrome-desktop-cli': { ...artifact, version: '0.1.0', entrypoint: 'copis-chrome-0.1.0-darwin-arm64/mcc', required: false } } } } }
    const merged = mergeFunctionalModuleManifests(existing, incoming)
    expect(merged.platforms['darwin-arm64']?.modules['node-runtime']).toEqual(artifact)
    expect(merged.platforms['win32-x64']).toEqual(existing.platforms['win32-x64'])
    expect(merged.platforms['darwin-arm64']?.modules['chrome-desktop-cli']?.required).toBe(false)
  })
  test('Given Electron 默认构建与安装包 When 检查边界 Then 仅在独立模块构建中编译 Worker 和扩展', () => {
    const root = join(import.meta.dir, '..')
    const pkg = JSON.parse(readFileSync(join(root, 'apps/electron/package.json'), 'utf8'))
    expect(pkg.scripts['build:chrome-desktop-helper']).toBeUndefined()
    expect(pkg.scripts.build).not.toContain('build:chrome-desktop-helper')
    expect(pkg.scripts.build).not.toContain('chrome-desktop-cli-module')
    for (const optionalStep of ['build:agent-rpc-worker', 'build:cli', 'copy:pi-extensions', 'build:resources']) {
      expect(pkg.scripts.build).not.toContain(optionalStep)
    }
    expect(pkg.scripts.start).toContain('build:agent-rpc-worker')
    expect(readFileSync(join(root, 'apps/electron/electron-builder.yml'), 'utf8')).toContain('!resources/chrome-desktop-cli/**')
    expect(readFileSync(join(root, 'apps/electron/electron-builder.yml'), 'utf8')).not.toContain('from: resources/bin')
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('apps/electron/resources/chrome-desktop-cli/')
    for (const path of ['deploy.sh', 'deploy.ps1', 'scripts/build-functional-module-manifest.ts', 'scripts/publish-functional-modules.ts']) {
      expect(readFileSync(join(root, path), 'utf8')).toContain('--chrome-desktop-cli')
    }
  })
})
