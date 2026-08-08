import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { SpawnOptions } from 'node:child_process'
import { afterAll, afterEach, describe, expect, test, mock } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { FunctionalModuleFetch } from './functional-module-manager'
import {
  activateFunctionalModule,
  assembleFunctionalModule,
  cacheFunctionalModule,
  getFunctionalModulePaths,
  readActiveFunctionalModule,
  type FunctionalModulePackage,
} from './functional-module-store'

mock.module('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/copis-http-api-runtime-test',
  },
  BrowserWindow: class {},
  WebContentsView: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: { openExternal: async () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}))

const previousHttpApiPort = process.env.COPIS_HTTP_API_PORT
process.env.COPIS_HTTP_API_PORT = '51740'

const {
  resolveDevelopmentRustBinaryCandidates,
  prepareHttpApiBackend,
  startHttpApiServer,
  stopHttpApiServer,
  shouldInstallMissingHttpApiModule,
  updateHttpApiServer,
  waitForHttpApiHealth,
} = await import('./http-api-server')
import type { HttpApiSpawn } from './http-api-server'

interface SpawnRecord {
  file: string
  args: readonly string[]
  options: SpawnOptions
  child: FakeChild
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false

  kill(): boolean {
    if (this.killed) return false
    this.killed = true
    this.emit('exit', 0, null)
    return true
  }
}

const tempRoots: string[] = []

afterEach(async () => {
  await stopHttpApiServer(5)
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

afterAll(() => {
  if (previousHttpApiPort === undefined) delete process.env.COPIS_HTTP_API_PORT
  else process.env.COPIS_HTTP_API_PORT = previousHttpApiPort
})

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'copis-http-api-runtime-'))
  tempRoots.push(root)
  return root
}

function rustPackage(version: string, content: string): FunctionalModulePackage {
  return {
    name: 'rust-http-api',
    version,
    sha256: createHash('sha256').update(content).digest('hex'),
    size: Buffer.byteLength(content),
    format: 'binary',
    entrypoint: 'bin/copis-http-api-server',
    required: true,
  }
}

async function activateRustVersion(root: string, packageInfo: FunctionalModulePackage, content: string): Promise<string> {
  const source = join(root, `${packageInfo.version}.source`)
  writeFileSync(source, content)
  const paths = getFunctionalModulePaths(join(root, 'modules'))
  await cacheFunctionalModule(paths, packageInfo, source)
  const versionDir = await assembleFunctionalModule(paths, packageInfo)
  await activateFunctionalModule(paths, packageInfo, versionDir)
  return join(versionDir, packageInfo.entrypoint)
}

function manifestFor(version: string, content: string): Record<string, unknown> {
  return {
    schema: 1,
    channel: 'stable',
    client: { minVersion: '0.16.13' },
    platforms: {
      'darwin-arm64': {
        modules: {
          'rust-http-api': {
            version,
            url: `https://download.example.com/rust-http-api-${version}`,
            sha256: createHash('sha256').update(content).digest('hex'),
            size: Buffer.byteLength(content),
            format: 'binary',
            entrypoint: 'bin/copis-http-api-server',
            required: true,
          },
        },
      },
    },
  }
}

function spawnFixture(records: SpawnRecord[]): HttpApiSpawn {
  return ((file: string, args: readonly string[], options: SpawnOptions) => {
    const child = new FakeChild()
    records.push({ file, args, options, child })
    return child as unknown as ReturnType<HttpApiSpawn>
  }) as HttpApiSpawn
}

function fetchFixture(
  manifest: Record<string, unknown>,
  binaryContent: string,
  health: (port: string) => boolean,
): FunctionalModuleFetch {
  return async (input) => {
    if (input.includes('/api/health')) {
      return health(new URL(input).port)
        ? new Response(JSON.stringify({ ok: true, service: 'copis-http-api' }), { status: 200 })
        : new Response(JSON.stringify({ ok: false }), { status: 503 })
    }
    if (input.endsWith('/manifest.json')) return new Response(JSON.stringify(manifest), { status: 200 })
    if (input.startsWith('https://download.example.com/rust-http-api-')) {
      return new Response(binaryContent, {
        status: 200,
        headers: { 'content-length': String(Buffer.byteLength(binaryContent)) },
      })
    }
    return new Response('not found', { status: 404 })
  }
}

