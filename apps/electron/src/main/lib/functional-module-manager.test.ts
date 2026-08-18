import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FunctionalModuleFetch } from './functional-module-manager'
import {
  fetchFunctionalModuleManifest,
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

  test('模块状态注册表包含五个必要模块', () => {
    const statuses = getFunctionalModuleStatuses(createRoot())

    expect(statuses.map((item) => item.name)).toEqual(['node-runtime', 'rust-http-api', 'officecli', 'alipay-bot', 'playwright-core'])
    expect(statuses.find((item) => item.name === 'node-runtime')?.required).toBe(true)
    expect(statuses.find((item) => item.name === 'rust-http-api')?.required).toBe(true)
    expect(statuses.find((item) => item.name === 'officecli')?.required).toBe(true)
    expect(statuses.find((item) => item.name === 'alipay-bot')?.required).toBe(true)
  })

  test('模块状态注册表包含浏览器自动化内核且标记为必选', () => {
    const status = getFunctionalModuleStatuses(createRoot()).find((item) => item.name === 'playwright-core')

    expect(status).toMatchObject({
      name: 'playwright-core',
      displayName: '浏览器自动化内核',
      required: true,
    })
  })
})
