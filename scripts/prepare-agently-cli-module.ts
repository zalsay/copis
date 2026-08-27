#!/usr/bin/env bun

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { FunctionalModuleArchitecture, FunctionalModulePlatform } from '@copis/shared'

export const AGENTLY_CLI_VERSION = '1.0.17'
export const AGENTLY_CLI_PACKAGE = '@tencent-qqmail/agently-cli'

const PLATFORM_PACKAGES: Record<FunctionalModulePlatform, Record<FunctionalModuleArchitecture, string>> = {
  darwin: {
    arm64: '@tencent-qqmail/agently-cli-darwin-arm64',
    x64: '@tencent-qqmail/agently-cli-darwin-x64',
  },
  linux: {
    arm64: '@tencent-qqmail/agently-cli-linux-arm64',
    x64: '@tencent-qqmail/agently-cli-linux-x64',
  },
  win32: {
    arm64: '@tencent-qqmail/agently-cli-win32-arm64',
    x64: '@tencent-qqmail/agently-cli-win32-x64',
  },
}

const PLATFORM_PACKAGE_INTEGRITIES: Record<string, string> = {
  '@tencent-qqmail/agently-cli-darwin-arm64': 'sha512-tNmPWYEMt/xpuVMrea9W3C+RrizlyhnnJ6nmZuOol7OPrOHZw0zllM8wDzc0/V22GJqPUDKRR8r2AmQx/Jl9uQ==',
  '@tencent-qqmail/agently-cli-darwin-x64': 'sha512-dQ+x/N1aaGvpcT+tirJRv9707RSmxm/7OciP0tBhptyERTRIKaK4gEeojoucDT1LjUgEEDEcKBp4P30eTpXG7A==',
  '@tencent-qqmail/agently-cli-linux-arm64': 'sha512-iiSLtpzFMvTCSBL1ssfmUvWNnQCWR5H8ZhYIIuhrohu3oI23/VB7j+ZKzls5sLzW9Ka4hfjm/VBE1f+ynBm2vQ==',
  '@tencent-qqmail/agently-cli-linux-x64': 'sha512-FBfBI2iOJ31hBpyVM4vt2jSB96hIuAhhtjKC0tPp8llOMHPfSH3r1nAl5YDwFJCX/OH0lbjvjjr7NqKpPivCMA==',
  '@tencent-qqmail/agently-cli-win32-arm64': 'sha512-iLbPyBeIcMagjcgYppBygY7o6Prcw/2naX+h2PPYCCCob/rlRWUGJCFFh3d+nUwfSuTPnlPY+bne8mJkrOt5yw==',
  '@tencent-qqmail/agently-cli-win32-x64': 'sha512-l8epPXmwoFJ3hQIo8Fd4KLt1WJTbqt5gCy+7KxnkIAUg+4zvtwfROkRlu79UKKxi3rgxJhGhAc5p2DAe58tXYg==',
}

export interface PrepareAgentlyCliModuleOptions {
  platform: FunctionalModulePlatform
  arch: FunctionalModuleArchitecture
  output: string
  version?: string
  npmCommand?: string
}

export function getAgentlyCliPlatformPackage(
  platform: FunctionalModulePlatform,
  arch: FunctionalModuleArchitecture,
): string {
  return PLATFORM_PACKAGES[platform][arch]
}

export function getAgentlyCliEntrypoint(platform: FunctionalModulePlatform): string {
  return `bin/agently-cli${platform === 'win32' ? '.exe' : ''}`
}

export function getAgentlyCliPackageIntegrity(packageName: string): string {
  const integrity = PLATFORM_PACKAGE_INTEGRITIES[packageName]
  if (!integrity || integrity.endsWith('PLACEHOLDER')) {
    throw new Error(`未配置 agently-cli 官方包完整性：${packageName}`)
  }
  return integrity
}

