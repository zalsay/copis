import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { FunctionalModuleArtifact } from '@copis/shared'
import {
  activatePreparedFunctionalModule,
  checkFunctionalModule,
  getFunctionalModuleStatus,
  getFunctionalModuleStatuses,
  installFunctionalModule,
  prepareFunctionalModule,
  type FunctionalModuleManagerOptions,
} from './functional-module-manager'

const roots: string[] = []
const MODULE_NAME = 'chrome-desktop-cli'
const MANIFEST_URL = 'https://example.invalid/manifest.json'

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function rootDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'copis-chrome-manager-'))
  roots.push(root)
  return root
}

function metadata(version: string): Record<string, unknown> {
  return {
    name: MODULE_NAME,
    version,
    platform: 'darwin',
    arch: 'arm64',
    protocolVersion: 1,
    entrypoint: 'mcc',
    helper: 'macos-chrome-helper',
    minimumOsVersion: '14.0',
  }
}

function chromeArchive(version = '0.1.0', contents: unknown = metadata(version)) {
  const source = rootDir()
  const top = `copis-chrome-${version}-darwin-arm64`
  const componentDir = join(source, top)
  mkdirSync(componentDir)
  writeFileSync(join(componentDir, 'mcc'), 'mcc')
  writeFileSync(join(componentDir, 'macos-chrome-helper'), 'macos-chrome-helper')
  writeFileSync(join(componentDir, 'module.json'), typeof contents === 'string' ? contents : JSON.stringify(contents))
  const archive = join(source, 'chrome.tar.gz')
  expect(spawnSync('tar', ['-czf', archive, '-C', source, top]).status).toBe(0)
  const bytes = readFileSync(archive)
  const artifact: FunctionalModuleArtifact = {
    name: MODULE_NAME,
    version,
    platform: 'darwin',
    arch: 'arm64',
    url: `https://example.invalid/chrome-${version}.tar.gz`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    format: 'tar.gz',
    entrypoint: `${top}/mcc`,
    required: false,
  }
  return { artifact, bytes }
}

function installOptions(root: string, archive: ReturnType<typeof chromeArchive>): FunctionalModuleManagerOptions {
  return {
    rootDir: root,
    platform: 'darwin',
    arch: 'arm64',
    artifactOverride: archive.artifact,
    fetchImpl: async () => new Response(archive.bytes),
  }
}

function installedComponentDir(root: string, artifact: FunctionalModuleArtifact): string {
  return join(root, 'versions', MODULE_NAME, `${artifact.version}-${artifact.sha256}`, dirname(artifact.entrypoint))
}

async function installPreviousVersion(root: string) {
  return installFunctionalModule({ name: MODULE_NAME }, installOptions(root, chromeArchive()))
}

const invalidMetadata: Array<[string, unknown]> = [
  ['非 JSON', 'not JSON'],
  ['非对象', null],
  ['缺少字段', {}],
  ['超过 64 KiB', { ...metadata('0.2.0'), padding: ' '.repeat(64 * 1024) }],
  ...Object.entries({
    name: 'another-module',
    version: '0.9.0',
    platform: 'linux',
    arch: 'x64',
    protocolVersion: 2,
    entrypoint: '../copis-chrome',
    helper: 'another-helper',
  }).map(([field, value]): [string, unknown] => [field, { ...metadata('0.2.0'), [field]: value }]),
]

describe('Chrome 功能模块平台边界', () => {
  test('Given 模块列表 When 非 mac Then 不出现 Chrome，mac 上为可选', () => {
    const root = rootDir()
    for (const platform of ['win32', 'linux'] as const) {
      expect(getFunctionalModuleStatuses(root, platform).some(status => status.name === MODULE_NAME)).toBe(false)
    }
    expect(getFunctionalModuleStatuses(root, 'darwin').find(status => status.name === MODULE_NAME))
      .toMatchObject({ required: false, displayName: 'MCC · Chrome 桌面自动化' })
  })

  test('Given 非 macOS When 安装或预备 Chrome Then 不下载并明确拒绝平台', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      for (const install of [installFunctionalModule, prepareFunctionalModule]) {
        await expect(install({ name: MODULE_NAME }, {
          rootDir: rootDir(), platform, arch: 'x64',
          fetchImpl: async () => { throw new Error('不应下载') },
        })).rejects.toThrow('仅支持 macOS')
      }
    }
  })

  test('Given macOS 独立归档 When 安装 Then 校验元数据后复用 SHA 与受管激活并保留可执行 helper', async () => {
    const root = rootDir()
    const archive = chromeArchive()
    const status = await installFunctionalModule({ name: MODULE_NAME }, installOptions(root, archive))
    expect(status).toMatchObject({ installed: true, version: '0.1.0', required: false })
    expect(status.path).toEndWith(archive.artifact.entrypoint)
    const componentDir = dirname(status.path!)
    expect(readFileSync(join(componentDir, 'macos-chrome-helper'), 'utf8')).toBe('macos-chrome-helper')
    expect(JSON.parse(readFileSync(join(componentDir, 'module.json'), 'utf8'))).toEqual(metadata('0.1.0'))
    expect(statSync(join(componentDir, 'macos-chrome-helper')).mode & 0o111).toBe(0o111)
  })

  test('Given Chrome manifest 不是可选归档或顶层入口不匹配 When 安装 Then 下载前拒绝', async () => {
    const { artifact } = chromeArchive()
    for (const patch of [
      { required: true }, { entrypoint: 'bin/copis-chrome' },
      { entrypoint: 'copis-chrome-0.2.0-darwin-arm64/copis-chrome' },
      { format: 'binary' as const }, { arch: 'x64' as const },
    ]) {
      await expect(installFunctionalModule({ name: MODULE_NAME }, {
        rootDir: rootDir(), platform: 'darwin', arch: 'arm64',
        artifactOverride: { ...artifact, ...patch },
        fetchImpl: async () => { throw new Error('不应下载') },
      })).rejects.toThrow('Chrome 模块')
    }
  })
})

