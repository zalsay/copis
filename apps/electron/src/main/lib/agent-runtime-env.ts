import { existsSync } from 'node:fs'
import { delimiter, dirname, join, win32 } from 'node:path'
import type { RuntimeStatus, WindowsShellPreference } from '@copis/shared'
import { getBundledCliPath } from './config-paths'
import { selectWindowsShell, type WindowsShellKind } from './windows-shell-selection'

export type AgentRuntimeShellKind = WindowsShellKind

export interface AgentRuntimeEnv {
  env: Record<string, string>
  shellKind?: AgentRuntimeShellKind
  shellPath?: string
  wslCommand?: string
  wslDistro?: string
}

export interface BuildAgentRuntimeEnvOptions {
  proxyUrl?: string
  runtimeStatus?: RuntimeStatus | null
  windowsShellPreference?: WindowsShellPreference
  bundledCliPath?: string
  officeCliPath?: string
  /** 已激活 dsh 的入口文件（bin/dsh 或 bin/dsh.cmd）。 */
  dshPath?: string
  /** dsh 使用的 Node.js 运行时路径。 */
  dshNodePath?: string
  /** 已激活 Python runtime 的入口文件（bin/python 或 bin/python.exe）。 */
  pythonRuntimePath?: string
  /** Dashi PPT 相关环境配置。 */
  dashiPptRoot?: string
  dashiPptProjectRoot?: string
  nodeModulesRoot?: string
  playwrightCoreEntrypoint?: string
  chromiumHeadlessShell?: string
  processEnv?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  pathDelimiter?: string
  pathExists?: (path: string) => boolean
}

const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'] as const
const CASE_INSENSITIVE_MERGE_KEYS = new Set([
  'path',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'copis_cli',
  'copis_dsh',
  'copis_dsh_node',
  'copis_python_runtime_root',
  'copis_dashi_ppt_root',
  'copis_dashi_ppt_project_root',
  'copis_node_modules_root',
  'copis_playwright_core_entry',
  'copis_playwright_headless_shell',
  'pythonhome',
  'shell',
  'copis_windows_shell',
  'copis_wsl_distro',
])

function getCaseInsensitiveEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const exact = env[key]
  if (exact) return exact
  const foundKey = Object.keys(env).find((name) => name.toLowerCase() === key.toLowerCase())
  const value = foundKey ? env[foundKey] : undefined
  return value || undefined
}

function getPathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
}

function hasPathEntry(entries: string[], entry: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') {
    const normalizedEntry = entry.toLowerCase()
    return entries.some((item) => item.toLowerCase() === normalizedEntry)
  }
  return entries.includes(entry)
}

function prependPathEntry(
  currentPath: string | undefined,
  entry: string | undefined,
  pathDelimiter: string,
  platform: NodeJS.Platform,
): string | undefined {
  const entries = (currentPath ?? '').split(pathDelimiter).filter(Boolean)
  if (!entry) return entries.join(pathDelimiter) || undefined
  if (hasPathEntry(entries, entry, platform)) return entries.join(pathDelimiter) || entry
  return [entry, ...entries].join(pathDelimiter)
}

function dirnameForPlatform(path: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? win32.dirname(path) : dirname(path)
}

function collectProxyEnv(proxyUrl: string | undefined, processEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  const trimmedProxyUrl = proxyUrl?.trim()
  const setProxyEnv = (key: string, value: string): void => {
    env[key] = value
    env[key.toLowerCase()] = value
  }

  if (trimmedProxyUrl) {
    for (const key of PROXY_ENV_KEYS) {
      setProxyEnv(key, trimmedProxyUrl)
    }
  } else {
    for (const key of PROXY_ENV_KEYS) {
      const value = getCaseInsensitiveEnvValue(processEnv, key)
      if (value) setProxyEnv(key, value)
    }
  }

  const noProxy = getCaseInsensitiveEnvValue(processEnv, 'NO_PROXY')
  if (noProxy) setProxyEnv('NO_PROXY', noProxy)

  return env
}

function getWslCommandPath(
  processEnv: NodeJS.ProcessEnv,
  pathExists: (path: string) => boolean,
): string {
  const systemRoot = processEnv.SystemRoot ?? processEnv.SYSTEMROOT ?? processEnv.windir ?? processEnv.WINDIR
  const candidates = systemRoot
    ? [
        join(systemRoot, 'System32', 'wsl.exe'),
        join(systemRoot, 'Sysnative', 'wsl.exe'),
      ]
    : []

  return candidates.find(pathExists) ?? 'wsl.exe'
}

function collectWindowsShellEnv(
  runtimeStatus: RuntimeStatus | null | undefined,
  preference: WindowsShellPreference | undefined,
  processEnv: NodeJS.ProcessEnv,
  pathExists: (path: string) => boolean,
): Omit<AgentRuntimeEnv, 'env'> & { env: Record<string, string> } {
  const shellStatus = runtimeStatus?.shell
  const env: Record<string, string> = {}
  const shellKind = selectWindowsShell(shellStatus, preference)

  if (shellKind === 'wsl' && shellStatus?.wsl.available) {
    const wslCommand = getWslCommandPath(processEnv, pathExists)
    env.COPIS_WINDOWS_SHELL = 'wsl'
    env.SHELL = wslCommand
    if (shellStatus.wsl.defaultDistro) {
      env.COPIS_WSL_DISTRO = shellStatus.wsl.defaultDistro
    }
    return {
      env,
      shellKind: 'wsl',
      wslCommand,
      ...(shellStatus.wsl.defaultDistro && { wslDistro: shellStatus.wsl.defaultDistro }),
    }
  }

  if (shellKind === 'git-bash' && shellStatus?.gitBash.path) {
    const shellPath = shellStatus.gitBash.path
    env.COPIS_WINDOWS_SHELL = 'git-bash'
    env.SHELL = shellPath
    return {
      env,
      shellKind: 'git-bash',
      shellPath,
    }
  }

  return { env }
}

