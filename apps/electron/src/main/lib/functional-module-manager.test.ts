import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FunctionalModuleFetch } from './functional-module-manager'
import { shouldInstallDshModule } from '../../renderer/components/creation/creation-dsh-helper'
import {
  fetchFunctionalModuleManifest,
  checkFunctionalModule,
  getFunctionalModuleStatuses,
  installFunctionalModule,
} from './functional-module-manager'

const MANIFEST_URL = 'https://download.example.com/copis/modules/stable/manifest.json'
const tempRoots: string[] = []

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'copis-functional-module-install-'))
  tempRoots.push(root)
  return root
}

function moduleArtifact(
  name: 'officecli' | 'rust-http-api',
  version: string,
  content: string,
  required: boolean,
): Record<string, unknown> {
  return {
    version,
    url: `https://download.example.com/copis/modules/stable/darwin-arm64/${name}-${version}`,
    sha256: createHash('sha256').update(content).digest('hex'),
    size: Buffer.byteLength(content),
    format: 'binary',
    entrypoint: name === 'officecli' ? 'bin/officecli' : 'bin/copis-http-api-server',
    required,
  }
}

function createManifest(
  officeCli: Record<string, unknown>,
  rustApi: Record<string, unknown>,
): Record<string, unknown> {
  return {
    schema: 1,
    channel: 'stable',
    client: { minVersion: '0.16.13' },
    platforms: {
      'darwin-arm64': {
        modules: {
          officecli: officeCli,
          'rust-http-api': rustApi,
        },
      },
    },
  }
}

function responseForBody(body: string, url: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-length': String(Buffer.byteLength(body)),
      'content-type': url === MANIFEST_URL ? 'application/json' : 'application/octet-stream',
    },
  })
}

function createFetchFixture(
  manifest: Record<string, unknown>,
  contents: Record<string, string>,
  calls: string[],
): FunctionalModuleFetch {
  return async (input) => {
    calls.push(input)
    if (input === MANIFEST_URL) return responseForBody(JSON.stringify(manifest), input)
    const content = contents[input]
    if (content === undefined) return new Response('not found', { status: 404 })
    return responseForBody(content, input)
  }
}

