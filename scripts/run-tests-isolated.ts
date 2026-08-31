#!/usr/bin/env bun

import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '..')
const testPatterns = [
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.test.js',
  '**/*.test.jsx',
  '**/*.test.mjs',
  '**/*.test.cjs',
]

async function scanTestFiles(pattern: string): Promise<string[]> {
  const files: string[] = []
  for await (const file of new Bun.Glob(pattern).scan({ cwd: repoRoot, onlyFiles: true })) {
    if (file.startsWith('node_modules/') || file.includes('/node_modules/') || file.includes('/dist/')) continue
    files.push(file)
  }
  return files
}

const testFiles = [...new Set((await Promise.all(testPatterns.map(scanTestFiles))).flat())].sort()
const bunTestArgs = process.argv.slice(2)
const failedFiles: string[] = []

for (const testFile of testFiles) {
  const child = Bun.spawn([process.execPath, 'test', testFile, ...bunTestArgs], {
    cwd: repoRoot,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await child.exited
  if (exitCode !== 0) failedFiles.push(testFile)
}

if (failedFiles.length > 0) {
  console.error(`\n[test] ${failedFiles.length} 个测试文件失败：`)
  for (const file of failedFiles) console.error(`- ${file}`)
  process.exit(1)
}

console.log(`[test] ${testFiles.length} 个测试文件全部通过（每个文件独立 Bun 进程）`)
