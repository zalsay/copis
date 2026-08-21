import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { execFileSync, type SpawnOptions } from 'node:child_process'
import { afterAll, afterEach, describe, expect, test, mock } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

let packaged = false

mock.module('electron', () => ({
  app: {
    get isPackaged() { return packaged },
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
  prepareDevelopmentAlipayBotCli,
  prepareHttpApiBackend,
  resolveDevelopmentRustBinaryCandidates,
  startHttpApiServer,
  stopHttpApiServer,
  shouldInstallMissingHttpApiModule,
  ensureRustHttpApiServerReady,
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

function paymentWorkspaceFor(root: string): { slug: 'default'; projectRootPath: string; projectPath: string } {
  const projectRootPath = join(root, 'default-workspace')
  const projectPath = join(projectRootPath, 'project')
  mkdirSync(projectPath, { recursive: true })
  return { slug: 'default', projectRootPath, projectPath }
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

function binaryPackage(
  name: string,
  version: string,
  entrypoint: string,
  content: string,
): FunctionalModulePackage {
  return {
    name,
    version,
    sha256: createHash('sha256').update(content).digest('hex'),
    size: Buffer.byteLength(content),
    format: 'binary',
    entrypoint,
    required: true,
  }
}

async function activateRustVersion(root: string, packageInfo: FunctionalModulePackage, content: string): Promise<string> {
  return activateModuleVersion(join(root, 'modules'), packageInfo, content)
}

async function activateModuleVersion(
  modulesRoot: string,
  packageInfo: FunctionalModulePackage,
  content: string,
): Promise<string> {
  mkdirSync(modulesRoot, { recursive: true })
  const source = join(modulesRoot, `${packageInfo.name}-${packageInfo.version}.source`)
  writeFileSync(source, content)
  const paths = getFunctionalModulePaths(modulesRoot)
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

function encodeHex(value: string): string {
  return Buffer.from(value, 'utf8').toString('hex')
}

function spawnFixture(records: SpawnRecord[], onSpawn?: (record: SpawnRecord) => void): HttpApiSpawn {
  return ((file: string, args: readonly string[], options: SpawnOptions) => {
    const child = new FakeChild()
    const record = { file, args, options, child }
    records.push(record)
    onSpawn?.(record)
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

    startHttpApiServer({
      rootDir: join(root, 'modules'),
      paymentWorkspace: paymentWorkspaceFor(root),
      spawnImpl: spawnFixture(records),
    })

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
      paymentWorkspace: paymentWorkspaceFor(root),
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
      })
      startHttpApiServer({
        ...options,
        paymentWorkspace: paymentWorkspaceFor(root),
        spawnImpl: spawnFixture(records),
      })

      expect(records[0]?.options.env?.COPIS_BACKEND_URL).toBe('https://configured.example.test')
      expect(records[0]?.options.env?.WORKING_AGENT_MODEL_BASE_URL).toBe(
        'https://configured.example.test/api/internal/working-model',
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
      paymentWorkspace: paymentWorkspaceFor(root),
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

  test('Given 默认支付项目 When 启动 Rust API Then 注入固定 Pi 工作区环境', async () => {
    const root = createRoot()
    const projectRootPath = join(root, 'default-workspace')
    const projectPath = join(projectRootPath, 'project')
    mkdirSync(projectPath, { recursive: true })
    const records: SpawnRecord[] = []
    const packageInfo = rustPackage('0.1.0', 'payment-rust-api')
    await activateRustVersion(root, packageInfo, 'payment-rust-api')

    startHttpApiServer({
      rootDir: join(root, 'modules'),
      paymentWorkspace: paymentWorkspaceFor(root),
      spawnImpl: spawnFixture(records),
    })

    expect(records[0]?.options.env).toMatchObject({
      COPIS_PAYMENT_WORKSPACE_SLUG: 'default',
      COPIS_PAYMENT_WORKSPACE_PROJECT_ROOT: realpathSync(projectRootPath),
      COPIS_PAYMENT_WORKSPACE_CWD: realpathSync(projectPath),
      COPIS_PAYMENT_HOME_ROOT: join(realpathSync(projectRootPath), '.copis', 'payment'),
    })
  })

  test('Given 已激活的受控 CLI 模块 When 启动 Rust API Then 注入全部绝对入口', async () => {
    const root = createRoot()
    const modulesRoot = join(root, 'modules')
    const records: SpawnRecord[] = []
    const rust = rustPackage('0.1.0', 'payment-rust-api')
    const node = binaryPackage('node-runtime', '24.0.0', 'bin/node', 'node-runtime')
    const alipayBot = binaryPackage('alipay-bot', '0.3.40', 'bin/alipay-bot', 'alipay-bot')
    const officeCli = binaryPackage('officecli', '1.0.143', 'bin/officecli', 'officecli')
    await activateRustVersion(root, rust, 'payment-rust-api')
    const nodePath = await activateModuleVersion(modulesRoot, node, 'node-runtime')
    const alipayBotPath = await activateModuleVersion(modulesRoot, alipayBot, 'alipay-bot')
    const officeCliPath = await activateModuleVersion(modulesRoot, officeCli, 'officecli')

    startHttpApiServer({
      rootDir: modulesRoot,
      paymentWorkspace: paymentWorkspaceFor(root),
      spawnImpl: spawnFixture(records),
    })

    expect(records[0]?.options.env).toMatchObject({
      COPIS_ALIPAY_BOT_CLI: alipayBotPath,
      COPIS_ALIPAY_BOT_NODE: nodePath,
      COPIS_OFFICECLI: officeCliPath,
    })
  })

  test('Given 未配置 CLI When 开发模式存在本地归档 Then 解压并返回隔离 CLI 入口', () => {
    const root = createRoot()
    const moduleDir = join(root, 'isolated-module')
    const staging = join(root, 'staging')
    const platform = process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin'
    const architecture = process.arch === 'arm64' ? 'arm64' : 'x64'
    const binName = platform === 'win32' ? 'alipay-bot.cmd' : 'alipay-bot'
    const archiveDir = join(root, 'apps/electron/resources/alipay-bot')
    mkdirSync(join(staging, 'bin'), { recursive: true })
    const cli = join(staging, 'bin', binName)
    writeFileSync(cli, platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 })
    if (platform !== 'win32') chmodSync(cli, 0o755)
    mkdirSync(archiveDir, { recursive: true })
    execFileSync('tar', [
      '--format=pax',
      '-czf',
      join(archiveDir, `${platform}-${architecture}.tar.gz`),
      '-C',
      staging,
      '.',
    ], { stdio: 'ignore' })

    const previousModuleDir = process.env.COPIS_DEV_ALIPAY_BOT_DIR
    const previousCliEnv = process.env.COPIS_ALIPAY_BOT_CLI
    process.env.COPIS_DEV_ALIPAY_BOT_DIR = moduleDir
    delete process.env.COPIS_ALIPAY_BOT_CLI
    try {
      const prepared = prepareDevelopmentAlipayBotCli(root)
      expect(prepared).toBe(join(moduleDir, 'bin', binName))
      expect(prepared && existsSync(prepared)).toBe(true)
    } finally {
      if (previousModuleDir === undefined) delete process.env.COPIS_DEV_ALIPAY_BOT_DIR
      else process.env.COPIS_DEV_ALIPAY_BOT_DIR = previousModuleDir
      if (previousCliEnv === undefined) delete process.env.COPIS_ALIPAY_BOT_CLI
      else process.env.COPIS_ALIPAY_BOT_CLI = previousCliEnv
    }
  })

  test('Given 开发环境显式 CLI When 启动 Rust API Then 优先注入开发入口', async () => {
    const root = createRoot()
    const developmentCli = join(root, 'development-alipay-bot')
    const developmentNode = join(root, 'development-node')
    writeFileSync(developmentCli, 'development-alipay-bot')
    writeFileSync(developmentNode, 'development-node')
    const records: SpawnRecord[] = []
    await activateRustVersion(root, rustPackage('0.1.0', 'payment-rust-api'), 'payment-rust-api')
    const previousCli = process.env.COPIS_ALIPAY_BOT_CLI
    const previousNode = process.env.COPIS_ALIPAY_BOT_NODE
    process.env.COPIS_ALIPAY_BOT_CLI = developmentCli
    process.env.COPIS_ALIPAY_BOT_NODE = developmentNode

    try {
      startHttpApiServer({
        rootDir: join(root, 'modules'),
        paymentWorkspace: paymentWorkspaceFor(root),
        spawnImpl: spawnFixture(records),
      })
      expect(records[0]?.options.env).toMatchObject({
        COPIS_ALIPAY_BOT_CLI: developmentCli,
        COPIS_ALIPAY_BOT_NODE: developmentNode,
      })
    } finally {
      if (previousCli === undefined) delete process.env.COPIS_ALIPAY_BOT_CLI
      else process.env.COPIS_ALIPAY_BOT_CLI = previousCli
      if (previousNode === undefined) delete process.env.COPIS_ALIPAY_BOT_NODE
      else process.env.COPIS_ALIPAY_BOT_NODE = previousNode
    }
  })

  test('Given 非默认支付项目 When 启动 Rust API Then 拒绝启动子进程', async () => {
    const root = createRoot()
    const projectRootPath = join(root, 'other-workspace')
    const projectPath = join(projectRootPath, 'project')
    mkdirSync(projectPath, { recursive: true })
    const records: SpawnRecord[] = []
    const packageInfo = rustPackage('0.1.0', 'payment-rust-api')
    await activateRustVersion(root, packageInfo, 'payment-rust-api')

    startHttpApiServer({
      rootDir: join(root, 'modules'),
      paymentWorkspace: { slug: 'other', projectRootPath, projectPath },
      spawnImpl: spawnFixture(records),
    })

    expect(records).toHaveLength(0)
  })

  test('Given 默认支付项目路径是文件 When 启动 Rust API Then 拒绝启动子进程', async () => {
    const root = createRoot()
    const projectRootPath = join(root, 'default-workspace')
    const projectPath = join(projectRootPath, 'project-file')
    mkdirSync(projectRootPath, { recursive: true })
    writeFileSync(projectPath, 'not a project directory')
    const records: SpawnRecord[] = []
    const packageInfo = rustPackage('0.1.0', 'payment-rust-api')
    await activateRustVersion(root, packageInfo, 'payment-rust-api')

    startHttpApiServer({
      rootDir: join(root, 'modules'),
      paymentWorkspace: { slug: 'default', projectRootPath, projectPath },
      spawnImpl: spawnFixture(records),
    })

    expect(records).toHaveLength(0)
  })

  test('候选版本健康检查通过后切换 active 和开发进程', async () => {
    const root = createRoot()
    const oldPackage = rustPackage('0.1.0', 'old-rust-api')
    await activateRustVersion(root, oldPackage, 'old-rust-api')
    const newContent = 'new-rust-api'
    const records: SpawnRecord[] = []
    const manifestUrl = 'https://download.example.com/manifest.json'

    startHttpApiServer({
      rootDir: join(root, 'modules'),
      paymentWorkspace: paymentWorkspaceFor(root),
      spawnImpl: spawnFixture(records),
    })
    const updated = await updateHttpApiServer({
      rootDir: join(root, 'modules'),
      paymentWorkspace: paymentWorkspaceFor(root),
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

  test('正式版本健康检查期间收到业务桥请求时，响应不会因尚未完成切换而丢失', async () => {
    const root = createRoot()
    const oldPackage = rustPackage('0.1.0', 'old-rust-api')
    await activateRustVersion(root, oldPackage, 'old-rust-api')
    const newContent = 'new-rust-api-with-bridge'
    const records: SpawnRecord[] = []
    let bridgeResponse = ''

    startHttpApiServer({
      rootDir: join(root, 'modules'),
      paymentWorkspace: paymentWorkspaceFor(root),
      spawnImpl: spawnFixture(records),
    })
    const updated = await updateHttpApiServer({
      rootDir: join(root, 'modules'),
      paymentWorkspace: paymentWorkspaceFor(root),
      manifestUrl: 'https://download.example.com/manifest.json',
      platform: 'darwin',
      arch: 'arm64',
      clientVersion: '0.16.17',
      spawnImpl: spawnFixture(records, (record) => {
        if (record.options.env?.COPIS_HTTP_API_PORT !== '51740') return
        record.child.stdin.setEncoding('utf8')
        record.child.stdin.on('data', (chunk) => { bridgeResponse += String(chunk) })
        setTimeout(() => {
          record.child.stdout.write(
            `1\t${encodeHex('GET')}\t${encodeHex('/api/internal/auth-storage/load')}\t\n`,
          )
        }, 0)
      }),
      fetchImpl: fetchFixture(
        manifestFor('0.2.0', newContent),
        newContent,
        () => true,
      ),
      healthTimeoutMs: 100,
      stopTimeoutMs: 5,
    })

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
    expect(updated).toBe(true)
    expect(bridgeResponse).toMatch(/^1\t200\t/)
  })

  test('正式启动前发现 Rust API 旧版本时，先更新并健康检查再启动正式端口', async () => {
    const root = createRoot()
    const oldPackage = rustPackage('0.1.0', 'old-rust-api')
    const newContent = 'new-rust-api-before-window'
    await activateRustVersion(root, oldPackage, 'old-rust-api')
    const records: SpawnRecord[] = []
    const manifestUrl = 'https://download.example.com/manifest.json'
    const previousResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath

    packaged = true
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: '/tmp/copis-test-resources',
    })
    try {
      await ensureRustHttpApiServerReady({
        rootDir: join(root, 'modules'),
        paymentWorkspace: paymentWorkspaceFor(root),
        manifestUrl,
        platform: 'darwin',
        arch: 'arm64',
        clientVersion: '0.16.17',
        spawnImpl: spawnFixture(records),
        fetchImpl: fetchFixture(manifestFor('0.2.0', newContent), newContent, () => true),
        healthTimeoutMs: 100,
        stopTimeoutMs: 5,
        workerLaunch: {
          kind: 'executable',
          path: '/tmp/copis-test-runtime',
        },
      })

      const active = readActiveFunctionalModule(getFunctionalModulePaths(join(root, 'modules')), 'rust-http-api')
      expect(active?.version).toBe('0.2.0')
      expect(records).toHaveLength(2)
      expect(records[0]?.options.env?.COPIS_HTTP_API_PORT).toBe('51741')
      expect(records[1]?.options.env?.COPIS_HTTP_API_PORT).toBe('51740')
      expect(records[0]?.child.killed).toBe(true)
    } finally {
      packaged = false
      if (previousResourcesPath === undefined) {
        Object.defineProperty(process, 'resourcesPath', {
          configurable: true,
          value: undefined,
        })
      } else {
        Object.defineProperty(process, 'resourcesPath', {
          configurable: true,
          value: previousResourcesPath,
        })
      }
    }
  })

  test('候选健康检查失败时保留旧版本并终止候选进程', async () => {
    const root = createRoot()
    const oldPackage = rustPackage('0.1.0', 'old-rust-api')
    await activateRustVersion(root, oldPackage, 'old-rust-api')
    const records: SpawnRecord[] = []
    const manifestUrl = 'https://download.example.com/manifest.json'

    startHttpApiServer({
      rootDir: join(root, 'modules'),
      paymentWorkspace: paymentWorkspaceFor(root),
      spawnImpl: spawnFixture(records),
    })
    const updated = await updateHttpApiServer({
      rootDir: join(root, 'modules'),
      paymentWorkspace: paymentWorkspaceFor(root),
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

    startHttpApiServer({
      rootDir: join(root, 'modules'),
      paymentWorkspace: paymentWorkspaceFor(root),
      spawnImpl: spawnFixture(records),
    })
    const updated = await updateHttpApiServer({
      rootDir: join(root, 'modules'),
      paymentWorkspace: paymentWorkspaceFor(root),
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
