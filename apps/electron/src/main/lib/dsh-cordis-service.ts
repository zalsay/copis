/**
 * DSH 「创造模式」Cordis Web 服务管控层。
 *
 * 负责与本地 DSH CLI 协同管理 web profile，并注入 Cordis 创造模式预设：
 * - 自动确保 web profile 的 cordis.patch.yml 配置为 cordis 创造模式；
 * - 进程生命周期管控（按需启动、状态监听、优雅停止）；
 * - 解析带 Token 授权凭证的本地 Web 访问地址；
 * - 依托 DSH Web 自身的 patchReload live 机制，支持通过 DSH 自更新 Web 功能与实时热重载。
 */

import { type ChildProcess, execSync, spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { join } from 'node:path'
import { parse } from 'yaml'
import type { DshCordisStatus } from '@copis/shared'
import { getDefaultSkillsDir, getDshHomeDir } from './config-paths'
import { resolveDshCommand, resolveDshNode } from './dsh-runtime'
import { patchDshComposerHistoryRuntime } from './dsh-composer-history-patch'
import { patchDshHeroLogoRuntime } from './dsh-hero-logo-patch'
import { patchDshSidebarRuntime } from './dsh-sidebar-patch'
import {
  applyDshModelConfig,
  resolveDshUnifiedModelConfig,
  syncCopisModelConfigToDsh,
} from './dsh-model-config'

export {
  applyDshModelConfig,
  resolveDshUnifiedModelConfig,
  syncCopisModelConfigToDsh,
}
export type { DshUnifiedModelConfig, ResolveDshModelOptions } from './dsh-model-config'

/** Copis 专有的 DSH 创造模式 Profile 名称 */
export const COPIS_DSH_PROFILE = 'copis'

/** Copis 专有的 DSH Web 启动端口 */
export const COPIS_DSH_PORT = 53080

/** 端口冲突时最大自动回避探测范围（偏移量） */
export const COPIS_DSH_MAX_PORT_SCAN = 20

const DSH_AUTH_COOKIE_PREFIX = 'dsh-auth-'
const COOKIE_PAYLOAD_VERSION = 1
const DEFAULT_COOKIE_MAX_AGE_DAYS = 30
const DSH_STALE_PROCESS_STOP_TIMEOUT_MS = 5000

let statusChangeBroadcaster: ((status: DshCordisStatus) => void) | null = null

export function setDshStatusChangeBroadcaster(broadcaster: ((status: DshCordisStatus) => void) | null): void {
  statusChangeBroadcaster = broadcaster
}

export function notifyDshCordisStatusChange(status: DshCordisStatus): void {
  try {
    statusChangeBroadcaster?.(status)
  } catch {
    // 广播失败不影响主流程
  }
}

interface DshCordisServerState {
  process: ChildProcess | null
  reusedPid?: number
  status: DshCordisStatus
}

const state: DshCordisServerState = {
  process: null,
  status: {
    running: false,
  },
}

export function getDshCordisStatus(): DshCordisStatus {
  return { ...state.status }
}

/**
 * DSH 从进程环境读取 Working capability，不能通过 patch reload 更新。
 * 只有本次 Copis 启动自行创建的进程才可以复用；其余实例均视为上次启动遗留。
 */
export function shouldRestartReusedDshServer(hasCurrentProcess: boolean): boolean {
  return !hasCurrentProcess
}

async function stopStaleDshServer(port: number): Promise<void> {
  const stalePid = findPidByPort(port)
  if (!stalePid || stalePid === process.pid) {
    throw new Error(`无法安全停止端口 ${port} 上的遗留 DSH 进程`)
  }

  try {
    process.kill(stalePid, 'SIGTERM')
  } catch (error) {
    throw new Error(`停止端口 ${port} 上的遗留 DSH 进程失败: ${error instanceof Error ? error.message : String(error)}`)
  }

  const deadline = Date.now() + DSH_STALE_PROCESS_STOP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await isPortAvailable(port)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(`等待端口 ${port} 上的遗留 DSH 进程退出超时`)
}

/**
 * 解析默认 Skills 来源目录
 */
export function resolveDefaultSkillsSourceDir(): string | null {
  const candidates = [
    join(__dirname, '../../../default-skills'),
    join(__dirname, '../default-skills'),
    getDefaultSkillsDir(),
  ]
  if (typeof process !== 'undefined' && (process as any).resourcesPath) {
    candidates.unshift(join((process as any).resourcesPath, 'default-skills'))
  }
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/**
 * 同步默认 Skills 到 DSH 用户技能目录 ($DSH_HOME/skills)
 */
export function syncDshDefaultSkills(dshRootDir = getDshHomeDir()): void {
  const sourceDir = resolveDefaultSkillsSourceDir()
  if (!sourceDir) return

  const targetDir = join(dshRootDir, 'skills')
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }

  try {
    const entries = readdirSync(sourceDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillName = entry.name
      const srcSkillDir = join(sourceDir, skillName)
      const dstSkillDir = join(targetDir, skillName)

      if (!existsSync(dstSkillDir)) {
        cpSync(srcSkillDir, dstSkillDir, { recursive: true })
      } else {
        const srcSkillMd = join(srcSkillDir, 'SKILL.md')
        const dstSkillMd = join(dstSkillDir, 'SKILL.md')
        if (existsSync(srcSkillMd) && existsSync(dstSkillMd)) {
          const srcStat = statSync(srcSkillMd)
          const dstStat = statSync(dstSkillMd)
          if (srcStat.mtimeMs > dstStat.mtimeMs) {
            cpSync(srcSkillDir, dstSkillDir, { recursive: true, force: true })
          }
        }
      }
    }
  } catch (err) {
    console.warn('[DSH Cordis Web] 同步默认技能到 DSH 目录失败:', err)
  }
}

/**
 * 确保 Copis 专有的 DSH 运行时主目录与 profile 存在并配置为 cordis 创造模式
 *
 * @param dshRootDir DSH 运行时主目录 ($DSH_HOME)，默认为 ~/.copis/dsh/
 * @param profileName 专有 Profile 名称，默认为 'copis'
 */
export function ensureCordisWebProfile(
  dshRootDir = getDshHomeDir(),
  profileName = COPIS_DSH_PROFILE,
): string {
  const profileDir = join(dshRootDir, 'profiles', profileName)
  if (!existsSync(profileDir)) {
    mkdirSync(profileDir, { recursive: true })
  }

  // 1. 确保专有 profile 的 package.json 存在，声明引入微内核 base 与 web-app bundles
  const pkgFile = join(profileDir, 'package.json')
  if (!existsSync(pkgFile)) {
    const defaultPkg = {
      name: `dsh-profile-${profileName}`,
      private: true,
      dependencies: {},
      dsh: {
        profile: {
          bundles: [
            '@deepseek-ai/dsh-base',
            '@deepseek-ai/dsh-web-app',
          ],
          patchReload: 'live',
        },
      },
    }
    writeFileSync(pkgFile, JSON.stringify(defaultPkg, null, 2), 'utf-8')
  }

  // 2. 确保 cordis.patch.yml 配置了 default: cordis 创造模式预设与 agent-default-model 预设
  const patchFile = join(profileDir, 'cordis.patch.yml')
  const defaultCordisPatch = `- id: agent-presets\n  config:\n    default: cordis\n- id: agent-default-model\n  config:\n    provider: copis\n    model: deepseek-v4-flash\n- id: llm-deepseek\n  disabled: true\n`

  if (!existsSync(patchFile)) {
    writeFileSync(patchFile, defaultCordisPatch, 'utf-8')
  } else {
    try {
      const content = readFileSync(patchFile, 'utf-8').trim()
      // 如果 patch 为空数组或未指定 default: cordis，则注入 cordis 创造模式配置。
      if (content === '[]' || (!content.includes('default: cordis') && !content.includes("default: 'cordis'"))) {
        writeFileSync(patchFile, defaultCordisPatch, 'utf-8')
      } else if (!content.includes('id: llm-deepseek')) {
        writeFileSync(patchFile, `${content}\n- id: llm-deepseek\n  disabled: true\n`, 'utf-8')
      }
    } catch {
      // 读取失败时保留原文件
    }
  }

  // 3. 确保 DSH 用户技能目录同步了 Copis 默认技能（包括 workspace-builder、dsh-web-evolution 等）
  syncDshDefaultSkills(dshRootDir)

  return profileDir
}

let sessionHeadersRegistered = false

/**
 * 为本地 DSH Web 注册 Electron Session 响应头转换器，
 * 移除 SameSite=Strict 限制以支持 iframe 正常携带 Cookie 并支持跨源嵌入。
 */
export function registerDshCordisWebSessionHeaders(): void {
  if (sessionHeadersRegistered) return
  try {
    // 动态引入 electron 避免在 node 运行或测试环境中报错
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron')
    const session = electron?.session?.defaultSession
    if (session?.webRequest) {
      sessionHeadersRegistered = true
      session.webRequest.onHeadersReceived(
        { urls: ['http://127.0.0.1:*/*', 'http://localhost:*/*'] },
        (details: any, callback: any) => {
          const responseHeaders = { ...details.responseHeaders }
          if (responseHeaders['set-cookie']) {
            responseHeaders['set-cookie'] = (responseHeaders['set-cookie'] as string[]).map((c: string) =>
              c.replace(/;\s*SameSite=Strict/gi, '')
            )
          }
          delete responseHeaders['x-frame-options']
          delete responseHeaders['X-Frame-Options']
          callback({ responseHeaders })
        }
      )
    }
  } catch {
    // 非 Electron 环境静默跳过
  }
}

function encodeBase64Url(value: Buffer | string): string {
  const buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Buffer | undefined {
  const base64UrlPattern = /^[A-Za-z0-9_-]*$/
  if (!base64UrlPattern.test(value) || value.length % 4 === 1) return undefined
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/') + padding
  return Buffer.from(base64, 'base64')
}

/**
 * 依据 DSH client-connection 规范，为指定 authority 生成带 HMAC-SHA256 签名的会话 Cookie。
 */
export function generateDshSessionCookie(
  authority: string,
  secretBase64Url: string,
  maxAgeDays = DEFAULT_COOKIE_MAX_AGE_DAYS,
): { name: string; value: string; expiresAt: number } | null {
  const secretBuffer = decodeBase64Url(secretBase64Url)
  if (!secretBuffer || secretBuffer.byteLength !== 32) {
    return null
  }
  const name = DSH_AUTH_COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest())
  const issuedAt = Date.now()
  const expiresAt = issuedAt + maxAgeDays * 24 * 60 * 60 * 1000
  const payload = {
    version: COOKIE_PAYLOAD_VERSION,
    authority,
    issuedAt,
    expiresAt,
  }
  const body = encodeBase64Url(JSON.stringify(payload))
  const sig = encodeBase64Url(createHmac('sha256', secretBuffer).update(body).digest())
  const value = `v1.${body}.${sig}`
  return { name, value, expiresAt }
}

/**
 * 从 DSH 运行时主目录读取持久化的 browser-session 签名密钥。
 */
export function readDshBrowserSessionSecret(dshRootDir = getDshHomeDir()): string | undefined {
  const candidates = [dshRootDir]
  if (process.env.DSH_HOME && !candidates.includes(process.env.DSH_HOME)) {
    candidates.push(process.env.DSH_HOME)
  }
  if (dshRootDir.includes('.copis-dev')) {
    candidates.push(dshRootDir.replace('.copis-dev', '.copis'))
  } else if (dshRootDir.includes('.copis')) {
    candidates.push(dshRootDir.replace('.copis', '.copis-dev'))
  }

  for (const root of candidates) {
    const credPath = join(root, '.credentials.yaml')
    if (existsSync(credPath)) {
      try {
        const content = readFileSync(credPath, 'utf-8')
        const doc = parse(content)
        const secret = doc?.records?.['client-connection/browser-session']?.payload?.secret
        if (typeof secret === 'string' && secret.trim()) {
          return secret.trim()
        }
      } catch {
        // 解析失败尝试下一个候选路径
      }
    }
  }
  return undefined
}

/**
 * 将 DSH 认证 Cookie 写入 Electron 的全局 session。
 */
export async function injectDshSessionCookies(port: number, secret: string): Promise<boolean> {
  try {
    const electronModule = await import('electron').catch(() => null)
    const session = electronModule?.session?.defaultSession
    if (!session?.cookies) return false

    const authorities = [`127.0.0.1:${port}`, `localhost:${port}`]
    for (const auth of authorities) {
      const cookie = generateDshSessionCookie(auth, secret)
      if (cookie) {
        await session.cookies.set({
          url: `http://${auth}/`,
          name: cookie.name,
          value: cookie.value,
          path: '/',
          httpOnly: true,
          sameSite: 'no_restriction',
          expirationDate: Math.floor(cookie.expiresAt / 1000),
        }).catch(() => {})
      }
    }
    return true
  } catch (e) {
    console.warn('[DSH Cordis Web] 注入 DSH 会话 Cookie 异常:', e)
    return false
  }
}

/**
 * 依据指定端口查找正在监听的系统进程 PID。
 */
export function findPidByPort(port: number): number | undefined {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano -p tcp | findstr :${port}`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const lines = out.trim().split('\n')
      for (const line of lines) {
        if (line.includes('LISTENING')) {
          const parts = line.trim().split(/\s+/)
          const lastPart = parts[parts.length - 1]
          if (lastPart) {
            const pid = parseInt(lastPart, 10)
            if (!Number.isNaN(pid) && pid > 0) return pid
          }
        }
      }
    } else {
      const out = execSync(`lsof -ti :${port} -sTCP:LISTEN`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const firstLine = out.trim().split('\n')[0]
      if (firstLine) {
        const pid = parseInt(firstLine, 10)
        if (!Number.isNaN(pid) && pid > 0) return pid
      }
    }
  } catch {
    // 探测失败或未占用时静默忽略
  }
  return undefined
}

export interface DshProbeResult {
  portInUse: boolean
  isDsh: boolean
  url?: string
}

/**
 * 探测指定端口是否已启动服务，并识别是否为 DSH Web 实例。
 */
export async function probeDshCordisServer(options: {
  port: number
  dshRootDir?: string
  timeoutMs?: number
  fetchFn?: typeof fetch
}): Promise<DshProbeResult> {
  const { port, dshRootDir = getDshHomeDir(), timeoutMs = 1500, fetchFn = globalThis.fetch } = options
  const targetUrl = `http://127.0.0.1:${port}/`

  const secret = readDshBrowserSessionSecret(dshRootDir)
  let cookieHeader = ''
  if (secret) {
    const cookie = generateDshSessionCookie(`127.0.0.1:${port}`, secret)
    if (cookie) {
      cookieHeader = `${cookie.name}=${cookie.value}`
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetchFn(targetUrl, {
      method: 'GET',
      headers: {
        host: `127.0.0.1:${port}`,
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
      signal: controller.signal,
      redirect: 'manual',
    })
    clearTimeout(timer)

    const text = await res.text().catch(() => '')
    const isDshUnauthorized = res.status === 401 && text.includes('dsh web authentication required')
    const isDshAuthorized =
      (res.status === 200 && (text.includes('__ModuleLoader__') || text.includes('dsh') || text.includes('<title>dsh'))) ||
      (res.status === 303 && res.headers.get('location') === '/')

    if (isDshUnauthorized || isDshAuthorized) {
      return {
        portInUse: true,
        isDsh: true,
        url: targetUrl,
      }
    }

    return {
      portInUse: true,
      isDsh: false,
    }
  } catch {
    clearTimeout(timer)
    return {
      portInUse: false,
      isDsh: false,
    }
  }
}

/**
 * 检测某个 TCP 端口是否空闲可用（未被任何本地进程监听）。
 */
export async function isPortAvailable(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createNetServer()
    server.once('error', () => {
      resolve(false)
    })
    server.once('listening', () => {
      server.close(() => {
        resolve(true)
      })
    })
    server.listen(port, host)
  })
}

export type DshPortAllocationResult =
  | { type: 'reuse'; port: number; url: string }
  | { type: 'available'; port: number }
  | { type: 'none_available'; error: string }

/**
 * 寻找可复用的已有 DSH 实例，或在发生端口冲突时自动回避并分配下一个可用端口。
 *
 * 扫描策略：
 * 1. 从 basePort (默认 53080) 开始扫描至 basePort + maxScanOffset；
 * 2. 若某个端口正在运行 DSH，优先直接复用该端口（type: 'reuse'）；
 * 3. 若某个端口被第三方非 DSH 应用占用，记录冲突日志并自动探测下一个候选端口；
 * 4. 若某个端口完全空闲，则返回该端口作为启动目标（type: 'available'）；
 * 5. 若扫描范围内所有端口均被占用且无 DSH，返回无法分配错误。
 */
export async function findOrAllocateDshPort(options: {
  basePort?: number
  maxScanOffset?: number
  dshRootDir?: string
  fetchFn?: typeof fetch
} = {}): Promise<DshPortAllocationResult> {
  const {
    basePort = COPIS_DSH_PORT,
    maxScanOffset = COPIS_DSH_MAX_PORT_SCAN,
    dshRootDir = getDshHomeDir(),
    fetchFn = globalThis.fetch,
  } = options

  let conflictEncountered = false

  for (let offset = 0; offset <= maxScanOffset; offset++) {
    const candidatePort = basePort + offset
    const probe = await probeDshCordisServer({
      port: candidatePort,
      dshRootDir,
      fetchFn,
    })

    if (probe.portInUse) {
      if (probe.isDsh) {
        return {
          type: 'reuse',
          port: candidatePort,
          url: probe.url || `http://127.0.0.1:${candidatePort}/`,
        }
      }

      // 端口被其他非 DSH 应用占用，标记冲突并回避到下一端口
      conflictEncountered = true
      console.warn(`[DSH Cordis Web] 候选端口 ${candidatePort} 已被其他应用占用，自动回避并检测下一端口...`)
      continue
    }

    // probe 探测未发现 HTTP 服务，进一步通过 TCP 绑定检测是否确实空闲
    const available = await isPortAvailable(candidatePort)
    if (available) {
      if (conflictEncountered) {
        console.log(`[DSH Cordis Web] 已回避端口冲突，选择可用端口 ${candidatePort} 启动 DSH 服务`)
      }
      return {
        type: 'available',
        port: candidatePort,
      }
    }
  }

  return {
    type: 'none_available',
    error: `端口 ${basePort} 至 ${basePort + maxScanOffset} 均被其他应用占用，无法分配可用端口启动 DSH 服务`,
  }
}

let startingPromise: Promise<DshCordisStatus> | null = null

/**
 * 启动 DSH Cordis 创造模式 Web 服务
 */
export async function startDshCordisServer(options: {
  dshCommand?: string
  dshNode?: string
  dshRootDir?: string
  profile?: string
  port?: number
  timeoutMs?: number
} = {}): Promise<DshCordisStatus> {
  if (state.status.running && state.status.url) {
    return { ...state.status }
  }

  if (startingPromise) {
    return startingPromise
  }

  startingPromise = doStartDshCordisServer(options).finally(() => {
    startingPromise = null
  })

  return startingPromise
}

async function doStartDshCordisServer(options: {
  dshCommand?: string
  dshNode?: string
  dshRootDir?: string
  profile?: string
  port?: number
  timeoutMs?: number
} = {}): Promise<DshCordisStatus> {
  if (state.status.running && state.status.url) {
    return { ...state.status }
  }

  const dshCmd = options.dshCommand !== undefined ? options.dshCommand : resolveDshCommand()
  const dshNode = options.dshNode !== undefined ? options.dshNode : resolveDshNode()
  const dshHomeDir = options.dshRootDir || getDshHomeDir()
  const profile = options.profile || COPIS_DSH_PROFILE
  const port = options.port !== undefined ? options.port : COPIS_DSH_PORT

  if (!dshCmd) {
    state.status = {
      running: false,
      error: '未找到已激活的创造模式运行时，请检查功能模块安装状态',
    }
    notifyDshCordisStatusChange(state.status)
    return { ...state.status }
  }

  ensureCordisWebProfile(dshHomeDir, profile)
  // 托管模块的 launcher 位于 bin/，同时兼容已安装版本而无需重新下载模块。
  patchDshComposerHistoryRuntime(join(dshCmd, '..', '..', 'runtime'))
  patchDshHeroLogoRuntime(join(dshCmd, '..', '..', 'runtime'))
  patchDshSidebarRuntime(join(dshCmd, '..', '..', 'runtime'))
  registerDshCordisWebSessionHeaders()

  // 1. 端口冲突检测、自动回避与已有 DSH 实例自动复用
  let targetPort = port
  try {
    const allocation = await findOrAllocateDshPort({
      basePort: port,
      dshRootDir: dshHomeDir,
    })

    if (allocation.type === 'none_available') {
      state.status = {
        running: false,
        error: allocation.error,
      }
      notifyDshCordisStatusChange(state.status)
      return { ...state.status }
    }

    if (allocation.type === 'reuse' && shouldRestartReusedDshServer(state.process !== null)) {
      console.log(`[DSH Cordis Web] 检测到端口 ${allocation.port} 上次启动遗留的 DSH 实例，正在重启以注入本次启动的 capability`)
      try {
        await stopStaleDshServer(allocation.port)
        targetPort = allocation.port
      } catch (error) {
        state.status = {
          running: false,
          error: error instanceof Error ? error.message : String(error),
        }
        notifyDshCordisStatusChange(state.status)
        return { ...state.status }
      }
    } else if (allocation.type === 'reuse') {
      const reusedPort = allocation.port
      console.log(`[DSH Cordis Web] 检测到端口 ${reusedPort} 已有运行中的 DSH 实例，直接复用该服务`)
      const secret = readDshBrowserSessionSecret(dshHomeDir)
      if (secret) {
        await injectDshSessionCookies(reusedPort, secret)
      }

      // 同步最新的 Copis 模型配置并触碰 cordis.patch.yml 触发已有进程的热重载
      try {
        await syncCopisModelConfigToDsh({ dshRootDir: dshHomeDir, profile })
        const patchFile = join(dshHomeDir, 'profiles', profile, 'cordis.patch.yml')
        if (existsSync(patchFile)) {
          const currentContent = readFileSync(patchFile, 'utf-8')
          const cleaned = currentContent.replace(/\n# live-reload: [^\n]*/g, '').trimEnd()
          writeFileSync(patchFile, `${cleaned}\n# live-reload: ${new Date().toISOString()}\n`, 'utf-8')
        }
      } catch (syncErr) {
        console.warn('[DSH Cordis Web] 复用服务时同步模型配置异常:', syncErr)
      }

      state.reusedPid = findPidByPort(reusedPort)
      state.status = {
        running: true,
        port: reusedPort,
        url: allocation.url,
      }
      notifyDshCordisStatusChange(state.status)
      return { ...state.status }
    }

    targetPort = allocation.port
    if (targetPort !== port) {
      console.log(`[DSH Cordis Web] 发生端口冲突，已自动回避至可用端口 ${targetPort} 启动服务`)
    }
  } catch (probeErr) {
    console.warn('[DSH Cordis Web] 端口探测分配异常，使用默认端口尝试启动:', probeErr)
  }

  let modelEnv: Record<string, string> = {}
  try {
    const modelConfig = await syncCopisModelConfigToDsh({ dshRootDir: dshHomeDir, profile })
    modelEnv = modelConfig.env
  } catch (e) {
    console.warn('[DSH Cordis Web] 启动时同步 Copis 模型配置异常:', e)
  }

  const timeoutMs = options.timeoutMs ?? 20000

  return new Promise<DshCordisStatus>((resolve) => {
    let settled = false
    let lastStderr = ''

    const env = {
      ...process.env,
      ...modelEnv,
      DSH_HOME: dshHomeDir,
      ...(dshNode ? { COPIS_DSH_NODE: dshNode } : {}),
    }

    const child = spawn(dshCmd, ['--profile', profile, '--no-open', '--port', String(targetPort)], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })

    state.process = child

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        state.status = {
          running: false,
          error: `启动 DSH Cordis 运行时超时 (20s)，未能捕获端口 ${targetPort} 的服务授权地址`,
        }
        notifyDshCordisStatusChange(state.status)
        resolve({ ...state.status })
      }
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      const urlMatch = text.match(/https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)(?:\/[^\s]*)?/)
      if (urlMatch && urlMatch[1]) {
        const detectedPort = parseInt(urlMatch[1], 10)
        const targetUrl = urlMatch[0]
        state.status = {
          running: true,
          port: detectedPort,
          url: targetUrl,
        }
        notifyDshCordisStatusChange(state.status)

        // 同步提取 Cookie 认证凭证并写入 Electron session，防止跨域 iframe 被 SameSite=Strict 阻断 401
        void (async () => {
          try {
            const res = await fetch(targetUrl, { redirect: 'manual' })
            const setCookie = res.headers.get('set-cookie')
            if (setCookie) {
              const electronModule = await import('electron').catch(() => null)
              const session = electronModule?.session?.defaultSession
              if (session) {
                const firstPart = setCookie.split(';')[0]
                if (firstPart) {
                  const eqIdx = firstPart.indexOf('=')
                  if (eqIdx !== -1) {
                    const name = firstPart.slice(0, eqIdx).trim()
                    const value = firstPart.slice(eqIdx + 1).trim()
                    await session.cookies.set({
                      url: `http://127.0.0.1:${detectedPort}/`,
                      name,
                      value,
                      path: '/',
                      httpOnly: true,
                      sameSite: 'no_restriction',
                    }).catch(() => {})
                  }
                }
              }
            }
          } catch {
            // 预热 Cookie 失败不影响主流程
          }
        })()

        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve({ ...state.status })
        }
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      const errText = chunk.toString('utf-8')
      lastStderr += errText
      console.warn('[DSH Cordis Web]', errText.trim())
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      state.process = null
      state.status = {
        running: false,
        error: err.message,
      }
      notifyDshCordisStatusChange(state.status)
      if (!settled) {
        settled = true
        resolve({ ...state.status })
      }
    })

    child.on('exit', (code, signal) => {
      console.log(`[DSH Cordis Web] 进程已退出 (code: ${code}, signal: ${signal})`)
      state.process = null
      let errorMessage: string | undefined
      if (code !== null && code !== 0) {
        if (lastStderr.includes('EADDRINUSE')) {
          errorMessage = `端口 ${targetPort} 已被占用，请释放该端口后重试`
        } else {
          errorMessage = `DSH 运行时退出 (code: ${code})`
        }
      }
      state.status = {
        running: false,
        error: errorMessage,
      }
      notifyDshCordisStatusChange(state.status)
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve({ ...state.status })
      }
    })
  })
}

