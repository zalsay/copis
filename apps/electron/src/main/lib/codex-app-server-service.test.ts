import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs'
import {
  DEFAULT_CODEX_PORT,
  detectCodexCli,
  isPortAvailable,
  resolveCodexCommand,
  startCodexAppServer,
  stopCodexAppServer,
  getCodexAppServerStatus,
  setCodexStatusChangeBroadcaster,
  getCopisCodexHomeDir,
  ensureCopisCodexConfig,
} from './codex-app-server-service'
import type { CodexAppServerStatus } from '../../types'

describe('Codex App Server Service (BDD)', () => {
  const originalEnv = process.env.COPIS_CODEX_EXECUTABLE
  let dummyExecPath: string | null = null

  beforeEach(() => {
    delete process.env.COPIS_CODEX_EXECUTABLE
    setCodexStatusChangeBroadcaster(null)
  })

  afterEach(async () => {
    await stopCodexAppServer()
    if (originalEnv) {
      process.env.COPIS_CODEX_EXECUTABLE = originalEnv
    } else {
      delete process.env.COPIS_CODEX_EXECUTABLE
    }
    if (dummyExecPath && existsSync(dummyExecPath)) {
      try {
        unlinkSync(dummyExecPath)
      } catch {
        // ignore
      }
      dummyExecPath = null
    }
  })

  test('Given 端口可用性检查 When 端口被占用与端口空闲 Then 正确判断可用性', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const occupiedPort = typeof address === 'object' && address ? address.port : 54081

    const occupiedResult = await isPortAvailable(occupiedPort)
    expect(occupiedResult).toBe(false)

    await new Promise<void>((resolve) => server.close(() => resolve()))

    const freeResult = await isPortAvailable(occupiedPort)
    expect(freeResult).toBe(true)
  })

  test('Given 环境变量 COPIS_CODEX_EXECUTABLE When 存在文件 Then resolveCodexCommand 优先返回该路径', () => {
    dummyExecPath = join(tmpdir(), `dummy-codex-${Date.now()}`)
    writeFileSync(dummyExecPath, '#!/bin/sh\necho codex\n', { mode: 0o755 })
    process.env.COPIS_CODEX_EXECUTABLE = dummyExecPath

    const resolved = resolveCodexCommand()
    expect(resolved).toBe(dummyExecPath)
  })

  test('Given 未找到可执行程序 When 启动服务 Then 抛出中文提示并广播错误状态', async () => {
    const statusBroadcasts: CodexAppServerStatus[] = []
    setCodexStatusChangeBroadcaster((status) => statusBroadcasts.push(status))

    // 传入不存在的命令路径
    await expect(
      startCodexAppServer({ executablePath: '/path/to/nonexistent/codex/cli' }),
    ).rejects.toThrow('未检测到专业模式核心组件')

    const currentStatus = getCodexAppServerStatus()
    expect(currentStatus.running).toBe(false)
    expect(currentStatus.error).toContain('未检测到专业模式核心组件')
    expect(statusBroadcasts.length).toBeGreaterThan(0)
    expect(statusBroadcasts[statusBroadcasts.length - 1]?.error).toContain('未检测到专业模式核心组件')
  })

  test('Given 模拟可执行程序 When 启动并停止服务 Then 状态机正确流转并广播', async () => {
    // 制作一个响应 SIGTERM 快速退出的模拟脚本
    dummyExecPath = join(tmpdir(), `mock-codex-${Date.now()}.sh`)
    writeFileSync(
      dummyExecPath,
      '#!/bin/sh\ntrap "exit 0" TERM INT\nwhile true; do sleep 0.1; done\n',
      { mode: 0o755 },
    )

    const statusBroadcasts: CodexAppServerStatus[] = []
    setCodexStatusChangeBroadcaster((status) => statusBroadcasts.push(status))

    // 启动服务
    const status = await startCodexAppServer({
      executablePath: dummyExecPath,
      port: 54199,
    })

    expect(status.running).toBe(true)
    expect(status.port).toBe(54199)
    expect(typeof status.pid).toBe('number')
    expect(getCodexAppServerStatus().running).toBe(true)

    // 重复启动应幂等返回当前状态
    const repeatStatus = await startCodexAppServer({ executablePath: dummyExecPath })
    expect(repeatStatus.running).toBe(true)
    expect(repeatStatus.pid).toBe(status.pid)

    // 停止服务
    await stopCodexAppServer()
    const stoppedStatus = getCodexAppServerStatus()
    expect(stoppedStatus.running).toBe(false)
    expect(stoppedStatus.pid).toBeUndefined()

    // 验证广播被触发
    const runningBroadcast = statusBroadcasts.find((s) => s.running)
    const stoppedBroadcast = statusBroadcasts.find((s) => !s.running && !s.error)
    expect(runningBroadcast).toBeDefined()
    expect(stoppedBroadcast).toBeDefined()
  })

  test('Given 未安装核心组件 When 执行环境检测 Then detectCodexCli 返回未就绪及下载提示', async () => {
    // 强制使用不存在的根目录，且跳过系统全局回退
    const status = await detectCodexCli('/nonexistent/modules/path', { skipSystemFallback: true })
    expect(status.available).toBe(false)
    expect(status.canStartAppServer).toBe(false)
    expect(status.error).toContain('未检测到专业模式核心组件')
  })

  test('Given 支持 app-server 的可执行程序 When 执行环境检测 Then detectCodexCli 返回就绪与版本信息', async () => {
    dummyExecPath = join(tmpdir(), `mock-codex-cli-${Date.now()}.sh`)
    writeFileSync(
      dummyExecPath,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "codex 0.8.5"\nelse\n  echo "Usage: codex app-server --listen 127.0.0.1:54080"\nfi\n',
      { mode: 0o755 },
    )
    process.env.COPIS_CODEX_EXECUTABLE = dummyExecPath

    const status = await detectCodexCli()
    expect(status.available).toBe(true)
    expect(status.canStartAppServer).toBe(true)
    expect(status.version).toBe('0.8.5')
    expect(status.path).toBe(dummyExecPath)
    expect(status.error).toBeNull()
  })

  test('Given Copis 运行环境 When 调用 getCopisCodexHomeDir 与 ensureCopisCodexConfig Then 自动创建隔离配置与技能屏蔽规则', () => {
    const codexHome = getCopisCodexHomeDir()
    expect(codexHome).toContain('.copis')
    expect(codexHome.endsWith('/codex')).toBe(true)

    const ensured = ensureCopisCodexConfig({ httpApiPort: 51740 })
    expect(ensured).toBe(codexHome)
    expect(existsSync(join(codexHome, 'config.toml'))).toBe(true)
    const content = readFileSync(join(codexHome, 'config.toml'), 'utf-8')
    expect(content).toContain('wire_api = "responses"')
    expect(content).toContain('http://127.0.0.1:51740/api/internal/working-model/v1')
    expect(content).toContain('X-Working-Model-Source-Type')

    // 验证默认系统技能在 config.toml 中被声明禁用
    expect(content).toContain('name = "imagegen"')
    expect(content).toContain('name = "openai-docs"')
    expect(content).toContain('name = "plugin-creator"')
    expect(content).toContain('name = "review-agent"')
    expect(content).toContain('name = "skill-installer"')
    expect(content).toContain('enabled = false')

    // 验证 .system 目录与 marker 存在
    const markerPath = join(codexHome, 'skills', '.system', '.codex-system-skills.marker')
    expect(existsSync(markerPath)).toBe(true)
  })

  test('Given .system 下存在残留内置技能目录 When 调用 ensureCopisCodexConfig Then 自动彻底清除子目录并保留 marker', () => {
    const codexHome = getCopisCodexHomeDir()
    const systemDir = join(codexHome, 'skills', '.system')
    const legacySkillDir = join(systemDir, 'imagegen')
    writeFileSync(join(codexHome, 'skills', '.system', '.codex-system-skills.marker'), 'copis\n')

    // 创建模拟的旧技能子目录
    const dummyFile = join(legacySkillDir, 'SKILL.md')
    const { mkdirSync } = require('node:fs')
    mkdirSync(legacySkillDir, { recursive: true })
    writeFileSync(dummyFile, 'dummy skill')
    expect(existsSync(legacySkillDir)).toBe(true)

    ensureCopisCodexConfig({ httpApiPort: 51740 })

    // 旧子目录已被清理
    expect(existsSync(legacySkillDir)).toBe(false)
    // marker 依然保留
    expect(existsSync(join(systemDir, '.codex-system-skills.marker'))).toBe(true)
  })
})