/** 为旧版 Skill 保留环境变量别名，新代码统一使用 COPIS_*。 */
function addLegacyEnvironmentAliases(env: Record<string, string>): Record<string, string> {
  const aliases = { ...env }
  if (env.COPIS_CLI) aliases.PROMA_CLI = env.COPIS_CLI
  if (env.COPIS_WINDOWS_SHELL) aliases.PROMA_WINDOWS_SHELL = env.COPIS_WINDOWS_SHELL
  if (env.COPIS_WSL_DISTRO) aliases.PROMA_WSL_DISTRO = env.COPIS_WSL_DISTRO
  return aliases
}

export function mergeRuntimeEnv(
  baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined,
  overrideEnv: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const merged: Record<string, string> = {}
  const overrideLowerKeys = new Set(Object.keys(overrideEnv ?? {}).map((key) => key.toLowerCase()))

  for (const [key, value] of Object.entries(baseEnv ?? {})) {
    if (value !== undefined) merged[key] = value
  }

  for (const existingKey of Object.keys(merged)) {
    const lowerKey = existingKey.toLowerCase()
    if (overrideLowerKeys.has(lowerKey) && CASE_INSENSITIVE_MERGE_KEYS.has(lowerKey)) {
      delete merged[existingKey]
    }
  }

  for (const [key, value] of Object.entries(overrideEnv ?? {})) {
    if (value === undefined) continue
    merged[key] = value
  }

  return merged
}

export function buildAgentRuntimeEnv(options: BuildAgentRuntimeEnvOptions = {}): AgentRuntimeEnv {
  const processEnv = options.processEnv ?? process.env
  const platform = options.platform ?? process.platform
  const pathDelimiter = options.pathDelimiter ?? delimiter
  const pathExists = options.pathExists ?? existsSync
  const bundledCliPath = options.bundledCliPath ?? getBundledCliPath()
  const env: Record<string, string> = {}

  if (bundledCliPath) env.COPIS_CLI = bundledCliPath
  if (options.officeCliPath) env.COPIS_OFFICECLI = options.officeCliPath
  if (options.dshPath) env.COPIS_DSH = options.dshPath
  if (options.dshNodePath) env.COPIS_DSH_NODE = options.dshNodePath

  const pathKey = getPathKey(processEnv)
  let enhancedPath = processEnv[pathKey]
  for (const binaryPath of [bundledCliPath, options.officeCliPath, options.dshPath]) {
    enhancedPath = prependPathEntry(
      enhancedPath,
      binaryPath ? dirnameForPlatform(binaryPath, platform) : undefined,
      pathDelimiter,
      platform,
    )
  }
  if (options.pythonRuntimePath) {
    const pythonBinPath = dirnameForPlatform(options.pythonRuntimePath, platform)
    const pythonHome = platform === 'win32'
      ? pythonBinPath
      : dirnameForPlatform(pythonBinPath, platform)
    enhancedPath = prependPathEntry(enhancedPath, pythonBinPath, pathDelimiter, platform)
    env.COPIS_PYTHON_RUNTIME_ROOT = pythonHome
    env.PYTHONHOME = pythonHome
  }
  if (options.dashiPptRoot) env.COPIS_DASHI_PPT_ROOT = options.dashiPptRoot
  if (options.dashiPptProjectRoot) env.COPIS_DASHI_PPT_PROJECT_ROOT = options.dashiPptProjectRoot
  if (options.nodeModulesRoot) env.COPIS_NODE_MODULES_ROOT = options.nodeModulesRoot
  if (options.playwrightCoreEntrypoint) env.COPIS_PLAYWRIGHT_CORE_ENTRY = options.playwrightCoreEntrypoint
  if (options.chromiumHeadlessShell) env.COPIS_PLAYWRIGHT_HEADLESS_SHELL = options.chromiumHeadlessShell
  if (enhancedPath) {
    env[pathKey] = enhancedPath
  }

  Object.assign(env, collectProxyEnv(options.proxyUrl, processEnv))

  if (platform === 'win32') {
    const shellRuntimeEnv = collectWindowsShellEnv(
      options.runtimeStatus,
      options.windowsShellPreference,
      processEnv,
      pathExists,
    )
    Object.assign(env, shellRuntimeEnv.env)
    return {
      env: addLegacyEnvironmentAliases(env),
      ...(shellRuntimeEnv.shellKind && { shellKind: shellRuntimeEnv.shellKind }),
      ...(shellRuntimeEnv.shellPath && { shellPath: shellRuntimeEnv.shellPath }),
      ...(shellRuntimeEnv.wslCommand && { wslCommand: shellRuntimeEnv.wslCommand }),
      ...(shellRuntimeEnv.wslDistro && { wslDistro: shellRuntimeEnv.wslDistro }),
    }
  }

  return { env: addLegacyEnvironmentAliases(env) }
}
