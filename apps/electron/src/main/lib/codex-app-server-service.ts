/**
 * Codex App Server 守护进程管控服务
 *
 * 负责管理 OpenAI Codex Harness 的 app-server 进程生命周期：
 * - 解析 codex 可执行文件路径（优先功能模块，回退系统 PATH）；
 * - 动态探测分配本地安全端口；
 * - 子进程启停、异常捕获与状态机维护；
 * - 状态变更实时广播至渲染进程。
 */

import { type ChildProcess, execSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CodexAppServerStatus, CodexCliStatus } from '../../types'
import { getConfigDir, getFunctionalModulesDir } from './config-paths'
import { getFunctionalModulePaths, readActiveFunctionalModule } from './functional-module-store'
import { resolveCopisHttpApiPort } from '@copis/shared/config'

export const DEFAULT_CODEX_PORT = 54080
export const MAX_CODEX_PORT_SCAN = 20

/**
 * Codex 默认内置 skills 屏蔽黑名单。
 *
 * Codex 启动时默认会解压并启用这 5 个通用系统技能：
 * - imagegen
 * - openai-docs
 * - plugin-creator
 * - review-agent
 * - skill-installer
 * （注：skill-creator 作为 Copis 工作区原生维护的标准技能予以保留并加载工作区版本）
 */
export const CODEX_BLOCKED_DEFAULT_SKILLS = [
  'imagegen',
  'openai-docs',
  'plugin-creator',
  'review-agent',
  'skill-installer',
] as const

/**
 * 获取 Copis 专属的 Codex 运行主目录 ($CODEX_HOME)
 * 确保专业模式完全隔离用户系统本地的 ~/.codex
 */
export function getCopisCodexHomeDir(): string {
  return join(getConfigDir(), 'codex')
}

/**
 * 确保 Copis 专属的 Codex 配置目录与 config.toml 就绪。
 *
 * 1. 独立于用户系统 ~/.codex；
 * 2. 默认通过 Copis 本地 Rust HTTP API 网关访问模型（/api/internal/working-model/v1）；
 * 3. 屏蔽 Codex 默认内置 skills（预置 .codex-system-skills.marker 阻止解压、清理 .system 子目录、并在 config.toml 中明确声明禁用）；
 * 4. 确保专业模式统一加载并使用 Copis 工作区 Skills 体系。
 */
export function ensureCopisCodexConfig(options?: { httpApiPort?: number }): string {
  const codexHome = getCopisCodexHomeDir()
  if (!existsSync(codexHome)) {
    mkdirSync(codexHome, { recursive: true })
  }

  // 1. 确保 skills/.system 目录及其 marker 存在，阻断 Codex 内置技能解压
  const systemSkillsDir = join(codexHome, 'skills', '.system')
  if (!existsSync(systemSkillsDir)) {
    mkdirSync(systemSkillsDir, { recursive: true })
  }

  const markerPath = join(systemSkillsDir, '.codex-system-skills.marker')
  if (!existsSync(markerPath)) {
    try {
      writeFileSync(markerPath, 'copis\n', 'utf-8')
    } catch (err) {
      console.warn('[Codex App Server] 创建 .codex-system-skills.marker 失败:', err)
    }
  }

  // 2. 清理 .system 目录下可能残留的任何系统内置技能子目录
  try {
    const entries = readdirSync(systemSkillsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        rmSync(join(systemSkillsDir, entry.name), { recursive: true, force: true })
      }
    }
  } catch (err) {
    console.warn('[Codex App Server] 清理系统默认 Skills 目录失败:', err)
  }

  const configPath = join(codexHome, 'config.toml')
  const httpApiPort = options?.httpApiPort ?? resolveCopisHttpApiPort({
    configuredPort: process.env.COPIS_HTTP_API_PORT,
    isPackaged: process.env.COPIS_PACKAGED === '1',
  })

  // 构造 config.toml 中显式禁用 Codex 默认内置技能的配置
  const blockedSkillsToml = CODEX_BLOCKED_DEFAULT_SKILLS
    .map((name) => `[[skills.config]]\nname = "${name}"\nenabled = false`)
    .join('\n\n')

  const tomlContent = `# Copis 专业模式专属 Codex 配置文件
# 独立于用户系统 ~/.codex，默认通过 Copis 本地 Rust HTTP API 网关访问模型
model = "fast"
model_provider = "copis"

[model_providers.copis]
name = "copis"
wire_api = "responses"
base_url = "http://127.0.0.1:${httpApiPort}/api/internal/working-model/v1"
http_headers = { "X-Working-Model-Source-Type" = "copis-agent-model" }

# 屏蔽 Codex 默认内置 skills，使用 Copis 工作区 Skills 体系
${blockedSkillsToml}
`
  try {
    writeFileSync(configPath, tomlContent, 'utf-8')
  } catch (err) {
    console.warn('[Codex App Server] 写入 config.toml 失败:', err)
  }

  return codexHome
}

