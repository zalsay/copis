/**
 * 主程序更新安装器
 *
 * macOS：挂载 DMG，把 Copis.app 复制到 /Applications；
 * Windows：使用 NSIS 可视化升级参数拉起安装程序，显示原生安装进度。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const execFileAsync = promisify(execFile)
const MAC_APP_TARGET = '/Applications/Copis.app'

export type AutoInstallKind = 'dmg' | 'nsis' | 'unsupported'

export interface AutoInstallResult {
  kind: AutoInstallKind
  installed: boolean
  appPath?: string
}

/**
 * Windows NSIS 升级安装参数。
 *
 * 保留可视化安装窗口，用户可以看到旧文件迁移与新版本解压进度；`--updated`
 * 会跳过普通安装流程，`--force-run` 让安装器完成后自行启动新版本。
 */
export const WINDOWS_NSIS_UPDATE_ARGUMENTS = ['--updated', '--force-run'] as const

export function planAutoInstall(filePath: string, platform: NodeJS.Platform): AutoInstallKind {
  const lower = basename(filePath).toLowerCase()
  if (platform === 'darwin' && lower.endsWith('.dmg')) return 'dmg'
  if (platform === 'win32' && lower.endsWith('.exe')) return 'nsis'
  return 'unsupported'
}

/** NSIS 在升级完成后自行启动新版本，调用方不能再竞争性重启当前进程。 */
export function doesInstallerHandleAppRestart(kind: AutoInstallKind): boolean {
  return kind === 'nsis'
}

export async function autoInstallDownloadedUpdate(
  filePath: string,
  platform: NodeJS.Platform,
): Promise<AutoInstallResult> {
  const kind = planAutoInstall(filePath, platform)
  if (kind === 'nsis') {
    await execFileAsync(filePath, WINDOWS_NSIS_UPDATE_ARGUMENTS, { timeout: 20 * 60 * 1000 })
    return { kind, installed: true }
  }
  if (kind === 'dmg') {
    const appPath = await installDmg(filePath)
    return { kind, installed: true, appPath }
  }
  return { kind, installed: false }
}

async function installDmg(filePath: string): Promise<string> {
  const mountPoint = await mkdtemp(join(tmpdir(), 'copis-update-'))
  try {
    await execFileAsync(
      'hdiutil',
      ['attach', filePath, '-nobrowse', '-readonly', '-mountpoint', mountPoint, '-quiet'],
      { timeout: 2 * 60 * 1000 },
    )
    const sourceAppPath = await findAppInDmg(mountPoint)
    await execFileAsync('ditto', [sourceAppPath, MAC_APP_TARGET], { timeout: 20 * 60 * 1000 })
    return MAC_APP_TARGET
  } finally {
    await execFileAsync('hdiutil', ['detach', mountPoint, '-force'], { timeout: 60_000 }).catch(() => undefined)
    await rm(mountPoint, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function findAppInDmg(mountPoint: string): Promise<string> {
  const candidates = [mountPoint, join(mountPoint, 'Applications')]
  for (const candidate of candidates) {
    const entries = await readdir(candidate, { withFileTypes: true }).catch(() => [])
    const appEntry = entries.find((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    if (appEntry) return join(candidate, appEntry.name)
  }
  throw new Error('DMG 中没有找到 Copis.app')
}

export function isMacAppInstalled(): boolean {
  return existsSync(MAC_APP_TARGET)
}