/**
 * 停止 DSH Cordis Web 服务
 */
export function stopDshCordisServer(): DshCordisStatus {
  startingPromise = null
  if (state.process) {
    try {
      if (process.platform !== 'win32' && state.process.pid) {
        // 杀掉进程组
        try {
          process.kill(-state.process.pid, 'SIGTERM')
        } catch {
          state.process.kill('SIGTERM')
        }
      } else {
        state.process.kill('SIGTERM')
      }
    } catch (e) {
      console.warn('[DSH Cordis Web] 停止进程异常:', e)
    }
    state.process = null
  } else if (state.reusedPid && state.reusedPid !== process.pid) {
    try {
      process.kill(state.reusedPid, 'SIGTERM')
      console.log(`[DSH Cordis Web] 已停止复用的 DSH 进程 (PID: ${state.reusedPid})`)
    } catch (e) {
      console.warn(`[DSH Cordis Web] 停止复用进程 (PID: ${state.reusedPid}) 异常:`, e)
    }
    state.reusedPid = undefined
  }

  state.status = {
    running: false,
  }
  notifyDshCordisStatusChange(state.status)

  return { ...state.status }
}

/**
 * 触发 DSH Cordis 插件热重载与自更新。
 *
 * 利用 DSH 在 COPIS_DSH_PROFILE 下启用的 patchReload: 'live' 特性，
 * 通过触碰并更新 cordis.patch.yml 激活微内核的实时补丁重载器。
 * 如果服务尚未运行，则自动按需启动。
 */