let statusBroadcaster: ((status: CodexAppServerStatus) => void) | null = null

export function setCodexStatusChangeBroadcaster(broadcaster: ((status: CodexAppServerStatus) => void) | null): void {
  statusBroadcaster = broadcaster
}

function broadcastStatus(status: CodexAppServerStatus): void {
  try {
    statusBroadcaster?.(status)
  } catch (err) {
    console.warn('[Codex App Server] 广播状态失败:', err)
  }
}

interface ServerState {
  process: ChildProcess | null
  status: CodexAppServerStatus
}

const serverState: ServerState = {
  process: null,
  status: {
    running: false,
  },
}

/**
 * 检查端口是否空闲可用
 */
export function isPortAvailable(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = createNetServer()
      .once('error', () => {
        resolve(false)
      })
      .once('listening', () => {
        tester.close(() => resolve(true))
      })
      .listen(port, host)
  })
}

/**
 * 解析系统或功能模块中的 codex 命令路径
 */
export function resolveCodexCommand(
  rootDir = getFunctionalModulesDir(),
  options: { skipSystemFallback?: boolean } = {},
): string | undefined {
  if (process.env.COPIS_CODEX_EXECUTABLE && existsSync(process.env.COPIS_CODEX_EXECUTABLE)) {
    return process.env.COPIS_CODEX_EXECUTABLE
  }

  const binaryName = process.platform === 'win32' ? 'codex.cmd' : 'codex'
  const entrypoints = process.platform === 'win32' ? ['bin/codex.cmd', 'bin/codex.exe'] : ['bin/codex']

  // 1. 优先从 Copis 功能模块目录查找
  const active = readActiveFunctionalModule(getFunctionalModulePaths(rootDir), 'codex-cli')
  if (active && entrypoints.includes(active.entrypoint) && existsSync(active.path)) {
    return active.path
  }

  if (options.skipSystemFallback) {
    return undefined
  }

  // 2. 生产模块目录 ~/.copis/modules 回退
  const prodModulesDir = join(homedir(), '.copis', 'modules')
  if (rootDir !== prodModulesDir && existsSync(prodModulesDir)) {
    const prodActive = readActiveFunctionalModule(getFunctionalModulePaths(prodModulesDir), 'codex-cli')
    if (prodActive && entrypoints.includes(prodActive.entrypoint) && existsSync(prodActive.path)) {
      return prodActive.path
    }
  }

  // 3. 用户系统常用目录探测
  const home = homedir()
  const systemCandidates = process.platform === 'win32'
    ? [join(home, '.local', 'bin', 'codex.cmd'), join(home, '.local', 'bin', 'codex.exe')]
    : [join(home, '.local', 'bin', 'codex'), '/usr/local/bin/codex', '/opt/homebrew/bin/codex']

  for (const candidate of systemCandidates) {
    if (existsSync(candidate)) return candidate
  }

  // 4. 从系统 PATH 动态查找
  try {
    const whichCmd = process.platform === 'win32' ? 'where codex' : 'which codex'
    const out = execSync(whichCmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 3000,
    })
    const foundPath = out.trim().split('\n')[0]?.trim()
    if (foundPath && existsSync(foundPath)) {
      return foundPath
    }
  } catch {
    // 未在 PATH 中找到
  }

  return undefined
}

/**
 * 检测本机 codex-cli 的安装状态与 app-server 执行能力
 */