describe('Chrome 独立协议与 Electron 版本门槛', () => {
  for (const platformMinimum of [false, true]) {
    test(`Given 旧 Electron 和更高${platformMinimum ? '平台' : '全局'}门槛但协议 1 When check/install Then 允许独立模块更新`, async () => {
      const root = rootDir()
      const archive = chromeArchive()
      const manifest = {
        schema: 1, channel: 'stable', client: { minVersion: '99.0.0' },
        platforms: {
          'darwin-arm64': {
            ...(platformMinimum ? { minClientVersion: '100.0.0' } : {}),
            modules: { [MODULE_NAME]: archive.artifact },
          },
        },
      }
      const options: FunctionalModuleManagerOptions = {
        rootDir: root, platform: 'darwin', arch: 'arm64', clientVersion: '0.0.1', manifestUrl: MANIFEST_URL,
        fetchImpl: async url => url === MANIFEST_URL ? Response.json(manifest) : new Response(archive.bytes),
      }
      expect(await checkFunctionalModule(MODULE_NAME, options))
        .toMatchObject({ availableVersion: '0.1.0', updateAvailable: true, error: null })
      expect(await installFunctionalModule({ name: MODULE_NAME }, options))
        .toMatchObject({ installed: true, version: '0.1.0', error: null })
      expect(await checkFunctionalModule(MODULE_NAME, options))
        .toMatchObject({ updateAvailable: false, error: null })
    })
  }

  test('Given 旧 Electron 且调用方显式要求版本检查 When check/install Then 尊重 true 且不下载归档', async () => {
    const archive = chromeArchive()
    const calls: string[] = []
    const options: FunctionalModuleManagerOptions = {
      rootDir: rootDir(), platform: 'darwin', arch: 'arm64', clientVersion: '0.0.1',
      checkClientVersion: true, manifestUrl: MANIFEST_URL,
      fetchImpl: async url => {
        calls.push(url)
        return Response.json({
          schema: 1, channel: 'stable', client: { minVersion: '99.0.0' },
          platforms: { 'darwin-arm64': { modules: { [MODULE_NAME]: archive.artifact } } },
        })
      },
    }
    expect((await checkFunctionalModule(MODULE_NAME, options)).error).toContain('Copis 版本过低')
    await expect(installFunctionalModule({ name: MODULE_NAME }, options)).rejects.toThrow('Copis 版本过低')
    expect(calls).toEqual([MANIFEST_URL, MANIFEST_URL])
  })
})

