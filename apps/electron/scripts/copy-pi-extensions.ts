#!/usr/bin/env bun
/**
 * 将默认 Pi 扩展（pi-web-access）及其运行时依赖闭包复制到
 * apps/electron/resources/pi-extensions/，供 electron-builder 经 extraResources
 * 打入 process.resourcesPath/pi-extensions。
 *
 * 打包后的 Pi Worker 是自包含 Bun 二进制，无法读取 app.asar 内的 node_modules，
 * 因此扩展必须落在真实磁盘目录；jiti 会从扩展入口所在目录向上解析依赖，
 * 所以依赖统一铺在 pi-extensions/node_modules/ 下（hoisted 布局）。
 * 源依赖同时兼容 Bun 的 hoisted 和 isolated workspace 布局。
 *
 * 开发模式不需要本脚本：worker 直接从仓库 node_modules 解析扩展。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

interface PackageManifest {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

const appDir = resolve(import.meta.dir, '..')
const repoRoot = resolve(appDir, '../..')
const repoNodeModules = join(repoRoot, 'node_modules')
const appNodeModules = join(appDir, 'node_modules')
const bunVirtualNodeModules = join(repoNodeModules, '.bun', 'node_modules')
const sourceNodeModulesDirs = [appNodeModules, bunVirtualNodeModules, repoNodeModules] as const
const targetRoot = join(appDir, 'resources', 'pi-extensions')
const targetNodeModules = join(targetRoot, 'node_modules')

/** 默认内置的 Pi 扩展包名（与 src/main/lib/adapters/pi-default-extensions.ts 保持一致）。 */
const DEFAULT_PI_EXTENSIONS = ['pi-web-access'] as const

function getPackageDir(nodeModulesDir: string, packageName: string): string {
  if (packageName.startsWith('@')) {
    const [scope, name] = packageName.split('/')
    if (!scope || !name) throw new Error(`非法 scoped package 名称: ${packageName}`)
    return join(nodeModulesDir, scope, name)
  }
  return join(nodeModulesDir, packageName)
}

function resolvePackageFromNodeModules(nodeModulesDir: string, packageName: string): string | undefined {
  const candidate = getPackageDir(nodeModulesDir, packageName)
  if (existsSync(join(candidate, 'package.json'))) {
    return realpathSync(candidate)
  }
  return undefined
}

function resolvePackageUpwards(startDir: string, packageName: string): string | undefined {
  let currentDir = resolve(startDir)

  while (true) {
    const resolvedPackageDir = resolvePackageFromNodeModules(join(currentDir, 'node_modules'), packageName)
    if (resolvedPackageDir) return resolvedPackageDir

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) return undefined
    currentDir = parentDir
  }
}

export function resolvePackageSourceDir(
  packageName: string,
  sourceDirs: readonly string[] = sourceNodeModulesDirs,
  resolveFromDir?: string,
): string | undefined {
  if (resolveFromDir) {
    const resolvedFromParent = resolvePackageUpwards(resolveFromDir, packageName)
    if (resolvedFromParent) return resolvedFromParent
  }

  for (const sourceDir of sourceDirs) {
    const resolvedPackageDir = resolvePackageFromNodeModules(sourceDir, packageName)
    if (resolvedPackageDir) return resolvedPackageDir
  }

  return undefined
}

function listRuntimeDependencies(sourceDir: string): string[] {
  const manifest = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf-8')) as PackageManifest
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]
}

const copied = new Map<string, string>()

function copyPackage(
  packageName: string,
  targetNodeModulesDir: string,
  excludeFiles: readonly string[] = [],
  resolveFromDir?: string,
): void {
  const sourceDir = resolvePackageSourceDir(packageName, sourceNodeModulesDirs, resolveFromDir)
  if (!sourceDir) {
    throw new Error(`缺少 Pi 扩展运行时依赖: ${packageName}（请先 bun install）`)
  }
  if (copied.get(packageName) === sourceDir) return
  copied.set(packageName, sourceDir)

  const targetDir = getPackageDir(targetNodeModulesDir, packageName)
  mkdirSync(dirname(targetDir), { recursive: true })
  rmSync(targetDir, { recursive: true, force: true })
  cpSync(sourceDir, targetDir, {
    recursive: true,
    dereference: true,
    force: true,
    preserveTimestamps: true,
    filter: (sourcePath) => !excludeFiles.some((fileName) => sourcePath.endsWith(`/${fileName}`)),
  })

  for (const dependency of listRuntimeDependencies(sourceDir)) {
    copyPackage(dependency, targetNodeModulesDir, [], sourceDir)
  }
}

function main(): void {
  rmSync(targetRoot, { recursive: true, force: true })
  mkdirSync(targetNodeModules, { recursive: true })

  for (const packageName of DEFAULT_PI_EXTENSIONS) {
    // 仅扩展包自身排除营销素材，缩小打包体积；依赖闭包完整复制。
    copyPackage(packageName, targetNodeModules, ['pi-web-fetch-demo.mp4', 'banner.png'])
  }

  console.log(`[copy:pi-extensions] 已复制 ${copied.size} 个 Pi 扩展运行时包到 ${targetRoot}`)
}

if (import.meta.main) {
  main()
}
