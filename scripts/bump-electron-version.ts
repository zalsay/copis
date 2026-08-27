import { join } from 'node:path'

export function incrementPatchVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())
  if (!match) {
    throw new Error(`Electron 应用版本必须是三段式 semver：${version}`)
  }

  const patch = Number(match[3])
  if (!Number.isSafeInteger(patch) || patch >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`Electron 应用 patch 版本超出安全范围：${version}`)
  }

  return `${match[1]}.${match[2]}.${patch + 1}`
}

export function validateElectronVersion(version: string): string {
  const normalized = version.trim()
  if (!/^\d+\.\d+\.\d+$/.test(normalized)) {
    throw new Error(`Electron 应用版本必须是三段式 semver：${version}`)
  }
  return normalized
}

export async function setElectronVersion(
  version: string,
  packagePath = join(import.meta.dir, '..', 'apps', 'electron', 'package.json'),
): Promise<string> {
  const packageFile = Bun.file(packagePath)
  const packageJson = await packageFile.json() as { version?: unknown; [key: string]: unknown }
  if (typeof packageJson.version !== 'string' || packageJson.version.trim() === '') {
    throw new Error(`Electron package.json 缺少有效 version：${packagePath}`)
  }

  const nextVersion = validateElectronVersion(version)
  packageJson.version = nextVersion
  await Bun.write(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
  return nextVersion
}

export async function bumpElectronVersion(packagePath = join(import.meta.dir, '..', 'apps', 'electron', 'package.json')): Promise<string> {
  const packageFile = Bun.file(packagePath)
  const packageJson = await packageFile.json() as { version?: unknown; [key: string]: unknown }
  if (typeof packageJson.version !== 'string' || packageJson.version.trim() === '') {
    throw new Error(`Electron package.json 缺少有效 version：${packagePath}`)
  }

  const nextVersion = incrementPatchVersion(packageJson.version)
  packageJson.version = nextVersion
  await Bun.write(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
  return nextVersion
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--new') {
    console.log(await bumpElectronVersion())
  } else if (args.length === 2 && args[0] === '--set') {
    console.log(await setElectronVersion(args[1]!))
  } else {
    throw new Error('用法：bun scripts/bump-electron-version.ts --new 或 --set <version>')
  }
}
