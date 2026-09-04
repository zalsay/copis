import { chmodSync, existsSync } from 'node:fs'
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

/** 仅接受当前功能模块目录中已激活、且入口契约正确的 DeepSeek Harness (dsh) CLI。 */
export function resolveDshCommand(rootDir = getFunctionalModulesDir()): string | undefined {
  const active = readActiveFunctionalModule(getFunctionalModulePaths(rootDir), 'dsh')
  const entrypoints = process.platform === 'win32'
    ? ['bin/dsh.cmd', 'bin/dsh.exe']
    : ['bin/dsh']
  return active && entrypoints.includes(active.entrypoint) && existsSync(active.path)
    ? prepareExecutable(active.path)
    : undefined
}

/** dsh 启动器优先使用 Copis 功能模块提供的 Node runtime。 */
export function resolveDshNode(rootDir = getFunctionalModulesDir()): string | undefined {
  const entrypoint = `bin/${executableName('node')}`
  const active = readActiveFunctionalModule(getFunctionalModulePaths(rootDir), 'node-runtime')
  if (active?.entrypoint !== entrypoint || !existsSync(active.path)) return undefined
  return prepareExecutable(active.path)
}
