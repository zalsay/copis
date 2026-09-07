import { chmodSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
