#!/usr/bin/env bun

import { execFileSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { syncRuntimeDeps } from '../apps/electron/scripts/sync-runtime-deps'

export const PLAYWRIGHT_CORE_VERSION = '1.62.1'
export const PLAYWRIGHT_CORE_ENTRYPOINT = 'node_modules/playwright-core/index.js'
const ARCHIVE_TIMESTAMP = new Date(0)

export interface BuildPlaywrightCoreModuleOptions {
  output: string
  sourceNodeModules?: string
  externalRuntimePackages?: readonly string[]
}

/** 将 Playwright Core 及其 Node 依赖闭包打包为不含浏览器二进制的功能模块。 */
export async function buildPlaywrightCoreModule(options: BuildPlaywrightCoreModuleOptions): Promise<string> {
  const output = resolve(options.output)
  const staging = mkdtempSync(join(tmpdir(), 'copis-playwright-core-module-'))
  const temporaryOutput = `${output}.${process.pid}.tmp`
  try {
    const targetNodeModules = join(staging, 'node_modules')
    syncRuntimeDeps({
      sourceNodeModules: options.sourceNodeModules,
      targetNodeModules,
      externalRuntimePackages: options.externalRuntimePackages ?? ['playwright-core'],
    })
    const entrypoint = join(staging, PLAYWRIGHT_CORE_ENTRYPOINT)
    if (!existsSync(entrypoint)) throw new Error(`Playwright 功能模块缺少入口文件: ${PLAYWRIGHT_CORE_ENTRYPOINT}`)
    const packageJson = JSON.parse(readFileSync(join(staging, 'node_modules/playwright-core/package.json'), 'utf8')) as { version?: string }
    if (packageJson.version !== PLAYWRIGHT_CORE_VERSION) {
      throw new Error(`Playwright Core 版本不匹配：期望 ${PLAYWRIGHT_CORE_VERSION}，实际 ${packageJson.version ?? '未知'}`)
    }

    normalizeTimestamps(staging)
    const archiveEntriesPath = join(staging, '.archive-entries')
    writeFileSync(archiveEntriesPath, `${listArchiveEntries(staging).join('\n')}\n`, 'utf8')
    const tarPath = join(staging, 'playwright-core.tar')
    execFileSync('tar', ['--format', 'ustar', '-cf', tarPath, '-C', staging, '-T', archiveEntriesPath], {
      stdio: 'ignore',
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    })
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(temporaryOutput, gzipSync(readFileSync(tarPath), { mtime: 0 }), { mode: 0o644 })
    renameSync(temporaryOutput, output)
    return output
  } finally {
    if (existsSync(temporaryOutput)) rmSync(temporaryOutput, { force: true })
    rmSync(staging, { recursive: true, force: true })
  }
}

function normalizeTimestamps(path: string): void {
  const entries = readdirSync(path, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = join(path, entry.name)
    if (entry.isDirectory()) normalizeTimestamps(entryPath)
    utimesSync(entryPath, ARCHIVE_TIMESTAMP, ARCHIVE_TIMESTAMP)
  }
  utimesSync(path, ARCHIVE_TIMESTAMP, ARCHIVE_TIMESTAMP)
}

function listArchiveEntries(root: string, relativePath = '.'): string[] {
  const absolutePath = relativePath === '.' ? root : join(root, relativePath)
  const entries = readdirSync(absolutePath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
  const result: string[] = []
  for (const entry of entries) {
    const childPath = relativePath === '.' ? `./${entry.name}` : `${relativePath}/${entry.name}`
    if (entry.isDirectory()) result.push(...listArchiveEntries(root, childPath))
    else result.push(childPath)
  }
  return result
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value?.trim() || undefined
}

if (import.meta.main) {
  const output = resolve(option('--output') ?? 'apps/electron/resources/playwright-core/playwright-core.tar.gz')
  await buildPlaywrightCoreModule({ output })
  console.log(`[build:playwright-core-module] 已生成 ${output}`)
}
