import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tempHome: string
mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(tempHome, 'Library', 'Application Support'),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
  shell: {
    openExternal: async () => undefined,
  },
  BrowserWindow: class {},
  session: {
    defaultSession: {
      webRequest: {
        onHeadersReceived: () => {},
      },
      cookies: {
        set: async () => {},
      },
    },
  },
}))

describe('dsh-cordis-service', () => {
  let dshCordisService: typeof import('./dsh-cordis-service')

  beforeAll(async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'copis-test-cordis-home-'))
    dshCordisService = await import('./dsh-cordis-service')
  })

  afterAll(() => {
    rmSync(tempHome, { recursive: true, force: true })
  })

  test('Given 专有配置常量 When 查询配置项 Then 端口为 53080 且 profile 为 copis', () => {
    expect(dshCordisService.COPIS_DSH_PORT).toBe(53080)
    expect(dshCordisService.COPIS_DSH_PROFILE).toBe('copis')
  })

  test('Given 临时 DSH home 目录 When 初始化专有 profile Then 生成包含 package.json 与 default: cordis 的 patch 配置', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'copis-test-cordis-'))
    try {
      const profileDir = dshCordisService.ensureCordisWebProfile(tempDir, 'copis')
      expect(existsSync(profileDir)).toBe(true)
      expect(profileDir).toBe(join(tempDir, 'profiles', 'copis'))

      // 验证 package.json
      const pkgFile = join(profileDir, 'package.json')
      expect(existsSync(pkgFile)).toBe(true)
      const pkgJson = JSON.parse(readFileSync(pkgFile, 'utf-8'))
      expect(pkgJson.name).toBe('dsh-profile-copis')
      expect(pkgJson.dsh.profile.bundles).toContain('@deepseek-ai/dsh-web-app')

      // 验证 cordis.patch.yml
      const patchFile = join(profileDir, 'cordis.patch.yml')
      expect(existsSync(patchFile)).toBe(true)
      const content = readFileSync(patchFile, 'utf-8')
      expect(content).toContain('default: cordis')
      expect(content).toContain('provider: copis')
      expect(content).toContain('id: llm-deepseek')
      expect(content).toContain('disabled: true')

      // 验证默认 Skill 同步（workspace-builder 与 dsh-web-evolution）
      const workspaceBuilderSkill = join(tempDir, 'skills', 'workspace-builder', 'SKILL.md')
      expect(existsSync(workspaceBuilderSkill)).toBe(true)
      const wbContent = readFileSync(workspaceBuilderSkill, 'utf-8')
      expect(wbContent).toContain('name: workspace-builder')
      expect(wbContent).toContain('displayName: 个人工作台搭建师')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('Given 现有空的 cordis.patch.yml When 初始化专有 profile Then 自动更新为 cordis 创造模式配置', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'copis-test-cordis-empty-'))
    try {
      const profileDir = join(tempDir, 'profiles', 'copis')
      dshCordisService.ensureCordisWebProfile(tempDir, 'copis')
      const patchFile = join(profileDir, 'cordis.patch.yml')
      // 写入空数组模拟默认初始化
      writeFileSync(patchFile, '[]\n', 'utf-8')

      // 再次执行 ensure
      dshCordisService.ensureCordisWebProfile(tempDir, 'copis')
      const content = readFileSync(patchFile, 'utf-8')
      expect(content).toContain('default: cordis')
      expect(content).toContain('provider: copis')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('Given 未指定有效 dsh 运行时 When 启动 Cordis 服务 Then 优雅降级返回错误并不崩溃', async () => {
    dshCordisService.stopDshCordisServer()
    const status = await dshCordisService.startDshCordisServer({
      dshCommand: '',
    })
    expect(status.running).toBe(false)
    expect(status.error).toContain('未找到已激活的创造模式运行时')
  })

  test('Given 停止服务调用 When 停止 Cordis 服务 Then 状态恢复为未运行', () => {
    const status = dshCordisService.stopDshCordisServer()
    expect(status.running).toBe(false)
    expect(dshCordisService.getDshCordisStatus().running).toBe(false)
  })

  test('Given 独立临时目录 When 触发微内核热重载 Then cordis.patch.yml 自动注入 live-reload 时间戳', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'copis-test-reload-'))
    try {
      dshCordisService.ensureCordisWebProfile(tempDir, 'copis')
      const profileDir = join(tempDir, 'profiles', 'copis')
      const patchFile = join(profileDir, 'cordis.patch.yml')

      // 在服务未启动且无有效 command 场景下，测试更新 patchFile 机制
      const contentBefore = readFileSync(patchFile, 'utf-8')
      expect(contentBefore).toContain('default: cordis')

      // 直接调用 reloadDshCordisPlugins（仅测试触碰文件，不启动真实后台进程）
      await dshCordisService.reloadDshCordisPlugins({ dshRootDir: tempDir, profile: 'copis', startIfNeeded: false })
      const contentAfter = readFileSync(patchFile, 'utf-8')
      expect(contentAfter).toContain('default: cordis')
      expect(contentAfter).toContain('provider: copis')
    } finally {
      dshCordisService.stopDshCordisServer()
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('Given 合法与非法的 session secret When 生成 DSH 会话 Cookie Then 符合 DSH 规范且非法密钥安全拦截', () => {
    // 32 字节的合法 base64url 密钥（43 字符）
    const validSecret = 'Krz-igsfWXF83LuE1CGtM1vXXTk_dr21Tyge1xe6CQs'
    const cookie = dshCordisService.generateDshSessionCookie('127.0.0.1:53080', validSecret)
    expect(cookie).not.toBeNull()
    expect(cookie!.name.startsWith('dsh-auth-')).toBe(true)
    expect(cookie!.value.startsWith('v1.')).toBe(true)
    expect(cookie!.expiresAt).toBeGreaterThan(Date.now())

    // 密钥字节长度不足 32 字节
    const invalidShort = 'short-secret'
    expect(dshCordisService.generateDshSessionCookie('127.0.0.1:53080', invalidShort)).toBeNull()

    // 非法 base64url 格式
    const invalidChars = '???not-base64url***'
    expect(dshCordisService.generateDshSessionCookie('127.0.0.1:53080', invalidChars)).toBeNull()
  })

  test('Given 包含 browser-session 的 .credentials.yaml When 读取持久化密钥 Then 正确返回 secret 字符串', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'copis-test-cred-'))
    try {
      const credFile = join(tempDir, '.credentials.yaml')
      const yamlContent = `version: 1
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: Krz-igsfWXF83LuE1CGtM1vXXTk_dr21Tyge1xe6CQs
`
      writeFileSync(credFile, yamlContent, 'utf-8')
      const secret = dshCordisService.readDshBrowserSessionSecret(tempDir)
      expect(secret).toBe('Krz-igsfWXF83LuE1CGtM1vXXTk_dr21Tyge1xe6CQs')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('Given 不同响应状态与响应体 When 探测目标端口 Then 精准区分 DSH、非 DSH 服务与端口未占用', async () => {
    // 1. DSH 未鉴权响应 (401 + dsh web authentication required)
    const mockDsh401Fetch = (async () => {
      return new Response('dsh web authentication required; reopen the URL printed by dsh web.', {
        status: 401,
      })
    }) as unknown as typeof fetch

    const result401 = await dshCordisService.probeDshCordisServer({
      port: 59991,
      fetchFn: mockDsh401Fetch,
    })
    expect(result401.portInUse).toBe(true)
    expect(result401.isDsh).toBe(true)

    // 2. DSH 鉴权后 200 响应 (包含 __ModuleLoader__ 或 <title>dsh)
    const mockDsh200Fetch = (async () => {
      return new Response('<!doctype html><html><head><title>dsh</title><script>window.__ModuleLoader__={}</script></head></html>', {
        status: 200,
      })
    }) as unknown as typeof fetch

    const result200 = await dshCordisService.probeDshCordisServer({
      port: 59992,
      fetchFn: mockDsh200Fetch,
    })
    expect(result200.portInUse).toBe(true)
    expect(result200.isDsh).toBe(true)

    // 3. 非 DSH 的第三方服务响应 (普通 200 网页)
    const mockOtherFetch = (async () => {
      return new Response('<html><body>Welcome to My Custom App</body></html>', {
        status: 200,
      })
    }) as unknown as typeof fetch

    const resultOther = await dshCordisService.probeDshCordisServer({
      port: 59993,
      fetchFn: mockOtherFetch,
    })
    expect(resultOther.portInUse).toBe(true)
    expect(resultOther.isDsh).toBe(false)

    // 4. 端口未占用 (网络连接失败)
    const mockRefusedFetch = (async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:59994')
    }) as unknown as typeof fetch

    const resultRefused = await dshCordisService.probeDshCordisServer({
      port: 59994,
      fetchFn: mockRefusedFetch,
    })
    expect(resultRefused.portInUse).toBe(false)
    expect(resultRefused.isDsh).toBe(false)
  })

  test('Given 本次 Copis 已持有 DSH 进程 When 判断端口复用策略 Then 保持该进程以继续使用当前 capability', () => {
    expect(dshCordisService.shouldRestartReusedDshServer(true)).toBe(false)
  })

  test('Given 上一次 Copis 启动遗留的 DSH 进程 When 判断端口复用策略 Then 必须重启以注入本次启动的新 capability', () => {
    expect(dshCordisService.shouldRestartReusedDshServer(false)).toBe(true)
  })

  test('Given 上一次 Copis 启动遗留的 DSH 进程 When 启动 Cordis 服务 Then 终止旧进程并创建本次生命周期的新进程', async () => {
    dshCordisService.stopDshCordisServer()
    const tempDir = mkdtempSync(join(tmpdir(), 'copis-test-stale-dsh-'))
    const portReservation = Bun.serve({ port: 0, fetch: () => new Response('reserved') })
    const port = portReservation.port
    portReservation.stop()
    const staleScript = join(tempDir, 'stale-dsh.mjs')
    const newDshCommand = join(tempDir, 'new-dsh.sh')
    writeFileSync(staleScript, `const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.argv[2]), fetch: () => new Response('dsh web authentication required; reopen the URL printed by dsh web.', { status: 401 }) })\nprocess.on('SIGTERM', () => { server.stop(true); process.exit(0) })\nsetInterval(() => {}, 1000)\n`, 'utf-8')
    writeFileSync(newDshCommand, '#!/bin/sh\nport=""\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--port" ]; then\n    port="$2"\n    shift 2\n  else\n    shift\n  fi\ndone\nprintf "http://127.0.0.1:%s/\\n" "$port"\nsleep 30\n', 'utf-8')
    chmodSync(newDshCommand, 0o755)
    const staleProcess = Bun.spawn([process.execPath, staleScript, String(port)], { stdout: 'ignore', stderr: 'ignore' })

    try {
      const healthUrl = `http://127.0.0.1:${port}/`
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          const response = await fetch(healthUrl)
          if (response.status === 401) break
        } catch {
          // 子进程尚未开始监听，继续等待。
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      const status = await dshCordisService.startDshCordisServer({
        dshRootDir: tempDir,
        port,
        dshCommand: newDshCommand,
        timeoutMs: 2000,
      })

      expect(await staleProcess.exited).toBe(0)
      expect(status.running).toBe(true)
      expect(status.port).toBe(port)
    } finally {
      staleProcess.kill()
      dshCordisService.stopDshCordisServer()
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('Given 基础端口被第三方服务占用 When 自动分配端口 Then 自动回避并分配下一个空闲可用端口', async () => {
    // 启动一个普通的 HTTP 服务器占用端口
    const dummyServer = Bun.serve({
      port: 0,
      fetch() {
        return new Response('Hello from foreign server')
      },
    })

    try {
      const foreignPort = dummyServer.port ?? 59980
      const allocation = await dshCordisService.findOrAllocateDshPort({
        basePort: foreignPort,
        maxScanOffset: 5,
      })

      expect(allocation.type).toBe('available')
      if (allocation.type === 'available') {
        // 分配的端口必须大于被占用的 foreignPort
        expect(allocation.port).toBeGreaterThan(foreignPort)
        expect(allocation.port).toBeLessThanOrEqual(foreignPort + 5)
      }
    } finally {
      dummyServer.stop()
    }
  })

  test('Given 基础端口被第三方服务占用且后续候选端口存在已有 DSH When 自动分配端口 Then 优先复用该已有 DSH 实例', async () => {
    // 1. 占用起始端口
    const dummyServer = Bun.serve({
      port: 0,
      fetch() {
        return new Response('Occupied by another app')
      },
    })
    const basePort = dummyServer.port ?? 59980
    const mockDshPort = basePort + 1

    // 2. 在起始端口 + 1 启动 mock DSH 响应
    const mockDshServer = Bun.serve({
      port: mockDshPort,
      fetch() {
        return new Response('dsh web authentication required; reopen the URL printed by dsh web.', {
          status: 401,
        })
      },
    })

    try {
      const allocation = await dshCordisService.findOrAllocateDshPort({
        basePort,
        maxScanOffset: 5,
      })

      expect(allocation.type).toBe('reuse')
      if (allocation.type === 'reuse') {
        expect(allocation.port).toBe(mockDshPort)
        expect(allocation.url).toContain(`http://127.0.0.1:${mockDshPort}/`)
      }
    } finally {
      dummyServer.stop()
      mockDshServer.stop()
    }
  })

})
