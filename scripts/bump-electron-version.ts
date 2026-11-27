import { join } from 'node:path'
import { electronPlatformKey, resolveElectronVersion, validateElectronVersion, type ElectronVersionMetadata } from './electron-platform-version'
export { validateElectronVersion } from './electron-platform-version'

export function incrementPatchVersion(version: string): string {
  const [major, minor, patch] = validateElectronVersion(version).split('.').map(Number) as [number, number, number]

  // 历史超限版本也在下次递增时进位，低位归零，不保留超限余数。
  if (minor > 99 || (minor === 99 && patch >= 99)) {
    return validateElectronVersion(`${major + 1}.0.0`)
  }
  if (patch >= 99) {
    return `${major}.${minor + 1}.0`
  }
  return `${major}.${minor}.${patch + 1}`
}

export async function setElectronVersion(
  version: string,
  packagePath = join(import.meta.dir, '..', 'apps', 'electron', 'package.json'),
  platform?: string,
  arch?: string,
): Promise<string> {
  const packageFile = Bun.file(packagePath)
  const packageJson = await packageFile.json() as ElectronVersionMetadata
  if (typeof packageJson.version !== 'string' || packageJson.version.trim() === '') {
    throw new Error(`Electron package.json 缺少有效 version：${packagePath}`)
  }

  const nextVersion = validateElectronVersion(version)
  if (platform !== undefined || arch !== undefined) {
    const key = electronPlatformKey(platform ?? '', arch ?? '')
    packageJson.copis = { ...packageJson.copis, platformVersions: {
      ...packageJson.copis?.platformVersions, [key]: nextVersion,
    } }
  } else {
    packageJson.version = nextVersion
  }
  await Bun.write(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
  return nextVersion
}

export async function bumpElectronVersion(packagePath = join(import.meta.dir, '..', 'apps', 'electron', 'package.json'), platform?: string, arch?: string): Promise<string> {
  const packageFile = Bun.file(packagePath)
  const packageJson = await packageFile.json() as ElectronVersionMetadata
  if (typeof packageJson.version !== 'string' || packageJson.version.trim() === '') {
    throw new Error(`Electron package.json 缺少有效 version：${packagePath}`)
  }

  const currentVersion = platform !== undefined || arch !== undefined
    ? resolveElectronVersion(packageJson, platform ?? '', arch ?? '') : packageJson.version
  return setElectronVersion(incrementPatchVersion(currentVersion), packagePath, platform, arch)
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  let platform: string | undefined
  let arch: string | undefined
  for (const option of ['--platform', '--arch']) {
    const index = args.indexOf(option)
    if (index < 0) continue
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${option} 缺少参数`)
    if (option === '--platform') platform = value
    else arch = value
    args.splice(index, 2)
  }
  if (platform !== undefined || arch !== undefined) electronPlatformKey(platform ?? '', arch ?? '')
  if (args.length === 1 && args[0] === '--new') {
    console.log(await bumpElectronVersion(undefined, platform, arch))
  } else if (args.length === 2 && args[0] === '--set') {
    console.log(await setElectronVersion(args[1]!, undefined, platform, arch))
  } else if (args.length === 1 && args[0] === '--get' && platform && arch) {
    const { readElectronVersion } = await import('./electron-platform-version')
    console.log(readElectronVersion(platform, arch))
  } else {
    throw new Error('用法：bun scripts/bump-electron-version.ts --get / --new / --set <version> [--platform darwin|win32|linux --arch arm64|x64]')
  }
}
