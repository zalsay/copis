#!/usr/bin/env bun
/**
 * 编译 copis CLI 与 Pi Worker 为同一个自包含二进制，打进桌面构建。
 *
 * 设计：
 * - 用 `bun build --compile` 把 CLI 和 Pi Worker 打成单个自包含可执行档。
 * - 普通参数进入 CLI；内部 `__pi-worker` 子命令启动 JSONL Worker。
 * - 复用一份 Bun runtime，避免 Electron 安装时解包完整 node_modules。
 * - 输出到 apps/electron/resources/bin/{platform}-{arch}/copis(.exe)，由
 *   electron-builder 经 extraResources 打进 process.resourcesPath/bin/，运行时
 *   由主进程按当前平台和架构选择并注入 COPIS_CLI。
 * - 本机架构编译：CI 每个 runner 即目标平台（mac arm64/x64、win x64、linux），
 *   各自产出宿主架构二进制，与 @anthropic-ai SDK native binary 的分发策略一致，
 *   无需交叉编译。
 *
 * 在 electron app 的 build 链中调用（见 package.json build:cli）。
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createCompiledRuntimeArgs, resolveCompiledRuntimeAssets } from './compiled-runtime-build'
import {
  resolveCompiledRuntimeBinaryName,
  resolveCompiledRuntimeDirectoryName,
  resolveCompiledRuntimeDirectoryNames,
} from '../src/main/lib/compiled-runtime-path'

const color = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
}

// apps/electron/scripts → repo 根
const electronDir = resolve(import.meta.dir, '..')
const repoRoot = resolve(electronDir, '../..')
const compiledRuntimeEntry = join(electronDir, 'scripts/compiled-runtime-entry.ts')
const photonWasmSource = join(repoRoot, 'node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm')

const isWindows = process.platform === 'win32'
const targetDirectoryName = resolveCompiledRuntimeDirectoryName(process.platform, process.arch)
const binName = resolveCompiledRuntimeBinaryName(process.platform)
const outDir = join(electronDir, 'resources/bin')
const targetDir = join(outDir, targetDirectoryName)
const outFile = join(targetDir, binName)
const legacyOutFile = join(outDir, binName)

function fail(msg: string): never {
  console.error(`${color.red}${color.bold}[build:cli] ${msg}${color.reset}`)
  process.exit(1)
}

if (!existsSync(compiledRuntimeEntry)) {
  fail(`找不到组合运行时入口: ${compiledRuntimeEntry}`)
}
if (!existsSync(photonWasmSource)) {
  fail(`找不到 Photon WASM: ${photonWasmSource}`)
}

mkdirSync(outDir, { recursive: true })
rmSync(legacyOutFile, { force: true })
rmSync(join(outDir, 'photon_rs_bg.wasm'), { force: true })
for (const directoryName of resolveCompiledRuntimeDirectoryNames()) {
  rmSync(join(outDir, directoryName), { recursive: true, force: true })
  const legacyBinaryName = directoryName.startsWith('win32-')
    ? `copis-${directoryName}.exe`
    : `copis-${directoryName}`
  rmSync(join(outDir, legacyBinaryName), { force: true })
}
mkdirSync(targetDir, { recursive: true })

console.log(`${color.cyan}[build:cli]${color.reset} 编译 copis CLI + Pi Worker → ${color.dim}${outFile}${color.reset}`)

// ── Windows 短路径 workaround ──
// bun build --compile 在 Windows 上尝试复制自身到临时目录时，
// 若 bun.exe 位于过长路径（如 ~/.bun/bin/bun.exe）会报 ENOENT。
// 解决：将 bun.exe 复制到短路径（os.tmpdir()）后通过
// --compile-executable-path 指向副本，编译后清理（try/finally 保证清理）。
let tempBunPath: string | undefined

if (isWindows) {
  const tmpDir = tmpdir()
  const bunName = `bun-temp-${Date.now()}-${process.pid}.exe`
  tempBunPath = join(tmpDir, bunName)

  try {
    copyFileSync(process.execPath, tempBunPath)
    console.log(`${color.dim}[build:cli] Windows 短路径 workaround: ${tempBunPath}${color.reset}`)
  } catch (err) {
    tempBunPath = undefined // copy 失败，无需清理
    console.warn(`${color.yellow}[build:cli] 无法复制 bun 到临时目录: ${err}，尝试直接编译${color.reset}`)
  }
}

const started = Date.now()
try {
  const compileArgs = createCompiledRuntimeArgs({
    entryFile: compiledRuntimeEntry,
    outFile,
    compileExecutablePath: tempBunPath,
  })
  const result = spawnSync(
    'bun',
    compileArgs,
    { cwd: join(repoRoot, 'apps/cli'), stdio: 'inherit' },
  )

  if (result.status !== 0) {
    fail(`bun build --compile 失败（exit ${result.status}）`)
  }
  if (!existsSync(outFile)) {
    fail(`编译完成但未产出二进制: ${outFile}`)
  }
  if (statSync(outFile).size < 1024 * 1024) {
    fail(`编译产物异常小，拒绝使用: ${outFile}`)
  }
  const smoke = spawnSync(outFile, ['--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (smoke.error || smoke.status !== 0) {
    fail(`编译产物无法执行 --help: ${smoke.error?.message ?? `exit ${smoke.status ?? 'unknown'}`}`)
  }
  const workerSmoke = spawnSync(outFile, ['__pi-worker'], {
    cwd: repoRoot,
    input: '{"type":"run","requestId":"__smoke__","config":{"sessionId":"__smoke__","query":{"sessionId":"__smoke__","useRustFileApi":true}}}\n',
    encoding: 'utf8',
    windowsHide: true,
  })
  if (workerSmoke.error || (workerSmoke.stderr && workerSmoke.stderr.includes('error:'))) {
    fail(`编译产物无法正常启动 __pi-worker: ${workerSmoke.error?.message ?? workerSmoke.stderr}`)
  }
  for (const asset of resolveCompiledRuntimeAssets({ photonWasmSource, outDir: targetDir })) {
    copyFileSync(asset.source, asset.destination)
  }
} finally {
  // 始终清理临时 bun 副本
  if (tempBunPath) {
    try {
      unlinkSync(tempBunPath)
    } catch {
      console.warn(`${color.yellow}[build:cli] 无法删除临时 bun 副本: ${tempBunPath}${color.reset}`)
    }
  }
}

const sizeMb = (statSync(outFile).size / 1024 / 1024).toFixed(0)
const elapsed = ((Date.now() - started) / 1000).toFixed(1)
console.log(
  `${color.green}${color.bold}[build:cli] ✓${color.reset} ${binName} (${sizeMb}MB, ${elapsed}s)`,
)
