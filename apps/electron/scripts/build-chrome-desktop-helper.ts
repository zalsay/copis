#!/usr/bin/env bun
/**
 * 编译 macOS Chrome Desktop Helper 原生二进制。
 * 
 * 仅在 macOS (darwin) 下编译：
 * - 源码：apps/electron/native/chrome-desktop-helper/main.swift
 * - 产物：apps/electron/resources/bin/{platform}-{arch}/chrome-desktop-helper
 * 
 * 非 macOS 环境自动跳过。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const electronDir = resolve(import.meta.dir, '..')
const platform = process.platform
const arch = process.arch

if (platform !== 'darwin') {
  console.log(`[build:chrome-desktop-helper] 当前平台 (${platform}) 非 macOS，跳过编译`)
  process.exit(0)
}

const sourceFile = join(electronDir, 'native/chrome-desktop-helper/main.swift')
if (!existsSync(sourceFile)) {
  console.error(`[build:chrome-desktop-helper] 源码文件不存在: ${sourceFile}`)
  process.exit(1)
}

const targetDirName = `${platform}-${arch}`
const outDir = join(electronDir, 'resources/bin', targetDirName)
mkdirSync(outDir, { recursive: true })

const outFile = join(outDir, 'chrome-desktop-helper')
const targetTriple = arch === 'arm64' ? 'arm64-apple-macosx12.0' : 'x86_64-apple-macosx12.0'

console.log(`[build:chrome-desktop-helper] 开始编译 Swift helper: ${targetTriple} -> ${outFile}`)

const result = spawnSync('swiftc', [
  '-O',
  '-target', targetTriple,
  '-o', outFile,
  sourceFile,
], {
  stdio: 'inherit',
})

if (result.status !== 0) {
  console.error(`[build:chrome-desktop-helper] 编译失败，退出码: ${result.status}`)
  process.exit(result.status ?? 1)
}

console.log(`[build:chrome-desktop-helper] 编译成功: ${outFile}`)