describe('Chrome 元数据验证与原子激活', () => {
  for (const [label, contents] of invalidMetadata) {
    test(`Given 待更新归档的 metadata ${label} 无效 When prepare/install Then 拒绝、保留旧 active 且不修改 helper 执行位`, async () => {
      const root = rootDir()
      const previous = await installPreviousVersion(root)
      const activeBefore = readFileSync(join(root, 'active.json'), 'utf8')
      const archive = chromeArchive('0.2.0', contents)
      const options = installOptions(root, archive)
      for (const install of [prepareFunctionalModule, installFunctionalModule]) {
        await expect(install({ name: MODULE_NAME }, options)).rejects.toThrow('Chrome 模块元数据')
        expect(readFileSync(join(root, 'active.json'), 'utf8')).toBe(activeBefore)
        expect(getFunctionalModuleStatus(MODULE_NAME, root).path).toBe(previous.path)
        const helper = join(installedComponentDir(root, archive.artifact), 'macos-chrome-helper')
        expect(statSync(helper).mode & 0o111).toBe(0)
      }
    })

    test(`Given prepare 后 metadata ${label} 被修改 When activatePrepared Then 再校验并保留旧 active 和 helper 权限`, async () => {
      const root = rootDir()
      await installPreviousVersion(root)
      const activeBefore = readFileSync(join(root, 'active.json'), 'utf8')
      const archive = chromeArchive('0.2.0')
      const prepared = await prepareFunctionalModule({ name: MODULE_NAME }, installOptions(root, archive))
      const componentDir = dirname(join(prepared.versionDir, prepared.packageInfo.entrypoint))
      writeFileSync(join(componentDir, 'module.json'), typeof contents === 'string' ? contents : JSON.stringify(contents))
      chmodSync(join(componentDir, 'macos-chrome-helper'), 0o600)
      await expect(activatePreparedFunctionalModule(prepared, root)).rejects.toThrow('Chrome 模块元数据')
      expect(readFileSync(join(root, 'active.json'), 'utf8')).toBe(activeBefore)
      expect(statSync(join(componentDir, 'macos-chrome-helper')).mode & 0o111).toBe(0)
    })
  }

  for (const kind of ['symlink', 'directory', 'hardlink'] as const) {
    test(`Given prepare 后 module.json 被替换成 ${kind} When activatePrepared Then 拒绝并保留旧 active 与执行位`, async () => {
      const root = rootDir()
      await installPreviousVersion(root)
      const activeBefore = readFileSync(join(root, 'active.json'), 'utf8')
      const prepared = await prepareFunctionalModule({ name: MODULE_NAME }, installOptions(root, chromeArchive('0.2.0')))
      const componentDir = dirname(join(prepared.versionDir, prepared.packageInfo.entrypoint))
      const metadataPath = join(componentDir, 'module.json')
      rmSync(metadataPath)
      if (kind === 'directory') {
        mkdirSync(metadataPath)
      } else {
        const target = join(componentDir, 'metadata-backup.json')
        writeFileSync(target, JSON.stringify(metadata('0.2.0')))
        if (kind === 'symlink') symlinkSync(target, metadataPath)
        else linkSync(target, metadataPath)
      }
      const helper = join(componentDir, 'macos-chrome-helper')
      chmodSync(helper, 0o600)
      await expect(activatePreparedFunctionalModule(prepared, root)).rejects.toThrow('Chrome 模块元数据')
      expect(readFileSync(join(root, 'active.json'), 'utf8')).toBe(activeBefore)
      expect(statSync(helper).mode & 0o111).toBe(0)
    })
  }

  test('Given module.json 恰好 64 KiB 且协议 1 合法 When prepare/install Then 允许边界大小', async () => {
    const json = JSON.stringify(metadata('0.2.0'))
    const contents = json + ' '.repeat(64 * 1024 - Buffer.byteLength(json))
    const root = rootDir()
    expect(await installFunctionalModule({ name: MODULE_NAME }, installOptions(root, chromeArchive('0.2.0', contents))))
      .toMatchObject({ installed: true, version: '0.2.0' })
  })

  test('Given 协议 1 的合法更新 When prepare 后 activatePrepared Then 切换独立版本并确保 helper 可执行', async () => {
    const root = rootDir()
    await installPreviousVersion(root)
    const prepared = await prepareFunctionalModule({ name: MODULE_NAME }, installOptions(root, chromeArchive('0.2.0')))
    expect(getFunctionalModuleStatus(MODULE_NAME, root).version).toBe('0.1.0')
    const helper = join(dirname(join(prepared.versionDir, prepared.packageInfo.entrypoint)), 'macos-chrome-helper')
    chmodSync(helper, 0o600)
    expect(await activatePreparedFunctionalModule(prepared, root)).toMatchObject({ installed: true, version: '0.2.0' })
    expect(statSync(helper).mode & 0o111).toBe(0o111)
  })

  test('Given 安装准备完成后 metadata 在激活回调中损坏 When install Then 激活前再验证并保留旧 active', async () => {
    const root = rootDir()
    await installPreviousVersion(root)
    const activeBefore = readFileSync(join(root, 'active.json'), 'utf8')
    const archive = chromeArchive('0.2.0')
    const componentDir = installedComponentDir(root, archive.artifact)
    await expect(installFunctionalModule({ name: MODULE_NAME }, {
      ...installOptions(root, archive),
      onProgress: progress => {
        if (progress.phase !== 'activate') return
        writeFileSync(join(componentDir, 'module.json'), JSON.stringify({ ...metadata('0.2.0'), protocolVersion: 2 }))
        chmodSync(join(componentDir, 'macos-chrome-helper'), 0o600)
      },
    })).rejects.toThrow('Chrome 模块元数据')
    expect(readFileSync(join(root, 'active.json'), 'utf8')).toBe(activeBefore)
    expect(statSync(join(componentDir, 'macos-chrome-helper')).mode & 0o111).toBe(0)
  })
})
