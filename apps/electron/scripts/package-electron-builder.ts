import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { electronPlatformKey, resolveElectronVersion, type ElectronVersionMetadata } from '../../../scripts/electron-platform-version'

export interface PackagingPlan { version: string; builderArgs: string[]; rendererEnv: Record<string, string> }

export function createPackagingPlan(args: string[], metadata: ElectronVersionMetadata): PackagingPlan {
  const platform = args.includes('--win') ? 'win32' : args.includes('--linux') ? 'linux' : args.includes('--mac') ? 'darwin' : process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin'
  const archFlags = args.filter(arg => ['--arm64', '--x64', '--ia32'].includes(arg))
  if (archFlags.length > 1 || archFlags.includes('--ia32')) throw new Error('Electron 打包只能指定一个受支持的架构')
  const arch = archFlags[0]?.slice(2) ?? (platform === 'win32' || platform === 'linux' ? 'x64' : process.arch === 'x64' ? 'x64' : 'arm64')
  const version = resolveElectronVersion(metadata, platform, arch)
  if (args.some(arg => arg.startsWith('--config.extraMetadata.version='))) throw new Error('不得覆盖平台版本配置')
  return {
    version,
    builderArgs: [...args, `--config.extraMetadata.version=${version}`],
    rendererEnv: { COPIS_BUILD_APP_VERSION: version },
  }
}

if (import.meta.main) {
  const appDir = resolve(import.meta.dir, '..')
  const metadata = JSON.parse(readFileSync(resolve(appDir, 'package.json'), 'utf8')) as ElectronVersionMetadata
  const plan = createPackagingPlan(process.argv.slice(2), metadata)
  const build = spawnSync(process.execPath, ['run', 'build:renderer'], { cwd: appDir, env: { ...process.env, ...plan.rendererEnv }, stdio: 'inherit' })
  if (build.error) throw build.error
  if (build.status !== 0) process.exit(build.status ?? 1)
  const result = spawnSync(process.execPath, ['x', 'electron-builder', ...plan.builderArgs], { cwd: appDir, env: { ...process.env, ...plan.rendererEnv }, stdio: 'inherit' })
  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}
