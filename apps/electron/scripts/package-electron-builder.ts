import { existsSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { electronPlatformKey, resolveElectronVersion, type ElectronVersionMetadata } from '../../../scripts/electron-platform-version'

type PackagingPlatform = 'win32' | 'linux' | 'darwin'

export interface PackagingPlan { platform: PackagingPlatform; version: string; builderArgs: string[]; rendererEnv: Record<string, string> }

export function createPackagingPlan(args: string[], metadata: ElectronVersionMetadata): PackagingPlan {
  const platform = args.includes('--win') ? 'win32' : args.includes('--linux') ? 'linux' : args.includes('--mac') ? 'darwin' : process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin'
  const archFlags = args.filter(arg => ['--arm64', '--x64', '--ia32'].includes(arg))
  if (archFlags.length > 1 || archFlags.includes('--ia32')) throw new Error('Electron 打包只能指定一个受支持的架构')
  const arch = archFlags[0]?.slice(2) ?? (platform === 'win32' || platform === 'linux' ? 'x64' : process.arch === 'x64' ? 'x64' : 'arm64')
  const version = resolveElectronVersion(metadata, platform, arch)
  if (args.some(arg => arg.startsWith('--config.extraMetadata.version='))) throw new Error('不得覆盖平台版本配置')
  return {
    platform,
    version,
    builderArgs: [...args, `--config.extraMetadata.version=${version}`],
    rendererEnv: { COPIS_BUILD_APP_VERSION: version },
  }
}

export function rotateStaleWindowsUnpackedDirectory(
  appDir: string,
  platform: PackagingPlatform,
  suffix = `${Date.now()}-${process.pid}`,
): string | null {
  if (platform !== 'win32') return null
  const unpackedDir = resolve(appDir, 'out', 'win-unpacked')
  if (!existsSync(unpackedDir)) return null

  const rotatedDir = resolve(appDir, 'out', `.win-unpacked-stale-${suffix}`)
  renameSync(unpackedDir, rotatedDir)
  return rotatedDir
}

export function cleanupStaleWindowsUnpackedDirectories(appDir: string): void {
  const outputDir = resolve(appDir, 'out')
  if (!existsSync(outputDir)) return

  for (const entry of readdirSync(outputDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\.win-unpacked-stale-\d+(?:-\d+)?$/.test(entry.name)) continue
    const staleDir = resolve(outputDir, entry.name)
    if (dirname(staleDir) !== outputDir) continue
    try {
      rmSync(staleDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
    } catch (error) {
      console.warn(`旧 Windows 解包目录暂时无法删除，可稍后手动清理：${staleDir}`, error)
    }
  }
}

if (import.meta.main) {
  const appDir = resolve(import.meta.dir, '..')
  const metadata = JSON.parse(readFileSync(resolve(appDir, 'package.json'), 'utf8')) as ElectronVersionMetadata
  const plan = createPackagingPlan(process.argv.slice(2), metadata)
  const build = spawnSync(process.execPath, ['run', 'build:renderer'], { cwd: appDir, env: { ...process.env, ...plan.rendererEnv }, stdio: 'inherit' })
  if (build.error) throw build.error
  if (build.status !== 0) process.exit(build.status ?? 1)
  const rotatedDir = rotateStaleWindowsUnpackedDirectory(appDir, plan.platform)
  if (rotatedDir) console.info(`已轮换旧 Windows 解包目录：${rotatedDir}`)
  const result = spawnSync(process.execPath, ['x', 'electron-builder', ...plan.builderArgs], {
    cwd: appDir,
    // Bun 1.4 会向 source-map-support 传入负列号，禁用该可选映射以保留原始打包错误。
    env: { ...process.env, ...plan.rendererEnv, JEST_WORKER_ID: process.env.JEST_WORKER_ID ?? 'copis-electron-builder' },
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status === 0) cleanupStaleWindowsUnpackedDirectories(appDir)
  process.exit(result.status ?? 1)
}