export function prepareAgentlyCliModule(options: PrepareAgentlyCliModuleOptions): string {
  const packageName = getAgentlyCliPlatformPackage(options.platform, options.arch)
  const version = options.version?.trim() || AGENTLY_CLI_VERSION
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`agently-cli 版本不合法：${version}`)

  const output = resolve(options.output)
  const staging = mkdtempSync(join(tmpdir(), 'copis-agently-cli-module-'))
  const packageCache = join(staging, 'package-cache')
  const extractDir = join(staging, 'extracted')
  const temporaryOutput = `${output}.${process.pid}.tmp`
  mkdirSync(packageCache, { recursive: true })
  mkdirSync(extractDir, { recursive: true })

  try {
    const npmCommand = options.npmCommand ?? (process.platform === 'win32' ? 'npm.cmd' : 'npm')
    const packedName = execFileSync(npmCommand, [
      'pack',
      `${packageName}@${version}`,
      '--pack-destination',
      packageCache,
      '--silent',
    ], { cwd: packageCache, encoding: 'utf8' }).trim().split(/\r?\n/).at(-1)?.trim()
    if (!packedName) throw new Error(`下载 agently-cli 官方包失败：${packageName}@${version}`)

    const packageTarball = join(packageCache, packedName)
    if (!isFile(packageTarball)) throw new Error(`agently-cli 官方包归档不存在：${packageTarball}`)
    verifyIntegrity(packageTarball, getAgentlyCliPackageIntegrity(packageName))

    execFileSync('tar', ['-xzf', packageTarball, '-C', extractDir], { stdio: 'ignore' })
    const source = join(extractDir, 'package', ...getAgentlyCliEntrypoint(options.platform).split('/'))
    if (!isFile(source)) throw new Error(`agently-cli 官方包缺少入口：${getAgentlyCliEntrypoint(options.platform)}`)

    mkdirSync(dirname(output), { recursive: true })
    copyFileSync(source, temporaryOutput)
    if (options.platform !== 'win32') {
      execFileSync('chmod', ['755', temporaryOutput], { stdio: 'ignore' })
    }
    renameSync(temporaryOutput, output)

    if (options.platform === process.platform && options.arch === normalizeCurrentArchitecture(process.arch)) {
      const actualVersion = readAgentlyCliVersion(output)
      if (actualVersion !== version) {
        throw new Error(`agently-cli 可执行文件版本不匹配：期望 ${version}，实际 ${actualVersion}`)
      }
    }
    return output
  } finally {
    if (existsSync(temporaryOutput)) rmSync(temporaryOutput, { force: true })
    rmSync(staging, { recursive: true, force: true })
  }
}

export function readAgentlyCliVersion(binaryPath: string): string {
  const output = execFileSync(resolve(binaryPath), ['--version'], { encoding: 'utf8', windowsHide: true }).trim()
  const match = /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/.exec(output)
  if (!match?.[1]) throw new Error(`无法读取 agently-cli 版本：${binaryPath}`)
  return match[1]
}

function verifyIntegrity(path: string, expected: string): void {
  const [algorithm, expectedDigest] = expected.split('-', 2)
  if (algorithm !== 'sha512' || !expectedDigest) throw new Error(`agently-cli 完整性配置不合法：${expected}`)
  const actualDigest = createHash(algorithm).update(readFileSync(path)).digest('base64')
  if (actualDigest !== expectedDigest) throw new Error(`agently-cli 官方包完整性校验失败：${path}`)
}

function normalizeCurrentArchitecture(value: string): FunctionalModuleArchitecture {
  if (value === 'arm64' || value === 'x64') return value
  throw new Error(`当前架构不支持 agently-cli：${value}`)
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile()
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1]?.trim() : undefined
  return value || undefined
}

function parsePlatform(value: string): FunctionalModulePlatform {
  if (value === 'darwin' || value === 'linux' || value === 'win32') return value
  throw new Error(`当前平台不支持 agently-cli：${value}`)
}

function parseArchitecture(value: string): FunctionalModuleArchitecture {
  if (value === 'arm64' || value === 'x64') return value
  throw new Error(`当前架构不支持 agently-cli：${value}`)
}

if (import.meta.main) {
  const platform = parsePlatform(option('--platform') ?? process.platform)
  const arch = parseArchitecture(option('--arch') ?? process.arch)
  const output = option('--output') ?? `apps/electron/resources/bin/agently-cli${platform === 'win32' ? '.exe' : ''}`
  const result = prepareAgentlyCliModule({
    platform,
    arch,
    output,
    version: option('--cli-version') ?? process.env.COPIS_AGENTLY_CLI_VERSION,
  })
  console.log(`[prepare:agently-cli-module] 已生成 ${result}（agently-cli v${option('--cli-version') ?? process.env.COPIS_AGENTLY_CLI_VERSION ?? AGENTLY_CLI_VERSION}）`)
}
