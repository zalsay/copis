import { chmodSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { getFunctionalModulesDir } from './config-paths'
import { getFunctionalModulePaths, readActiveFunctionalModule } from './functional-module-store'

function executableName(name: string): string {
  return process.platform === 'win32' ? `${name}.exe` : name
}

function prepareExecutable(path: string): string {
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, 0o755)
    } catch {
      // 功能模块通常已保留执行权限，无法修改时继续使用原路径。
    }
  }
  return path
}

interface DshSpawnSpec {
  command: string
  args: string[]
  windowsVerbatimArguments?: boolean
}

function quoteWindowsCmdArgument(value: string): string {
  if (/[\r\n]/u.test(value)) {
    throw new Error('DSH Windows 启动参数不能包含换行符')
  }
  return `"${value.replaceAll('"', '""')}"`
}

/**
 * 生成可直接交给 child_process.spawn 的 DSH 启动参数。
 * Windows 无法直接 spawn .cmd，因此优先绕过启动脚本并使用内置 Node.js 执行 CLI 入口。
 */
export function resolveDshSpawnSpec(options: {
  dshCommand: string
  dshNode?: string
  args: string[]
  platform?: NodeJS.Platform
}): DshSpawnSpec {
  const { dshCommand, dshNode, args, platform = process.platform } = options
  const isWindowsScript = platform === 'win32' && ['.cmd', '.bat'].includes(extname(dshCommand).toLowerCase())
  if (!isWindowsScript) {
    return { command: dshCommand, args }
  }

  const cliEntry = resolve(dirname(dshCommand), '../runtime/node_modules/@deepseek-ai/dsh/lib/bin.js')
  if (existsSync(cliEntry)) {
    return {
      command: dshNode || 'node',
      args: [cliEntry, ...args],
    }
  }

  const commandLine = ['call', dshCommand, ...args]
    .map((value, index) => index === 0 ? value : quoteWindowsCmdArgument(value))
    .join(' ')
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', commandLine],
    windowsVerbatimArguments: true,
  }
}

/**
 * 解析 DeepSeek Harness (dsh) CLI 入口。
 *
 * 优先使用当前配置目录下的激活功能模块；
 * 开发模式下若开发配置目录 (~/.copis-dev/modules) 未独立安装模块，自动回退复用生产目录 (~/.copis/modules)；
 * 其次回退检测系统用户级或常用 PATH 入口 (~/.local/bin/dsh 等)。
 */
export function resolveDshCommand(
  rootDir = getFunctionalModulesDir(),
  options: { allowFallback?: boolean } = {},
): string | undefined {
  const allowFallback = options.allowFallback ?? (rootDir === getFunctionalModulesDir())
  const entrypoints = process.platform === 'win32'
    ? ['bin/dsh.cmd', 'bin/dsh.exe']
    : ['bin/dsh']

  // 1. 优先从指定或当前模块目录查找
  const active = readActiveFunctionalModule(getFunctionalModulePaths(rootDir), 'dsh')
  if (active && entrypoints.includes(active.entrypoint) && existsSync(active.path)) {
    return prepareExecutable(active.path)
  }

  if (!allowFallback) {
    return undefined
  }

  // 2. 开发环境回退查找生产配置目录 ~/.copis/modules
  const prodModulesDir = join(homedir(), '.copis', 'modules')
  if (rootDir !== prodModulesDir && existsSync(prodModulesDir)) {
    const prodActive = readActiveFunctionalModule(getFunctionalModulePaths(prodModulesDir), 'dsh')
    if (prodActive && entrypoints.includes(prodActive.entrypoint) && existsSync(prodActive.path)) {
      return prepareExecutable(prodActive.path)
    }
  }

  // 3. 系统 PATH / 用户目录兜底
  const home = homedir()
  const systemCandidates = process.platform === 'win32'
    ? [join(home, '.local', 'bin', 'dsh.cmd'), join(home, '.local', 'bin', 'dsh.exe')]
    : [join(home, '.local', 'bin', 'dsh'), '/usr/local/bin/dsh', '/opt/homebrew/bin/dsh']

  for (const candidate of systemCandidates) {
    if (existsSync(candidate)) {
      return prepareExecutable(candidate)
    }
  }

  return undefined
}

/**
 * 解析 DSH 使用的 Node runtime。
 *
 * 优先从当前功能模块目录获取已激活的 node-runtime；
 * 开发模式下回退复用生产目录 ~/.copis/modules 中的 node-runtime。
 */
export function resolveDshNode(
  rootDir = getFunctionalModulesDir(),
  options: { allowFallback?: boolean } = {},
): string | undefined {
  const allowFallback = options.allowFallback ?? (rootDir === getFunctionalModulesDir())
  const entrypoint = `bin/${executableName('node')}`

  // 1. 优先从指定或当前模块目录查找
  const active = readActiveFunctionalModule(getFunctionalModulePaths(rootDir), 'node-runtime')
  if (active?.entrypoint === entrypoint && existsSync(active.path)) {
    return prepareExecutable(active.path)
  }

  if (!allowFallback) {
    return undefined
  }

  // 2. 开发环境回退查找生产配置目录 ~/.copis/modules
  const prodModulesDir = join(homedir(), '.copis', 'modules')
  if (rootDir !== prodModulesDir && existsSync(prodModulesDir)) {
    const prodActive = readActiveFunctionalModule(getFunctionalModulePaths(prodModulesDir), 'node-runtime')
    if (prodActive?.entrypoint === entrypoint && existsSync(prodActive.path)) {
      return prepareExecutable(prodActive.path)
    }
  }

  return undefined
}
