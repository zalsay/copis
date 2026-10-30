#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isChromeDesktopComponentMetadata, type FunctionalModuleArchitecture, type FunctionalModulePlatform } from '@copis/shared'
import { loadFunctionalModuleVersionLocks } from './functional-module-version-lock'

const repoRoot = resolve(import.meta.dir, '..')

export function chromeDesktopEntrypoint(version: string, arch: FunctionalModuleArchitecture): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Chrome 模块版本必须是稳定三段式版本')
  return `copis-chrome-${version}-darwin-${arch}/mcc`
}

/** 只读取归档，不执行待发布二进制；同时核对元数据及 MCC、helper 的 Mach-O 目标架构。 */
export function validateChromeDesktopArchive(
  archive: string,
  platform: FunctionalModulePlatform,
  arch: FunctionalModuleArchitecture,
  version: string,
): { version: string; entrypoint: string } {
  if (platform !== 'darwin') throw new Error('chrome-desktop-cli 仅支持 macOS (darwin)')
  const entrypoint = chromeDesktopEntrypoint(version, arch)
  const top = dirname(entrypoint)
  const listing = tar(['-tzf', archive]).toString('utf8').trim().split('\n')
  const names = listing.map(name => name.replace(/^\.\//, '').replace(/\/$/, ''))
  if (new Set(names).size !== names.length || names.some(name => name !== top && (!name.startsWith(`${top}/`) || name.split('/').includes('..')))) {
    throw new Error('Chrome 归档顶层目录不匹配或包含非法路径')
  }
  const member = (name: string): Buffer => {
    const index = names.indexOf(`${top}/${name}`)
    if (index < 0) throw new Error(`Chrome 归档缺少 ${name}`)
    // 禁止把符号链接或目录作为模块元数据和二进制发布。
    const description = tar(['-tvzf', archive, listing[index]!]).toString('utf8')
    if (!description.startsWith('-')) throw new Error(`Chrome 归档 ${name} 必须是普通文件`)
    if (name !== 'module.json' && description[3] !== 'x') throw new Error(`Chrome 归档 ${name} 不可执行`)
    return tar(['-xOzf', archive, listing[index]!])
  }
  const metadata = JSON.parse(member('module.json').toString('utf8'))
  if (!isChromeDesktopComponentMetadata(metadata, { version, arch }) || metadata.minimumOsVersion !== '14.0') {
    throw new Error('MCC 归档 module.json 版本、平台、架构或原生 helper 元数据不匹配')
  }
  for (const name of ['mcc', metadata.helper]) {
    const bytes = member(name)
    const cpu = arch === 'arm64' ? 0x0100000c : 0x01000007
    if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== cpu) {
      throw new Error(`Chrome 归档 ${name} 不是目标架构的 macOS Mach-O`)
    }
  }
  return { version, entrypoint }
}

export function prepareChromeDesktopModule(options: {
  platform: FunctionalModulePlatform
  arch: FunctionalModuleArchitecture
  version: string
  archive?: string
  output?: string
}): { version: string; entrypoint: string; path: string } {
  const { platform, arch, version } = options
  if (platform !== 'darwin') throw new Error('chrome-desktop-cli 仅支持 macOS (darwin)')
  let archive = options.archive
  if (!archive) {
    if (process.platform !== platform || process.arch !== arch) throw new Error('Chrome 组件只能在本机 macOS 平台和架构构建；其他目标请提供已验证 archive')
    const configuredSource = process.env.COPIS_MCC_SOURCE_DIR
    if (!configuredSource) throw new Error('请提供 MCC archive 或设置 COPIS_MCC_SOURCE_DIR；不再构建仓库内的旧 Chrome CLI')
    const sourceDir = resolve(configuredSource)
    const result = spawnSync('bash', [join(sourceDir, 'build.sh')], { cwd: sourceDir, stdio: 'inherit' })
    if (result.status !== 0) throw new Error('Chrome 独立组件构建失败', { cause: result.error })
    archive = join(sourceDir, 'dist', `${dirname(chromeDesktopEntrypoint(version, arch))}.tar.gz`)
  }
  const metadata = validateChromeDesktopArchive(archive, platform, arch, version)
  const output = resolve(options.output ?? join(repoRoot, 'apps/electron/resources/chrome-desktop-cli', `${platform}-${arch}.tar.gz`))
  mkdirSync(dirname(output), { recursive: true })
  if (resolve(archive) !== output) copyFileSync(archive, output)
  return { ...metadata, path: output }
}

function tar(args: string[]): Buffer {
  const result = spawnSync('tar', args, { maxBuffer: 256 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`读取 Chrome 归档失败: ${result.stderr?.toString().trim()}`, { cause: result.error })
  return result.stdout
}

if (import.meta.main) {
  const option = (name: string) => {
    const index = process.argv.indexOf(name)
    return index < 0 ? undefined : process.argv[index + 1]
  }
  const platform = option('--platform') ?? process.env.COPIS_MODULE_PLATFORM ?? process.platform
  const arch = option('--arch') ?? process.env.COPIS_MODULE_ARCH ?? process.arch
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') throw new Error(`不支持平台: ${platform}`)
  if (arch !== 'arm64' && arch !== 'x64') throw new Error(`不支持架构: ${arch}`)
  const lockedVersion = loadFunctionalModuleVersionLocks()['chrome-desktop-cli']
  const version = option('--version') ?? process.env.COPIS_CHROME_DESKTOP_CLI_VERSION ?? lockedVersion
  if (version !== lockedVersion) throw new Error(`Chrome 模块版本必须与版本锁一致: ${lockedVersion}`)
  const result = prepareChromeDesktopModule({
    platform,
    arch,
    version,
    archive: option('--archive') ?? process.env.COPIS_CHROME_DESKTOP_CLI_ARCHIVE,
    output: option('--output'),
  })
  console.log(`[prepare:chrome-desktop-cli-module] 已生成 ${result.path}（v${result.version}）`)
}