describe('COS 功能模块统一管理', () => {
  test('manifest 同时解析 OfficeCLI 和 Rust API', async () => {
    const officeContent = 'officecli-v1'
    const rustContent = 'rust-api-v1'
    const manifest = createManifest(
      moduleArtifact('officecli', '1.2.3', officeContent, true),
      moduleArtifact('rust-http-api', '0.2.0', rustContent, true),
    )
    const artifacts = await fetchFunctionalModuleManifest({
      manifestUrl: MANIFEST_URL,
      platform: 'darwin',
      arch: 'arm64',
      clientVersion: '0.16.17',
      fetchImpl: createFetchFixture(manifest, {}, []),
    })

    expect(artifacts.map((item) => item.name)).toEqual(['officecli', 'rust-http-api'])
    expect(artifacts.find((item) => item.name === 'rust-http-api')).toMatchObject({
      version: '0.2.0',
      required: true,
    })
  })

  test('安装 OfficeCLI 只下载目标模块并写入 active', async () => {
    const officeContent = 'officecli-v1'
    const rustContent = 'rust-api-v1'
    const manifest = createManifest(
      moduleArtifact('officecli', '1.2.3', officeContent, true),
      moduleArtifact('rust-http-api', '0.2.0', rustContent, true),
    )
    const calls: string[] = []
    const fetchImpl = createFetchFixture(manifest, {
      'https://download.example.com/copis/modules/stable/darwin-arm64/officecli-1.2.3': officeContent,
      'https://download.example.com/copis/modules/stable/darwin-arm64/rust-http-api-0.2.0': rustContent,
    }, calls)
    const root = createRoot()

    const status = await installFunctionalModule({ name: 'officecli' }, {
      rootDir: root,
      manifestUrl: MANIFEST_URL,
      platform: 'darwin',
      arch: 'arm64',
      clientVersion: '0.16.17',
      fetchImpl,
    })

    expect(status).toMatchObject({ name: 'officecli', installed: true, version: '1.2.3' })
    expect(status.path).toBeTruthy()
    expect(readFileSync(status.path!, 'utf8')).toBe(officeContent)
    expect(calls).toEqual([MANIFEST_URL, 'https://download.example.com/copis/modules/stable/darwin-arm64/officecli-1.2.3'])
  })

  test('Given Copis 主程序版本低于平台门槛且 DSH artifact 可用 When 安装创造模式 Then 按 DSH 版本安装而不被主程序门槛拦截', async () => {
    const dshContent = 'dsh-v0.1.3'
    const dshUrl = 'https://download.example.com/copis/modules/stable/darwin-arm64/dsh-0.1.3'
    const manifest = {
      schema: 1,
      channel: 'stable',
      client: { minVersion: '0.16.18' },
      platforms: {
        'darwin-arm64': {
          modules: {
            dsh: {
              version: '0.1.3',
              url: dshUrl,
              sha256: createHash('sha256').update(dshContent).digest('hex'),
              size: Buffer.byteLength(dshContent),
              format: 'binary',
              entrypoint: 'bin/dsh',
              required: false,
            },
          },
        },
      },
    }
    const root = createRoot()

    const status = await installFunctionalModule({ name: 'dsh' }, {
      rootDir: root,
      manifestUrl: MANIFEST_URL,
      platform: 'darwin',
      arch: 'arm64',
      clientVersion: '0.16.17',
      fetchImpl: createFetchFixture(manifest, { [dshUrl]: dshContent }, []),
    })

    expect(status).toMatchObject({ name: 'dsh', installed: true, version: '0.1.3' })
  })

  test('Given Copis 主程序版本低于平台门槛 When 安装非 DSH 模块 Then 保持主程序版本门槛', async () => {
    const officeContent = 'officecli-v1'
    const rustContent = 'rust-api-v1'
    const manifest = {
      ...createManifest(
        moduleArtifact('officecli', '1.2.3', officeContent, true),
        moduleArtifact('rust-http-api', '0.2.0', rustContent, true),
      ),
      client: { minVersion: '0.16.18' },
    }

    await expect(installFunctionalModule({ name: 'officecli' }, {
      rootDir: createRoot(),
      manifestUrl: MANIFEST_URL,
      platform: 'darwin',
      arch: 'arm64',
      clientVersion: '0.16.17',
      fetchImpl: createFetchFixture(manifest, {}, []),
    })).rejects.toThrow('Copis 版本过低，需要至少 0.16.18')
  })

  test('Rust API 下载内容校验失败时不产生 active 版本', async () => {
    const rustContent = 'rust-api-v1'
    const badManifest = createManifest(
      moduleArtifact('officecli', '1.2.3', 'officecli-v1', true),
      { ...moduleArtifact('rust-http-api', '0.2.0', rustContent, true), sha256: 'f'.repeat(64) },
    )
    const root = createRoot()
    const fetchImpl = createFetchFixture(badManifest, {
      'https://download.example.com/copis/modules/stable/darwin-arm64/rust-http-api-0.2.0': rustContent,
    }, [])

    await expect(installFunctionalModule({ name: 'rust-http-api' }, {
      rootDir: root,
      manifestUrl: MANIFEST_URL,
      platform: 'darwin',
      arch: 'arm64',
      clientVersion: '0.16.17',
      fetchImpl,
    })).rejects.toThrow('校验失败')

    expect(existsSync(join(root, 'active.json'))).toBe(false)
    expect(existsSync(join(root, 'downloads'))).toBe(true)
    expect(readdirSync(join(root, 'downloads'))).toEqual([])
  })

  test('重复安装相同版本只复用已校验 artifact', async () => {
    const officeContent = 'officecli-v1'
    const rustContent = 'rust-api-v1'
    const manifest = createManifest(
      moduleArtifact('officecli', '1.2.3', officeContent, true),
      moduleArtifact('rust-http-api', '0.2.0', rustContent, true),
    )
    const calls: string[] = []
    const officeUrl = 'https://download.example.com/copis/modules/stable/darwin-arm64/officecli-1.2.3'
    const fetchImpl = createFetchFixture(manifest, { [officeUrl]: officeContent }, calls)
    const root = createRoot()
    const options = {
      rootDir: root,
      manifestUrl: MANIFEST_URL,
      platform: 'darwin' as const,
      arch: 'arm64' as const,
      clientVersion: '0.16.17',
      fetchImpl,
    }

    await installFunctionalModule({ name: 'officecli' }, options)
    const second = await installFunctionalModule({ name: 'officecli' }, options)

    expect(second.updateAvailable).toBe(false)
    expect(calls.filter((url) => url === officeUrl)).toHaveLength(1)
  })

  test('模块状态注册表包含全部模块且必要模块正确标记', () => {
    const statuses = getFunctionalModuleStatuses(createRoot())

    expect(statuses.map((item) => item.name)).toEqual(['node-runtime', 'rust-http-api', 'officecli', 'alipay-bot', 'playwright-core', 'python-runtime', 'agently-cli', 'dsh', ...(process.platform === 'darwin' ? ['chrome-desktop-cli'] : []), 'codex-cli'])
    expect(statuses.find((item) => item.name === 'node-runtime')?.required).toBe(true)
    expect(statuses.find((item) => item.name === 'rust-http-api')?.required).toBe(true)
    expect(statuses.find((item) => item.name === 'officecli')?.required).toBe(true)
    expect(statuses.find((item) => item.name === 'alipay-bot')?.required).toBe(true)
    expect(statuses.find((item) => item.name === 'agently-cli')?.required).toBe(false)
    expect(statuses.find((item) => item.name === 'dsh')?.required).toBe(false)
    expect(statuses.find((item) => item.name === 'codex-cli')?.required).toBe(false)
  })

  test('模块状态注册表包含浏览器自动化内核且标记为必选', () => {
    const status = getFunctionalModuleStatuses(createRoot()).find((item) => item.name === 'playwright-core')

    expect(status).toMatchObject({
      name: 'playwright-core',
      displayName: '浏览器自动化内核',
      required: true,
    })
  })

  test('模块状态注册表包含创造模式且标记为可选', () => {
    const status = getFunctionalModuleStatuses(createRoot()).find((item) => item.name === 'dsh')

    expect(status).toMatchObject({
      name: 'dsh',
      displayName: '创造模式',
      required: false,
    })
  })

  test('模块状态注册表包含 Agent QQ 邮箱 CLI 且标记为可选', () => {
    const status = getFunctionalModuleStatuses(createRoot()).find((item) => item.name === 'agently-cli')

    expect(status).toMatchObject({
      name: 'agently-cli',
      displayName: 'Agent QQ 邮箱 CLI',
      required: false,
    })
  })

  test('模块状态注册表包含 Python 3.12 运行环境且标记为必选', () => {
    const status = getFunctionalModuleStatuses(createRoot()).find((item) => item.name === 'python-runtime')

    expect(status).toMatchObject({
      name: 'python-runtime',
      displayName: 'Python 3.12 运行环境',
      required: true,
    })
  })

  test('模块状态注册表包含专业模式且标记为可选', () => {
    const status = getFunctionalModuleStatuses(createRoot()).find((item) => item.name === 'codex-cli')

    expect(status).toMatchObject({
      name: 'codex-cli',
      displayName: '专业模式',
      required: false,
    })
  })
})


