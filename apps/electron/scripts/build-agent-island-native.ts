#!/usr/bin/env bun
/** Build the macOS-native Agent Island helper for the current host architecture. */

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(scriptDir, '..')
const source = resolve(appDir, 'native/agent-island/macos-agent-island-helper.swift')
const output = resolve(appDir, 'resources/agent-island/macos-agent-island-helper')
const allowFallback = process.argv.includes('--allow-fallback') || process.env.COPIS_AGENT_ISLAND_NATIVE_OPTIONAL === '1'

if (process.platform !== 'darwin') {
  console.log('[agent-island-native] skipped (macOS only)')
  process.exit(0)
}

if (!existsSync(source)) {
  if (!allowFallback) throw new Error(`Agent Island helper source not found: ${source}`)
  console.warn(`[agent-island-native] source unavailable, using Electron fallback: ${source}`)
  process.exit(0)
}

mkdirSync(dirname(output), { recursive: true })
rmSync(output, { force: true })
try {
  execFileSync('xcrun', ['swiftc', '-O', '-parse-as-library', source, '-o', output], { stdio: 'inherit' })
  chmodSync(output, 0o755)
  console.log(`[agent-island-native] built ${output}`)
} catch (error) {
  rmSync(output, { force: true })
  if (!allowFallback) throw error
  console.warn(`[agent-island-native] native helper build failed, using Electron fallback: ${error instanceof Error ? error.message : String(error)}`)
}