describe('Rust HTTP API 功能模块生命周期', () => {
  test('打包环境缺少 active 模块时不在后台安装，开发环境保留初始化兼容路径', () => {
    expect(shouldInstallMissingHttpApiModule(true)).toBe(false)
    expect(shouldInstallMissingHttpApiModule(false)).toBe(true)
  })

  test('health 必须匹配 Copis HTTP API 服务身份', async () => {
    const fetchImpl: FunctionalModuleFetch = async () => (
      new Response(JSON.stringify({ ok: true, service: 'other-service' }), { status: 200 })
    )

    await expect(waitForHttpApiHealth(51740, {
      fetchImpl,
      healthTimeoutMs: 1,
    })).resolves.toBe(false)
  })

  test('开发环境只从 Cargo 产物候选启动，不回退 resources/bin', () => {
    const candidates = resolveDevelopmentRustBinaryCandidates('/tmp/copis/dist', 'copis-http-api-server')

    expect(candidates).toEqual([
      resolve('/tmp/copis/dist', '../../..', 'native/http-api-server/target/release/copis-http-api-server'),
      resolve('/tmp/copis/dist', '../../..', 'native/http-api-server/target/debug/copis-http-api-server'),
    ])
    expect(candidates.some((candidate) => candidate.includes('/resources/bin/'))).toBe(false)
  })

  test('active Rust API 从功能模块版本目录启动并使用开发端口', async () => {
    const root = createRoot()
    const packageInfo = rustPackage('0.1.0', 'old-rust-api')
    const activePath = await activateRustVersion(root, packageInfo, 'old-rust-api')
    const records: SpawnRecord[] = []

    startHttpApiServer({ rootDir: join(root, 'modules'), spawnImpl: spawnFixture(records) })

    expect(records).toHaveLength(1)
    expect(records[0]?.file).toBe(activePath)
    expect(records[0]?.options.env?.COPIS_HTTP_API_PORT).toBe('51740')
  })

  test('打包版 Rust API 使用自包含 Copis 二进制启动 Pi Worker', async () => {
    const root = createRoot()
    const packageInfo = rustPackage('0.1.0', 'packaged-rust-api')
    await activateRustVersion(root, packageInfo, 'packaged-rust-api')
    const records: SpawnRecord[] = []

    startHttpApiServer({
      rootDir: join(root, 'modules'),
      spawnImpl: spawnFixture(records),
      workerLaunch: {
        kind: 'executable',
        path: 'C:\\Program Files\\Copis\\resources\\bin\\win32-x64\\copis.exe',
      },
    })

    expect(records).toHaveLength(1)
    expect(records[0]?.options.env?.COPIS_PI_RPC_EXECUTABLE).toBe(
      'C:\\Program Files\\Copis\\resources\\bin\\win32-x64\\copis.exe',
    )
    expect(records[0]?.options.env?.COPIS_CLI).toBe(
      'C:\\Program Files\\Copis\\resources\\bin\\win32-x64\\copis.exe',
    )
    expect(records[0]?.options.env?.COPIS_PI_RPC_WORKER).toBeUndefined()
  })

  test('Rust 启动环境注入已选 edu-api 根地址和 working-model 地址', async () => {
    const root = createRoot()
    const packageInfo = rustPackage('0.1.0', 'endpoint-aware-rust-api')
    await activateRustVersion(root, packageInfo, 'endpoint-aware-rust-api')
    const records: SpawnRecord[] = []
    const previousBackendUrl = process.env.COPIS_BACKEND_URL
    const previousModelBaseUrl = process.env.WORKING_AGENT_MODEL_BASE_URL

    try {
      const options = await prepareHttpApiBackend({
        rootDir: join(root, 'modules'),
        backendUrl: 'https://configured.example.test',
        modelBaseUrl: 'https://configured.example.test/api/internal/working-model',
        endpointConfigUrl: 'https://config.example.test/endpoints.json',
        fetchImpl: async (input) => {
          if (input.endsWith('/endpoints.json')) {
            return new Response(JSON.stringify({
              base_urls: ['https://healthy.example.test/api/internal/working-model'],
            }), { status: 200 })
          }
          if (input === 'https://healthy.example.test/health') return new Response('', { status: 200 })
          return new Response('', { status: 404 })
        },
      })
      startHttpApiServer({ ...options, spawnImpl: spawnFixture(records) })

      expect(records[0]?.options.env?.COPIS_BACKEND_URL).toBe('https://healthy.example.test')
      expect(records[0]?.options.env?.WORKING_AGENT_MODEL_BASE_URL).toBe(
        'https://healthy.example.test/api/internal/working-model',
      )
    } finally {
      if (previousBackendUrl === undefined) delete process.env.COPIS_BACKEND_URL
      else process.env.COPIS_BACKEND_URL = previousBackendUrl
      if (previousModelBaseUrl === undefined) delete process.env.WORKING_AGENT_MODEL_BASE_URL
      else process.env.WORKING_AGENT_MODEL_BASE_URL = previousModelBaseUrl
    }
  })

  test('开发版脚本 Worker 使用系统 Bun 标记，不回退托管 Node runtime', async () => {
    const root = createRoot()
    const packageInfo = rustPackage('0.1.0', 'development-rust-api')
    await activateRustVersion(root, packageInfo, 'development-rust-api')
    const records: SpawnRecord[] = []

    startHttpApiServer({
      rootDir: join(root, 'modules'),
      spawnImpl: spawnFixture(records),
      workerLaunch: {
        kind: 'script',
        path: '/repo/apps/electron/dist/pi-rpc-worker.cjs',
      },
    })

    const env = records[0]?.options.env
    expect(env?.COPIS_PI_RPC_WORKER).toBe('/repo/apps/electron/dist/pi-rpc-worker.cjs')
    expect(env?.COPIS_PI_RPC_USE_SYSTEM_RUNTIME).toBe('1')
    expect(env?.COPIS_PI_RPC_EXECUTABLE).toBeUndefined()
  })

  test('候选版本健康检查通过后切换 active 和开发进程', async () => {
    const root = createRoot()
    const oldPackage = rustPackage('0.1.0', 'old-rust-api')
    await activateRustVersion(root, oldPackage, 'old-rust-api')
    const newContent = 'new-rust-api'
    const records: SpawnRecord[] = []
    const manifestUrl = 'https://download.example.com/manifest.json'

    startHttpApiServer({ rootDir: join(root, 'modules'), spawnImpl: spawnFixture(records) })
    const updated = await updateHttpApiServer({
      rootDir: join(root, 'modules'),
      manifestUrl,
      platform: 'darwin',
      arch: 'arm64',
      clientVersion: '0.16.17',
      spawnImpl: spawnFixture(records),
      fetchImpl: fetchFixture(manifestFor('0.2.0', newContent), newContent, () => true),
      healthTimeoutMs: 100,
      stopTimeoutMs: 5,
    })

    const active = readActiveFunctionalModule(getFunctionalModulePaths(join(root, 'modules')), 'rust-http-api')
    expect(updated).toBe(true)
    expect(active?.version).toBe('0.2.0')
    expect(records).toHaveLength(3)
    expect(records[1]?.options.env?.COPIS_HTTP_API_PORT).toBe('51741')
    expect(records[2]?.options.env?.COPIS_HTTP_API_PORT).toBe('51740')
    expect(records[0]?.child.killed).toBe(true)
  })

  test('候选健康检查失败时保留旧版本并终止候选进程', async () => {
    const root = createRoot()
    const oldPackage = rustPackage('0.1.0', 'old-rust-api')
    await activateRustVersion(root, oldPackage, 'old-rust-api')
    const records: SpawnRecord[] = []
    const manifestUrl = 'https://download.example.com/manifest.json'

    startHttpApiServer({ rootDir: join(root, 'modules'), spawnImpl: spawnFixture(records) })
    const updated = await updateHttpApiServer({
      rootDir: join(root, 'modules'),
      manifestUrl,
      platform: 'darwin',
      arch: 'arm64',
      clientVersion: '0.16.17',
      spawnImpl: spawnFixture(records),
      fetchImpl: fetchFixture(manifestFor('0.2.0', 'new-rust-api'), 'new-rust-api', (port) => port !== '51741'),
      healthTimeoutMs: 50,
      stopTimeoutMs: 5,
    })

    const active = readActiveFunctionalModule(getFunctionalModulePaths(join(root, 'modules')), 'rust-http-api')
    expect(updated).toBe(false)
    expect(active?.version).toBe('0.1.0')
    expect(records).toHaveLength(2)
    expect(records[0]?.child.killed).toBe(false)
    expect(records[1]?.child.killed).toBe(true)
  })

  test('开发端口健康检查失败时恢复旧 active 并重启旧进程', async () => {
    const root = createRoot()
    const oldPackage = rustPackage('0.1.0', 'old-rust-api')
    await activateRustVersion(root, oldPackage, 'old-rust-api')
    const records: SpawnRecord[] = []
    const manifestUrl = 'https://download.example.com/manifest.json'
    let formalProbeCount = 0

    startHttpApiServer({ rootDir: join(root, 'modules'), spawnImpl: spawnFixture(records) })
    const updated = await updateHttpApiServer({
      rootDir: join(root, 'modules'),
      manifestUrl,
      platform: 'darwin',
      arch: 'arm64',
      clientVersion: '0.16.17',
      spawnImpl: spawnFixture(records),
      fetchImpl: fetchFixture(
        manifestFor('0.2.0', 'new-rust-api'),
        'new-rust-api',
        (port) => port === '51741' || (port === '51740' && formalProbeCount++ > 0),
      ),
      healthTimeoutMs: 50,
      stopTimeoutMs: 5,
    })

    const active = readActiveFunctionalModule(getFunctionalModulePaths(join(root, 'modules')), 'rust-http-api')
    expect(updated).toBe(false)
    expect(active?.version).toBe('0.1.0')
    expect(records).toHaveLength(4)
    expect(records[2]?.child.killed).toBe(true)
    expect(records[3]?.options.env?.COPIS_HTTP_API_PORT).toBe('51740')
    expect(readFileSync(active?.path ?? '', 'utf8')).toBe('old-rust-api')
  })
})
