import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { SpawnOptions } from 'node:child_process'
import { afterEach, describe, expect, test, mock } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    isPackaged: true,
    getPath: () => '/tmp/copis-http-api-runtime-test',
  },
  BrowserWindow: class {},
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

const {
  startHttpApiServer,
  stopHttpApiServer,
  updateHttpApiServer,
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
        ? new Response(JSON.stringify({ ok: true }), { status: 200 })
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
  test('active Rust API 从功能模块版本目录启动并使用正式端口', async () => {
    const root = createRoot()
    const packageInfo = rustPackage('0.1.0', 'old-rust-api')
    const activePath = await activateRustVersion(root, packageInfo, 'old-rust-api')
    const records: SpawnRecord[] = []

    startHttpApiServer({ rootDir: join(root, 'modules'), spawnImpl: spawnFixture(records) })

    expect(records).toHaveLength(1)
    expect(records[0]?.file).toBe(activePath)
    expect(records[0]?.options.env?.COPIS_HTTP_API_PORT).toBe('51730')
  })

  test('候选版本健康检查通过后切换 active 和正式进程', async () => {
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
    expect(records[1]?.options.env?.COPIS_HTTP_API_PORT).toBe('51731')
    expect(records[2]?.options.env?.COPIS_HTTP_API_PORT).toBe('51730')
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
      fetchImpl: fetchFixture(manifestFor('0.2.0', 'new-rust-api'), 'new-rust-api', (port) => port !== '51731'),
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

  test('正式端口健康检查失败时恢复旧 active 并重启旧进程', async () => {
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
        (port) => port === '51731' || (port === '51730' && formalProbeCount++ > 0),
      ),
      healthTimeoutMs: 50,
      stopTimeoutMs: 5,
    })

    const active = readActiveFunctionalModule(getFunctionalModulePaths(join(root, 'modules')), 'rust-http-api')
    expect(updated).toBe(false)
    expect(active?.version).toBe('0.1.0')
    expect(records).toHaveLength(4)
    expect(records[2]?.child.killed).toBe(true)
    expect(records[3]?.options.env?.COPIS_HTTP_API_PORT).toBe('51730')
    expect(readFileSync(active?.path ?? '', 'utf8')).toBe('old-rust-api')
  })
})
