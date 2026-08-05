#!/usr/bin/env bun
/**
 * 编译 Rust HTTP API 服务。
 *
 * CI 在各目标平台 runner 上执行，因此产物与当前 runner 的平台和架构一致，
 * 不依赖交叉编译工具链。
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

const electronDir = resolve(import.meta.dir, '..')
const repoRoot = resolve(electronDir, '../..')
const manifestPath = join(repoRoot, 'native/http-api-server/Cargo.toml')
const targetDir = join(repoRoot, 'native/http-api-server/target/release')
const outputDir = join(electronDir, 'resources/bin')
const binaryName = process.platform === 'win32' ? 'copis-http-api-server.exe' : 'copis-http-api-server'
const sourcePath = join(targetDir, binaryName)
const outputPath = join(outputDir, binaryName)
function resolveCargoCommand(): string {
  const configured = process.env.CARGO?.trim()
  if (configured) return configured

  // 某些 Electron/Bun 启动环境不会继承 shell 的 ~/.cargo/bin，但 rustup
  // 仍会把 cargo 放在那里；优先使用绝对路径，避免开发启动时误报缺少 Rust。
  const userCargo = join(homedir(), '.cargo/bin/cargo')
  return existsSync(userCargo) ? userCargo : 'cargo'
}

const cargoCommand = resolveCargoCommand()

if (!existsSync(manifestPath)) {
  console.error(`[build:http-api-server] 找不到 Cargo manifest: ${manifestPath}`)
  process.exit(1)
}

console.log(`[build:http-api-server] 编译 Rust HTTP API 服务 → ${sourcePath}`)
const result = spawnSync(
  cargoCommand,
  ['build', '--release', '--manifest-path', manifestPath],
  { cwd: repoRoot, stdio: 'inherit' },
)

if (result.error) {
  console.error(`[build:http-api-server] 无法执行 Cargo: ${result.error.message}`)
  process.exit(1)
}
if (result.status !== 0) {
  console.error(`[build:http-api-server] Cargo 编译失败（exit ${result.status ?? 'unknown'}）`)
  process.exit(1)
}
if (!existsSync(sourcePath)) {
  console.error(`[build:http-api-server] 编译完成但没有找到产物: ${sourcePath}`)
  process.exit(1)
}

if (process.platform !== 'win32') chmodSync(sourcePath, 0o755)

if (process.env.COPIS_BUILD_BUNDLED_HTTP_API === '1') {
  mkdirSync(outputDir, { recursive: true })
  copyFileSync(sourcePath, outputPath)
  if (process.platform !== 'win32') chmodSync(outputPath, 0o755)
  console.log(`[build:http-api-server] 已按显式配置复制兼容产物: ${outputPath}`)
} else {
  console.log('[build:http-api-server] 默认不复制到 resources/bin，正式 App 从功能模块 active 版本启动')
}