export async function detectCodexCli(
  rootDir = getFunctionalModulesDir(),
  options: { skipSystemFallback?: boolean } = {},
): Promise<CodexCliStatus> {
  const codexCmd = resolveCodexCommand(rootDir, options)
  if (!codexCmd || !existsSync(codexCmd)) {
    return {
      available: false,
      path: null,
      version: null,
      canStartAppServer: false,
      error: '未检测到专业模式核心组件，请先下载并安装',
    }
  }

  // 提取版本信息
  let version: string | null = null
  try {
    const verResult = spawnSync(codexCmd, ['--version'], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    if (verResult.status === 0 && verResult.stdout) {
      const match = verResult.stdout.match(/(\d+\.\d+\.\d+[\w.-]*)/)
      version = match ? match[1]! : verResult.stdout.trim().split('\n')[0]!
    }
  } catch {
    // 忽略版本探测异常
  }

  // 验证是否支持并能启动 app-server
  try {
    const checkResult = spawnSync(codexCmd, ['app-server', '--help'], {
      encoding: 'utf-8',
      timeout: 4000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const combinedOutput = `${checkResult.stdout || ''}\n${checkResult.stderr || ''}`
    if (checkResult.status === 0 || combinedOutput.includes('app-server') || combinedOutput.includes('listen')) {
      return {
        available: true,
        path: codexCmd,
        version,
        canStartAppServer: true,
        error: null,
      }
    }

    return {
      available: true,
      path: codexCmd,
      version,
      canStartAppServer: false,
      error: `当前专业模式核心组件 (${version || '未知版本'}) 无法启动后台服务`,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      available: true,
      path: codexCmd,
      version,
      canStartAppServer: false,
      error: `执行后台服务探测失败: ${message}`,
    }
  }
}

/**
 * 获取当前 Codex App Server 运行状态
 */
export function getCodexAppServerStatus(): CodexAppServerStatus {
  return { ...serverState.status }
}

/**
 * 启动 Codex App Server
 */
export async function startCodexAppServer(options: {
  port?: number
  executablePath?: string
  env?: Record<string, string>
  httpApiPort?: number
} = {}): Promise<CodexAppServerStatus> {
  if (serverState.status.running && serverState.process) {
    return { ...serverState.status }
  }

  const codexCmd = options.executablePath ?? resolveCodexCommand()
  if (!codexCmd || !existsSync(codexCmd)) {
    const errorMsg = '未检测到专业模式核心组件，请先在功能模块中下载并安装'
    serverState.status = {
      running: false,
      error: errorMsg,
    }
    broadcastStatus(serverState.status)
    throw new Error(errorMsg)
  }

  // 查找可用端口
  let selectedPort = options.port ?? DEFAULT_CODEX_PORT
  let isAvailable = await isPortAvailable(selectedPort)
  if (!isAvailable) {
    let found = false
    for (let offset = 1; offset <= MAX_CODEX_PORT_SCAN; offset++) {
      const candidate = selectedPort + offset
      if (await isPortAvailable(candidate)) {
        selectedPort = candidate
        found = true
        break
      }
    }
    if (!found) {
      const errorMsg = `专业模式后台服务端口冲突且在 +${MAX_CODEX_PORT_SCAN} 范围内未找到可用端口`
      serverState.status = { running: false, error: errorMsg }
      broadcastStatus(serverState.status)
      throw new Error(errorMsg)
    }
  }

  // 确保 Copis 专属 CODEX_HOME 及其 config.toml 就绪
  const codexHome = ensureCopisCodexConfig({ httpApiPort: options.httpApiPort })

  console.info(`[Codex App Server] 正在启动服务 (端口: ${selectedPort}, 命令: ${codexCmd}, CODEX_HOME: ${codexHome})...`)

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: codexHome,
    ...options.env,
    PORT: String(selectedPort),
  }

  const child = spawn(
    codexCmd,
    ['app-server', '--listen', `ws://127.0.0.1:${selectedPort}`],
    {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    },
  )

  serverState.process = child
  serverState.status = {
    running: true,
    pid: child.pid,
    port: selectedPort,
    startedAt: Date.now(),
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trim()
    if (line) console.log(`[Codex App Server stdout] ${line}`)
  })

  child.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trim()
    if (line) console.warn(`[Codex App Server stderr] ${line}`)
  })

  child.on('error', (err) => {
    console.error('[Codex App Server] 进程错误:', err)
    serverState.process = null
    serverState.status = {
      running: false,
      error: err.message,
    }
    broadcastStatus(serverState.status)
  })

  child.on('exit', (code, signal) => {
    console.info(`[Codex App Server] 进程已退出 (code=${code}, signal=${signal})`)
    serverState.process = null
    serverState.status = {
      running: false,
    }
    broadcastStatus(serverState.status)
  })

  broadcastStatus(serverState.status)
  return { ...serverState.status }
}

/**
 * 停止 Codex App Server
 */
export async function stopCodexAppServer(): Promise<void> {
  const proc = serverState.process
  if (!proc) {
    serverState.status = { running: false }
    broadcastStatus(serverState.status)
    return
  }

  console.info('[Codex App Server] 正在停止服务...')
  return new Promise<void>((resolve) => {
    let resolved = false
    const finish = () => {
      if (!resolved) {
        resolved = true
        serverState.process = null
        serverState.status = { running: false }
        broadcastStatus(serverState.status)
        resolve()
      }
    }

    const forceKillTimer = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch { /* 忽略已退出错误 */ }
      finish()
    }, 3000)

    proc.once('exit', () => {
      clearTimeout(forceKillTimer)
      finish()
    })

    try {
      proc.kill('SIGTERM')
    } catch {
      clearTimeout(forceKillTimer)
      finish()
    }
  })
}