describe('功能模块版本顺序与防自动降级', () => {
  async function fixture(currentVersion: string, candidateVersion: string, sameContent = false) {
    const rootDir = createRoot()
    const current = '当前已验证模块'
    const candidate = sameContent ? current : '候选模块'
    const options = { rootDir, manifestUrl: MANIFEST_URL, platform: 'darwin' as const, arch: 'arm64' as const, clientVersion: '0.16.17' }
    const initial = createManifest(moduleArtifact('officecli', currentVersion, current, true), moduleArtifact('rust-http-api', '1.0.0', 'rust', true))
    const initialUrl = `https://download.example.com/copis/modules/stable/darwin-arm64/officecli-${currentVersion}`
    await installFunctionalModule({ name: 'officecli' }, { ...options, fetchImpl: createFetchFixture(initial, { [initialUrl]: current }, []) })
    const calls: string[] = []
    const manifest = createManifest(moduleArtifact('officecli', candidateVersion, candidate, true), moduleArtifact('rust-http-api', '1.0.0', 'rust', true))
    const candidateUrl = `https://download.example.com/copis/modules/stable/darwin-arm64/officecli-${candidateVersion}`
    return { options: { ...options, fetchImpl: createFetchFixture(manifest, { [candidateUrl]: candidate }, calls) }, calls, current, candidate }
  }

  test('Given 本地新版 rc.5 而远端为 0.1.3 When 检查并自动安装 Then 不标记更新、不下载、不降级', async () => {
    const f = await fixture('0.2.1-rc.5', '0.1.3')
    const checked = await checkFunctionalModule('officecli', f.options)
    expect(checked.updateAvailable).toBe(false)
    expect(shouldInstallDshModule(checked)).toBe(false)
    const installed = await installFunctionalModule({ name: 'officecli' }, f.options)
    expect(installed.version).toBe('0.2.1-rc.5')
    expect(readFileSync(installed.path!, 'utf8')).toBe(f.current)
    expect(f.calls.every((url) => url === MANIFEST_URL)).toBe(true)
  })

  test('Given 本地 alpha.2 而远端仍为旧 rc.5 When 检查并自动安装 Then 不下载旧模块且保留 alpha 版本', async () => {
    const f = await fixture('0.2.2-alpha.2', '0.2.1-rc.5')
    expect((await checkFunctionalModule('officecli', f.options)).updateAvailable).toBe(false)
    expect((await installFunctionalModule({ name: 'officecli' }, f.options)).version).toBe('0.2.2-alpha.2')
    expect(f.calls.every((url) => url === MANIFEST_URL)).toBe(true)
  })

  test('Given 本地预发布 rc.10 而远端 rc.2 When 检查更新 Then 按语义版本比较而非字符串比较', async () => {
    const f = await fixture('0.2.1-rc.10', '0.2.1-rc.2')
    expect((await checkFunctionalModule('officecli', f.options)).updateAvailable).toBe(false)
  })

  test('Given 本地正式版本而远端为同基线预发布 When 检查更新 Then 不降级', async () => {
    const f = await fixture('0.2.1', '0.2.1-rc.5')
    expect((await checkFunctionalModule('officecli', f.options)).updateAvailable).toBe(false)
  })

  test('Given 本地预发布而远端为正式版本 When 检查并安装 Then 正常升级', async () => {
    const f = await fixture('0.2.1-rc.5', '0.2.1')
    expect((await checkFunctionalModule('officecli', f.options)).updateAvailable).toBe(true)
    expect((await installFunctionalModule({ name: 'officecli' }, f.options)).version).toBe('0.2.1')
  })

  test('Given 同版本不同校验和 When 检查并安装 Then 保留同版本修复能力', async () => {
    const f = await fixture('0.2.1', '0.2.1')
    expect((await checkFunctionalModule('officecli', f.options)).updateAvailable).toBe(true)
    const installed = await installFunctionalModule({ name: 'officecli' }, f.options)
    expect(readFileSync(installed.path!, 'utf8')).toBe(f.candidate)
  })

  test('Given 显式 force 指定旧版本 When 安装 Then 仍允许受控回滚', async () => {
    const f = await fixture('0.2.1-rc.5', '0.1.3')
    expect((await installFunctionalModule({ name: 'officecli', force: true }, f.options)).version).toBe('0.1.3')
  })
})