export async function reloadDshCordisPlugins(options: {
  dshRootDir?: string
  profile?: string
  startIfNeeded?: boolean
  timeoutMs?: number
} = {}): Promise<DshCordisStatus> {
  const dshHomeDir = options.dshRootDir || getDshHomeDir()
  const profile = options.profile || COPIS_DSH_PROFILE

  const profileDir = ensureCordisWebProfile(dshHomeDir, profile)
  const patchFile = join(profileDir, 'cordis.patch.yml')

  // 同步最新的 Copis 模型配置到 settings.yaml、.credentials.yaml 和 cordis.patch.yml
  try {
    await syncCopisModelConfigToDsh({ dshRootDir: dshHomeDir, profile })
  } catch (e) {
    console.warn('[DSH Cordis Web] 重载时同步 Copis 模型配置异常:', e)
  }

  // 更新 cordis.patch.yml 触发 DSH 内部的 live patch watcher
  try {
    let currentContent = ''
    if (existsSync(patchFile)) {
      currentContent = readFileSync(patchFile, 'utf-8')
    }
    // 移除历史时间戳注释并追加最新更新时间戳
    const cleanedContent = currentContent.replace(/\n# live-reload: [^\n]*/g, '').trimEnd()
    const newContent = `${cleanedContent}\n# live-reload: ${new Date().toISOString()}\n`
    writeFileSync(patchFile, newContent, 'utf-8')
    console.log(`[DSH Cordis Web] 已触碰 ${patchFile} 触发 live patch reload`)
  } catch (err) {
    console.warn('[DSH Cordis Web] 更新 cordis.patch.yml 失败:', err)
  }

  // 如果服务未处于运行中状态且允许自启动，启动服务
  if (!state.status.running && options.startIfNeeded !== false) {
    return await startDshCordisServer({
      dshRootDir: dshHomeDir,
      profile,
      timeoutMs: options.timeoutMs ?? 5000,
    })
  }

  return { ...state.status }
}
