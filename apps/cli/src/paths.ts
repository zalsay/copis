/**
 * 会话存储路径解析（electron-free）。
 *
 * Copis 主进程用 config-paths.ts 里的 getConfigDir()，其中通过 require('electron')
 * 判断 isPackaged 来在 .copis / .copis-dev 间切换——CLI 没有 electron 运行时，
 * 因此这里独立实现一份等价逻辑：
 *   - 默认 ~/.copis
 *   - 环境变量 COPIS_DEV=1 → ~/.copis-dev
 *   - 显式 configDir 覆盖（CLI 的 --config-dir）优先级最高
 *
 * 与 config-paths.ts 的目录布局保持一致：
 *   <configDir>/agent-sessions.json        会话索引
 *   <configDir>/agent-sessions/<id>.jsonl   单会话消息
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { cpSync, existsSync, renameSync } from 'node:fs'

export interface PathOptions {
  /** 显式指定配置目录（绝对路径）。优先级最高。 */
  configDir?: string
  /** 使用开发目录 .copis-dev（等价于 COPIS_DEV=1）。 */
  dev?: boolean
}

export interface ConfigDirNameOptions {
  copisDev?: string
  promaDev?: string
}

export function resolveConfigDirName(options: ConfigDirNameOptions = {}): string {
  if (options.copisDev === '1') return '.copis-dev'
  if (options.copisDev === '0') return '.copis'
  if (options.promaDev === '1') return '.copis-dev'
  if (options.promaDev === '0') return '.copis'
  return '.copis'
}

export function migrateLegacyConfigDirectory(homeDir: string, targetDirName: string): void {
  const legacyDirName = targetDirName === '.copis-dev' ? '.proma-dev' : targetDirName === '.copis' ? '.proma' : undefined
  if (!legacyDirName) return

  const targetDir = join(homeDir, targetDirName)
  const legacyDir = join(homeDir, legacyDirName)
  if (existsSync(targetDir) || !existsSync(legacyDir)) return

  try {
    renameSync(legacyDir, targetDir)
  } catch (error) {
    try {
      cpSync(legacyDir, targetDir, { recursive: true, errorOnExist: true, force: false })
    } catch (copyError) {
      throw new Error(`迁移旧配置目录失败: ${legacyDir} -> ${targetDir}`, { cause: copyError })
    }
    console.warn(`[配置] 旧配置目录无法直接重命名，已复制到 ${targetDir}，旧目录保留`, error)
  }
}

export function resolveConfigDir(opts: PathOptions = {}): string {
  if (opts.configDir) return opts.configDir
  const configDirName = resolveConfigDirName({
    copisDev: opts.dev ? '1' : process.env.COPIS_DEV,
    promaDev: process.env.PROMA_DEV,
  })
  const homeDir = homedir()
  migrateLegacyConfigDirectory(homeDir, configDirName)
  return join(homeDir, configDirName)
}

export function getSessionsIndexPath(opts: PathOptions = {}): string {
  return join(resolveConfigDir(opts), 'agent-sessions.json')
}

export function getSessionsDir(opts: PathOptions = {}): string {
  return join(resolveConfigDir(opts), 'agent-sessions')
}

export function getSessionMessagesPath(id: string, opts: PathOptions = {}): string {
  return join(getSessionsDir(opts), `${id}.jsonl`)
}
