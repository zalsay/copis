import { chmodSync, existsSync } from 'node:fs'
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

/** 仅接受当前功能模块目录中已激活、且入口契约正确的 Agent QQ 邮箱 CLI。 */
export function resolveAgentlyCliCommand(rootDir = getFunctionalModulesDir()): string | undefined {
  const active = readActiveFunctionalModule(getFunctionalModulePaths(rootDir), 'agently-cli')
  const entrypoints = process.platform === 'win32'
    ? ['bin/agently-cli.cmd', 'bin/agently-cli.exe']
    : ['bin/agently-cli']
  return active && entrypoints.includes(active.entrypoint) && existsSync(active.path)
    ? prepareExecutable(active.path)
    : undefined
}

/** Agent QQ 邮箱启动器只使用 Copis 功能模块提供的 Node runtime。 */
export function resolveAgentlyCliNode(rootDir = getFunctionalModulesDir()): string | undefined {
  const entrypoint = `bin/${executableName('node')}`
  const active = readActiveFunctionalModule(getFunctionalModulePaths(rootDir), 'node-runtime')
  if (active?.entrypoint !== entrypoint || !existsSync(active.path)) return undefined
  return prepareExecutable(active.path)
}
