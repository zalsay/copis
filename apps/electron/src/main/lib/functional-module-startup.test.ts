import { describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { FunctionalModuleArtifact, FunctionalModuleStartupProgressPayload } from '@copis/shared'
import { FUNCTIONAL_MODULE_IPC_CHANNELS } from '@copis/shared'
import {
  activateFunctionalModule,
  assembleFunctionalModule,
  cacheFunctionalModule,
  getFunctionalModulePaths,
  type FunctionalModulePackage,
} from './functional-module-store'

mock.module('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/copis-functional-module-startup-test',
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

const {
  mapHealthProgress,
  mapModuleProgress,
  assertRequiredModuleArtifacts,
  ensureRequiredFunctionalModules,
  toStartupError,
} = await import('./functional-module-startup')
const { startHttpApiServer, stopHttpApiServer } = await import('./http-api-server')
import type { HttpApiSpawn } from './http-api-server'

async function activateModuleVersion(
  modulesRoot: string,
  packageInfo: FunctionalModulePackage,
  content: Buffer | string,
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

class StartupFakeChild extends EventEmitter {
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

function createTarGz(files: Record<string, string>): Buffer {
  const entries = Object.entries(files).flatMap(([path, content]) => {
    const body = Buffer.from(content)
    const header = Buffer.alloc(512)
    header.write(path)
    header.write(`${body.byteLength.toString(8).padStart(11, '0')}\0`, 124)
    header[156] = '0'.charCodeAt(0)
    const padding = Buffer.alloc((512 - (body.byteLength % 512)) % 512)
    return [header, body, padding]
  })
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]))
}

describe('登录后功能模块启动契约', () => {
  test('定义独立的启动进度 IPC 和 health 阶段', () => {
    const progress: FunctionalModuleStartupProgressPayload = {
      phase: 'health',
      detail: '正在检查本地服务',
      progress: 0.97,
      activeModule: 'rust-http-api',
    }

    expect(FUNCTIONAL_MODULE_IPC_CHANNELS.STARTUP_PROGRESS).toBe('functional-module:startup-progress')
    expect(FUNCTIONAL_MODULE_IPC_CHANNELS.ENSURE_REQUIRED).toBe('functional-module:ensure-required')
    expect(progress.phase).toBe('health')
  })

  test('模块阶段最多推进到 95%，health 阶段占最后 5%', () => {
    expect(mapModuleProgress(0, 0, 0.5)).toBe(0.05)
    expect(mapModuleProgress(0.5, 0, 0.5)).toBeCloseTo(0.275)
    expect(mapModuleProgress(1, 0.5, 0.5)).toBe(0.95)
    expect(mapHealthProgress(0)).toBe(0.95)
    expect(mapHealthProgress(0.8)).toBe(0.99)
    expect(mapHealthProgress(1)).toBe(1)
  })

  test('错误消息不泄露 COS secret 或内部 token', () => {
    expect(toStartupError(new Error('COS_SECRET_KEY=secret /internal token'))).not.toContain('secret')
    expect(toStartupError(new Error('OfficeCLI 安装失败'))).toBe('必要组件准备失败，请重试')
    expect(toStartupError(new Error('系统核心模块未通过运行检查'))).toBe('系统核心模块运行检查未通过，请重试')
  })

  test('OfficeCLI 和 Rust API 都必须由 manifest 标记为必选', () => {
    const artifacts: FunctionalModuleArtifact[] = [
      {
        name: 'officecli',
        version: '1.0.143',
        platform: 'darwin',
        arch: 'arm64',
        url: 'https://download.example.com/officecli',
        sha256: 'a'.repeat(64),
        size: 10,
        format: 'binary',
        entrypoint: 'bin/officecli',
        required: false,
      },
      {
        name: 'rust-http-api',
        version: '0.1.2',
        platform: 'darwin',
        arch: 'arm64',
        url: 'https://download.example.com/rust',
        sha256: 'b'.repeat(64),
        size: 10,
        format: 'binary',
        entrypoint: 'bin/copis-http-api-server',
        required: true,
      },
    ]

    expect(() => assertRequiredModuleArtifacts(artifacts)).toThrow('Office 文档支持必须是必要组件')
  })

  test('自动启动流程拒绝可选 OfficeCLI manifest', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'copis-functional-module-startup-'))
    try {
      const manifest = {
        schema: 1,
        channel: 'stable',
        platforms: {
          'darwin-arm64': {
            modules: {
              officecli: {
                version: '1.0.143',
                url: 'https://download.example.com/officecli',
                sha256: 'a'.repeat(64),
                size: 10,
                format: 'binary',
                entrypoint: 'bin/officecli',
                required: false,
              },
              'rust-http-api': {
                version: '0.1.2',
                url: 'https://download.example.com/rust',
                sha256: 'b'.repeat(64),
                size: 10,
                format: 'binary',
                entrypoint: 'bin/copis-http-api-server',
                required: true,
              },
            },
          },
        },
      }

      const options = {
        rootDir,
        manifestUrl: 'https://download.example.com/manifest.json',
        platform: 'darwin' as const,
        arch: 'arm64' as const,
        clientVersion: '0.0.4',
        fetchImpl: async () => new Response(JSON.stringify(manifest), { status: 200 }),
      }
      const first = ensureRequiredFunctionalModules(options)
      const second = ensureRequiredFunctionalModules(options)
      expect(second).toBe(first)
      await expect(first).rejects.toThrow('必要组件准备失败，请重试')
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  test('开发模式只检查 API health，不获取 manifest 或模块状态', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'copis-functional-module-startup-dev-'))
    const binaryPath = join(rootDir, 'copis-http-api-server')
    writeFileSync(binaryPath, 'development-binary')
    const previousBinary = process.env.COPIS_HTTP_API_SERVER
    process.env.COPIS_HTTP_API_SERVER = binaryPath
    const records: Array<{ child: StartupFakeChild; port: string | undefined }> = []
    const requests: string[] = []
    const progress: FunctionalModuleStartupProgressPayload[] = []
    const spawnImpl = ((_, _args, options) => {
      const child = new StartupFakeChild()
      records.push({ child, port: options.env?.COPIS_HTTP_API_PORT })
      return child as unknown as ReturnType<HttpApiSpawn>
    }) as HttpApiSpawn

    try {
      const statuses = await ensureRequiredFunctionalModules({
        rootDir: join(rootDir, 'modules'),
        skipModuleUpdates: true,
        fetchImpl: async (input) => {
          requests.push(input)
          if (!input.includes('/api/health')) throw new Error(`不应请求开发模式模块地址: ${input}`)
          return new Response(JSON.stringify({ ok: true, service: 'copis-http-api' }), { status: 200 })
        },
        spawnImpl,
        healthTimeoutMs: 10,
        stopTimeoutMs: 5,
        onProgress: (payload) => progress.push(payload),
      })

      expect(statuses).toEqual([])
      expect(requests).toEqual(['http://127.0.0.1:51740/api/health'])
      expect(records.map((record) => record.port)).toEqual(['51740'])
      expect(progress.at(-1)).toMatchObject({ phase: 'ready', progress: 1, activeModule: 'rust-http-api' })
    } finally {
      await stopHttpApiServer(5)
      if (previousBinary === undefined) delete process.env.COPIS_HTTP_API_SERVER
      else process.env.COPIS_HTTP_API_SERVER = previousBinary
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  test('完整启动流程先完成模块阶段，再用最后 5% 检查正式 API health', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'copis-functional-module-startup-success-'))
    const officeContent = 'officecli-startup-binary'
    const rustContent = 'rust-http-api-startup-binary'
    const nodeContent = createTarGz({ 'bin/node': 'node-runtime-binary', 'bin/npm': 'npm-runtime-launcher' })
    const alipayBotContent = createTarGz({
      'bin/alipay-bot': 'alipay-bot-launcher',
      'runtime/dist/cli.js': 'alipay-bot-cli',
    })
    const moduleArtifact = (name: 'officecli' | 'rust-http-api', version: string, content: string) => ({
      version,
      url: `https://download.example.com/${name}-${version}`,
      sha256: createHash('sha256').update(content).digest('hex'),
      size: Buffer.byteLength(content),
      format: 'binary' as const,
      entrypoint: name === 'officecli' ? 'bin/officecli' : 'bin/copis-http-api-server',
      required: true,
    })
    const manifest = {
      schema: 1,
      channel: 'stable',
      platforms: {
        'darwin-arm64': {
          modules: {
            'node-runtime': {
              version: '22.21.1',
              url: 'https://download.example.com/node-runtime-22.21.1.tar.gz',
              sha256: createHash('sha256').update(nodeContent).digest('hex'),
              size: nodeContent.byteLength,
              format: 'tar.gz' as const,
              entrypoint: 'bin/node',
              required: true,
            },
            officecli: moduleArtifact('officecli', '1.0.143', officeContent),
            'alipay-bot': {
              version: '0.3.40',
              url: 'https://download.example.com/alipay-bot-0.3.40.tar.gz',
              sha256: createHash('sha256').update(alipayBotContent).digest('hex'),
              size: alipayBotContent.byteLength,
              format: 'tar.gz' as const,
              entrypoint: 'bin/alipay-bot',
              required: true,
            },
            'rust-http-api': moduleArtifact('rust-http-api', '0.1.2', rustContent),
          },
        },
      },
    }
    const records: Array<{
      file: string
      child: StartupFakeChild
      port: string | undefined
      runtimeRoot?: string
      alipayBotCli?: string
      alipayBotNode?: string
    }> = []
    const spawnImpl = ((file, _args, options) => {
      const child = new StartupFakeChild()
      records.push({
        file,
        child,
        port: options.env?.COPIS_HTTP_API_PORT,
        runtimeRoot: typeof options.env?.COPIS_RUNTIME_ROOT === 'string' ? options.env.COPIS_RUNTIME_ROOT : undefined,
        alipayBotCli: typeof options.env?.COPIS_ALIPAY_BOT_CLI === 'string' ? options.env.COPIS_ALIPAY_BOT_CLI : undefined,
        alipayBotNode: typeof options.env?.COPIS_ALIPAY_BOT_NODE === 'string' ? options.env.COPIS_ALIPAY_BOT_NODE : undefined,
      })
      return child as unknown as ReturnType<HttpApiSpawn>
    }) as HttpApiSpawn
    const progress: FunctionalModuleStartupProgressPayload[] = []
    const fetchImpl = async (input: string): Promise<Response> => {
      if (input.endsWith('/manifest.json')) return new Response(JSON.stringify(manifest), { status: 200 })
      if (input.includes('/api/health')) {
        return new Response(JSON.stringify({ ok: true, service: 'copis-http-api' }), { status: 200 })
      }
      if (input.endsWith('/officecli-1.0.143')) {
        return new Response(officeContent, { status: 200, headers: { 'content-length': String(Buffer.byteLength(officeContent)) } })
      }
      if (input.endsWith('/rust-http-api-0.1.2')) {
        return new Response(rustContent, { status: 200, headers: { 'content-length': String(Buffer.byteLength(rustContent)) } })
      }
      if (input.endsWith('/node-runtime-22.21.1.tar.gz')) {
        return new Response(new Uint8Array(nodeContent), { status: 200, headers: { 'content-length': String(nodeContent.byteLength) } })
      }
      if (input.endsWith('/alipay-bot-0.3.40.tar.gz')) {
        return new Response(new Uint8Array(alipayBotContent), { status: 200, headers: { 'content-length': String(alipayBotContent.byteLength) } })
      }
      return new Response('not found', { status: 404 })
    }

    try {
      const statuses = await ensureRequiredFunctionalModules({
        rootDir: join(rootDir, 'modules'),
        manifestUrl: 'https://download.example.com/manifest.json',
        platform: 'darwin',
        arch: 'arm64',
        clientVersion: '0.0.4',
        fetchImpl,
        spawnImpl,
        healthTimeoutMs: 10,
        stopTimeoutMs: 5,
        onProgress: (payload) => progress.push(payload),
      })

      expect(statuses.map((item) => [item.name, item.installed, item.required])).toEqual([
        ['node-runtime', true, true],
        ['rust-http-api', true, true],
        ['officecli', true, true],
        ['alipay-bot', true, true],
      ])
      expect(progress.some((item) => item.phase === 'modules' && item.progress === 0.95)).toBe(true)
      expect(progress.some((item) => item.phase === 'health' && item.progress >= 0.95)).toBe(true)
      expect(progress.at(-1)).toMatchObject({ phase: 'ready', progress: 1 })
      expect(records.map((record) => record.port)).toEqual(['51741', '51740'])
      expect(records.some((record) => record.runtimeRoot?.includes('/node-runtime/'))).toBe(true)
      expect(records.some((record) => record.alipayBotCli?.includes('/alipay-bot/'))).toBe(true)
      expect(records.some((record) => record.alipayBotNode?.endsWith('/bin/node'))).toBe(true)
    } finally {
      await stopHttpApiServer(5)
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  test('依赖模块更新而 Rust API 未更新时，正式 health 检查前重启 Rust 并注入新入口', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'copis-functional-module-startup-runtime-refresh-'))
    const modulesRoot = join(rootDir, 'modules')
    const oldNodeContent = createTarGz({ 'bin/node': 'old-node', 'bin/npm': 'old-npm' })
    const newNodeContent = createTarGz({ 'bin/node': 'new-node', 'bin/npm': 'new-npm' })
    const oldAlipayBotContent = createTarGz({
      'bin/alipay-bot': 'old-alipay-bot',
      'runtime/dist/cli.js': 'old-cli',
    })
    const newAlipayBotContent = createTarGz({
      'bin/alipay-bot': 'new-alipay-bot',
      'runtime/dist/cli.js': 'new-cli',
    })
    const rustContent = 'stable-rust-http-api'
    const packageArtifact = (
      name: 'node-runtime' | 'alipay-bot' | 'rust-http-api',
      version: string,
      content: Buffer | string,
    ) => ({
      name,
      version,
      url: `https://download.example.com/${name}-${version}`,
      sha256: createHash('sha256').update(content).digest('hex'),
      size: Buffer.byteLength(content),
      format: (name === 'rust-http-api' ? 'binary' : 'tar.gz') as 'binary' | 'tar.gz',
      entrypoint: name === 'rust-http-api' ? 'bin/copis-http-api-server' : name === 'alipay-bot' ? 'bin/alipay-bot' : 'bin/node',
      required: true,
    })
    const oldNode = packageArtifact('node-runtime', '24.19.3', oldNodeContent)
    const newNode = packageArtifact('node-runtime', '24.19.4', newNodeContent)
    const oldAlipayBot = packageArtifact('alipay-bot', '0.3.39', oldAlipayBotContent)
    const newAlipayBot = packageArtifact('alipay-bot', '0.3.40', newAlipayBotContent)
    const rust = packageArtifact('rust-http-api', '0.1.2', rustContent)
    const manifest = {
      schema: 1,
      channel: 'stable',
      platforms: {
        'darwin-arm64': {
          modules: {
            'node-runtime': newNode,
            officecli: {
              version: '1.0.143',
              url: 'https://download.example.com/officecli-1.0.143',
              sha256: createHash('sha256').update('officecli').digest('hex'),
              size: 'officecli'.length,
              format: 'binary' as const,
              entrypoint: 'bin/officecli',
              required: true,
            },
            'alipay-bot': newAlipayBot,
            'rust-http-api': rust,
          },
        },
      },
    }
    const records: Array<{
      file: string
      child: StartupFakeChild
      alipayBotCli?: string
      alipayBotNode?: string
    }> = []
    const spawnImpl = ((file, _args, options) => {
      const child = new StartupFakeChild()
      records.push({
        file,
        child,
        alipayBotCli: typeof options.env?.COPIS_ALIPAY_BOT_CLI === 'string' ? options.env.COPIS_ALIPAY_BOT_CLI : undefined,
        alipayBotNode: typeof options.env?.COPIS_ALIPAY_BOT_NODE === 'string' ? options.env.COPIS_ALIPAY_BOT_NODE : undefined,
      })
      return child as unknown as ReturnType<HttpApiSpawn>
    }) as HttpApiSpawn
    const fetchImpl = async (input: string): Promise<Response> => {
      if (input.endsWith('/manifest.json')) return new Response(JSON.stringify(manifest), { status: 200 })
      if (input.includes('/api/health')) return new Response(JSON.stringify({ ok: true, service: 'copis-http-api' }), { status: 200 })
      if (input.endsWith('/node-runtime-24.19.4')) return new Response(new Uint8Array(newNodeContent), { status: 200 })
      if (input.endsWith('/alipay-bot-0.3.40')) return new Response(new Uint8Array(newAlipayBotContent), { status: 200 })
      if (input.endsWith('/officecli-1.0.143')) return new Response('officecli', { status: 200 })
      return new Response('not found', { status: 404 })
    }

    try {
      await activateModuleVersion(modulesRoot, oldNode, oldNodeContent)
      await activateModuleVersion(modulesRoot, {
        name: 'officecli',
        version: '1.0.143',
        sha256: createHash('sha256').update('officecli').digest('hex'),
        size: 'officecli'.length,
        format: 'binary',
        entrypoint: 'bin/officecli',
        required: true,
      }, 'officecli')
      await activateModuleVersion(modulesRoot, oldAlipayBot, oldAlipayBotContent)
      await activateModuleVersion(modulesRoot, rust, rustContent)
      startHttpApiServer({
        rootDir: modulesRoot,
        spawnImpl,
      })

      await ensureRequiredFunctionalModules({
        rootDir: modulesRoot,
        manifestUrl: 'https://download.example.com/manifest.json',
        platform: 'darwin',
        arch: 'arm64',
        clientVersion: '0.0.4',
        fetchImpl,
        spawnImpl,
        healthTimeoutMs: 10,
        stopTimeoutMs: 5,
      })

      expect(records).toHaveLength(2)
      expect(records[0]?.child.killed).toBe(true)
      expect(records[0]?.alipayBotCli).toContain('/alipay-bot/0.3.39-')
      expect(records[0]?.alipayBotNode).toContain('/node-runtime/24.19.3-')
      expect(records[1]?.alipayBotCli).toContain('/alipay-bot/0.3.40-')
      expect(records[1]?.alipayBotNode).toContain('/node-runtime/24.19.4-')
    } finally {
      await stopHttpApiServer(5)
      rmSync(rootDir, { recursive: true, force: true })
    }
  })
})
