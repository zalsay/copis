#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'
import type { FunctionalModuleArchitecture, FunctionalModulePlatform } from '@copis/shared'
import { patchDshComposerHistoryRuntime } from '../apps/electron/src/main/lib/dsh-composer-history-patch'
import { patchDshHeroLogoRuntime } from '../apps/electron/src/main/lib/dsh-hero-logo-patch'
import {
  patchDshDetailsPanelFilePreviewRuntime,
  patchDshDetailsPanelFilePreviewSource,
} from '../apps/electron/src/main/lib/dsh-details-panel-patch'
import { patchDshSidebarRuntime, patchDshSidebarSource } from '../apps/electron/src/main/lib/dsh-sidebar-patch'

export {
  patchDshDetailsPanelFilePreviewRuntime,
  patchDshDetailsPanelFilePreviewSource,
  patchDshSidebarRuntime,
  patchDshSidebarSource,
}

export const DSH_PACKAGE = '@deepseek-ai/dsh'
export const DSH_PACKAGE_VERSION = '0.1.2-rc.1'
export const DSH_VERSION = '0.1.3'
export const DSH_INTEGRITY = 'sha512-RPq48TzxvwpdT9/7W1tbhZDBMmeK+bxDrX9cqQC27Wx/LqtgJF8PSa3b3xriU8oxtvhwYmk21w2cej3uMQrnVA=='
export const DSH_ENTRYPOINT = 'bin/dsh'
const DSH_RUNTIME_ENTRYPOINT = 'node_modules/@deepseek-ai/dsh/lib/bin.js'
const DSH_MODEL_SELECTION_CLIENT_ENTRYPOINT = 'node_modules/@deepseek-ai/dsh-client-ui-model-selection/lib/client.js'
export const DSH_CHAT_CLIENT_ENTRYPOINT = 'node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js'
export const DSH_CORDIS_CLIENT_ENTRYPOINT = 'node_modules/@deepseek-ai/dsh-client-ui-cordis/lib/client.js'

const DSH_MODEL_SELECT_MODEL_LABEL_PATTERN = /^([\t ]*)const modelLabel = waiting \? t\("trigger\.loading"\) : currentChoice\?\.model\.name \?\? \(state\.current === null \? t\("trigger\.fallback"\) : `\$\{state\.current\.provider\}\/\$\{state\.current\.model\}`\);$/gm
const DSH_MODEL_SELECT_TRIGGER_LABEL_PATTERN = /^([\t ]*)const triggerLabel = effortLabel === void 0 \? modelLabel : `\$\{modelLabel\} · \$\{effortLabel\}`;$/gm
const DSH_MODEL_SELECT_TRIGGER_MODEL_LABEL = `const triggerModelLabel = currentChoice === void 0 ? modelLabel : \`${'${currentChoice.group.name} · ${currentChoice.model.name.replace(/\\s*[（(][^（）()]*[）)]\\s*$/u, "")}'}\`;`
const DSH_MODEL_SELECT_TRIGGER_LABEL_REPLACEMENT = 'const triggerLabel = triggerModelLabel;'

const DSH_MODEL_SELECT_TRIGGER_CHILD_PATTERN = /(className: ModelSelect_module_css_default\.triggerLabel,\s+children:\s*)(?:modelLabel|triggerModelLabel)/g
const DSH_MODEL_SELECT_TRIGGER_EFFORT_PATTERN = /\s*effortLabel !== void 0 && \(0, react_jsx_runtime\.jsx\)\("span", \{\s*className: ModelSelect_module_css_default\.triggerEffort,\s*children: effortLabel\s*\}\),/g

interface PreparedDshModuleMetadata {
  version: string
  packageVersion: string
  package: string
  path: string
}

interface NpmInvocation {
  command: string
  args: string[]
}

if (import.meta.main) main()

export function main(): void {
  const platform = parsePlatform(option('--platform') ?? process.platform)
  const arch = parseArchitecture(option('--arch') ?? process.arch)
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error('dsh 运行环境只能在当前本机平台和架构准备')
  }

  const output = resolve(option('--output') ?? `apps/electron/resources/dsh/${platform}-${arch}.tar.gz`)
  const metadataOutput = option('--metadata')
  const staging = mkdtempSync(join(tmpdir(), 'copis-dsh-module-'))
  try {
    const moduleRoot = join(staging, 'module')
    const runtimeRoot = join(moduleRoot, 'runtime')
    installOfficialCli(runtimeRoot, join(staging, 'package-cache'))
    patchDshComposerModelSelectionRuntime(runtimeRoot)
    patchDshDetailsPanelFilePreviewRuntime(runtimeRoot)
    patchDshCordisPanelRuntime(runtimeRoot)
    patchDshSidebarRuntime(runtimeRoot)
    patchDshHeroLogoRuntime(
      runtimeRoot,
      resolve('apps/electron/resources/copis-logos/main-logo-metal-light.svg'),
    )
    if (!patchDshComposerHistoryRuntime(runtimeRoot)) throw new Error('官方 dsh 缺少 Composer 输入组件')
    if (!isFile(join(runtimeRoot, DSH_RUNTIME_ENTRYPOINT))) {
      throw new Error(`官方 dsh 缺少入口文件: ${DSH_RUNTIME_ENTRYPOINT}`)
    }
    writeLaunchers(moduleRoot, platform)
    normalizeTimestamps(moduleRoot)
    createArchive(moduleRoot, output)

    if (metadataOutput) {
      const metadata: PreparedDshModuleMetadata = {
        version: DSH_VERSION,
        packageVersion: DSH_PACKAGE_VERSION,
        package: DSH_PACKAGE,
        path: output,
      }
      const path = resolve(metadataOutput)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
    }
    console.log(`[prepare:dsh-module] 已生成 ${output}（dsh v${DSH_VERSION}，官方包 v${DSH_PACKAGE_VERSION}）`)
  } finally {
    rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

/**
 * Composer 的模型触发器需要与菜单区分展示：菜单保留完整说明，触发器仅展示 Provider 与基础模型名。
 * 该补丁锚定在固定的官方 DSH 版本；上游构建结构变化时直接失败，避免静默产出错误模块。
 */
export function patchDshComposerModelSelectionRuntime(runtimeRoot: string): void {
  const entrypoint = join(runtimeRoot, DSH_MODEL_SELECTION_CLIENT_ENTRYPOINT)
  if (!isFile(entrypoint)) {
    throw new Error(`官方 dsh 缺少 Composer 模型选择组件: ${entrypoint}`)
  }
  const source = readFileSync(entrypoint, 'utf8')
  writeFileSync(entrypoint, patchDshComposerModelSelectionSource(source), 'utf8')
}

/** 导出纯文本变换，供构建期测试验证官方 bundle 的结构锚点。 */
export function patchDshComposerModelSelectionSource(source: string): string {
  const triggerChildMatches = source.match(DSH_MODEL_SELECT_TRIGGER_CHILD_PATTERN)
  const triggerEffortMatches = source.match(DSH_MODEL_SELECT_TRIGGER_EFFORT_PATTERN)
  const originalModelLabelMatches = source.match(DSH_MODEL_SELECT_MODEL_LABEL_PATTERN)
  const originalTriggerLabelMatches = source.match(DSH_MODEL_SELECT_TRIGGER_LABEL_PATTERN)
  const isPatched = source.includes(DSH_MODEL_SELECT_TRIGGER_MODEL_LABEL)
  if (
    originalModelLabelMatches?.length !== 1
    || (isPatched ? originalTriggerLabelMatches !== null : originalTriggerLabelMatches?.length !== 1)
    || triggerChildMatches?.length !== 1
    || (triggerEffortMatches !== null && triggerEffortMatches.length !== 1)
  ) {
    throw new Error('DSH Composer 模型选择组件结构与受支持版本不匹配')
  }
  const withLabels = isPatched
    ? source
    : source
      .replace(DSH_MODEL_SELECT_MODEL_LABEL_PATTERN, (line, indent: string) => `${line}\n${indent}${DSH_MODEL_SELECT_TRIGGER_MODEL_LABEL}`)
      .replace(DSH_MODEL_SELECT_TRIGGER_LABEL_PATTERN, (_line, indent: string) => `${indent}${DSH_MODEL_SELECT_TRIGGER_LABEL_REPLACEMENT}`)
  return withLabels
    .replace(DSH_MODEL_SELECT_TRIGGER_CHILD_PATTERN, '$1triggerModelLabel')
    .replace(DSH_MODEL_SELECT_TRIGGER_EFFORT_PATTERN, '')
}

export function patchDshCordisPanelRuntime(runtimeRoot: string): void {
  const entrypoint = join(runtimeRoot, DSH_CORDIS_CLIENT_ENTRYPOINT)
  if (!isFile(entrypoint)) {
    throw new Error(`官方 dsh 缺少 Cordis Panel 组件: ${entrypoint}`)
  }
  const source = readFileSync(entrypoint, 'utf8')
  writeFileSync(entrypoint, patchDshCordisPanelSource(source), 'utf8')
}

export function patchDshCordisPanelSource(source: string): string {
  if (source.includes('"panel.title": "Copis 请您确认"')) {
    return source
  }

  const targetTitle = '"panel.title": "Cordis 插件"'
  const replTitle = '"panel.title": "Copis 请您确认"'
  const targetAria = '"panel.plugins.aria": "Cordis 插件"'
  const replAria = '"panel.plugins.aria": "Copis 请您确认"'

  if (!source.includes(targetTitle)) {
    throw new Error('DSH Cordis Panel 组件未找到 panel.title 结构')
  }

  let res = source.replace(targetTitle, replTitle)
  if (res.includes(targetAria)) {
    res = res.replace(targetAria, replAria)
  }
  return res
}


function installOfficialCli(runtimeRoot: string, packageCache: string): void {
  mkdirSync(runtimeRoot, { recursive: true })
  mkdirSync(packageCache, { recursive: true })
  const npm = resolveNpmInvocation()
  const packageTarball = downloadOfficialPackage(npm, packageCache)
  verifyOfficialPackage(packageTarball)
  execFileSync(npm.command, [...npm.args,
    'install',
    '--ignore-scripts',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    '--no-save',
    packageTarball,
  ], { cwd: runtimeRoot, stdio: 'inherit' })
}

function downloadOfficialPackage(npm: NpmInvocation, packageCache: string): string {
  const output = execFileSync(npm.command, [...npm.args,
    'pack',
    '--silent',
    `${DSH_PACKAGE}@${DSH_PACKAGE_VERSION}`,
  ], { cwd: packageCache, encoding: 'utf8' }).trim()
  const packageName = output.split(/\r?\n/).at(-1)?.trim()
  if (!packageName) throw new Error('下载官方 dsh 失败')
  const packageTarball = join(packageCache, packageName)
  if (!isFile(packageTarball)) throw new Error('官方 dsh 归档不存在')
  return packageTarball
}

function verifyOfficialPackage(packageTarball: string): void {
  const actualIntegrity = `sha512-${createHash('sha512').update(readFileSync(packageTarball)).digest('base64')}`
  if (actualIntegrity !== DSH_INTEGRITY) {
    throw new Error('官方 dsh 完整性校验失败')
  }
}

function writeLaunchers(moduleRoot: string, platform: FunctionalModulePlatform): void {
  const bin = join(moduleRoot, 'bin')
  mkdirSync(bin, { recursive: true })
  if (platform === 'win32') {
    writeFileSync(
      join(bin, 'dsh.cmd'),
      '@echo off\r\nset "NODE_BIN=%COPIS_DSH_NODE%"\r\nif "%NODE_BIN%"=="" set "NODE_BIN=%COPIS_NODE%"\r\nif "%NODE_BIN%"=="" where node >nul 2>nul && set "NODE_BIN=node"\r\nif "%NODE_BIN%"=="" (echo 未配置 Copis Node.js runtime >&2 & exit /b 1)\r\n"%NODE_BIN%" "%~dp0..\\runtime\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n',
      'utf8',
    )
    return
  }

  const launcher = join(bin, 'dsh')
  writeFileSync(
    launcher,
    '#!/bin/sh\nNODE_BIN="${COPIS_DSH_NODE:-${COPIS_NODE:-}}"\nif [ -z "$NODE_BIN" ]; then\n  if command -v node >/dev/null 2>&1; then\n    NODE_BIN="node"\n  else\n    echo "未配置 Copis Node.js runtime" >&2\n    exit 1\n  fi\nfi\nSCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$NODE_BIN" "$SCRIPT_DIR/../runtime/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"\n',
    { encoding: 'utf8', mode: 0o755 },
  )
  chmodSync(launcher, 0o755)
}

function createArchive(moduleRoot: string, output: string): void {
  const archiveTar = join(dirname(moduleRoot), 'dsh.tar')
  const temporaryOutput = `${output}.${process.pid}.tmp`
  mkdirSync(dirname(output), { recursive: true })
  try {
    execFileSync('tar', ['--format=pax', '-cf', archiveTar, '-C', moduleRoot, '.'], {
      stdio: 'inherit',
      env: { ...process.env, LC_ALL: 'C' },
    })
    writeFileSync(temporaryOutput, gzipSync(readFileSync(archiveTar), { mtime: 0 }), { mode: 0o644 })
    renameSync(temporaryOutput, output)
  } finally {
    if (existsSync(temporaryOutput)) rmSync(temporaryOutput, { force: true })
  }
}

function normalizeTimestamps(path: string): void {
  for (const entry of readdirSync(path).sort()) {
    const entryPath = join(path, entry)
    if (statSync(entryPath).isDirectory()) normalizeTimestamps(entryPath)
    utimesSync(entryPath, new Date(0), new Date(0))
  }
  utimesSync(path, new Date(0), new Date(0))
}

export function resolveNpmInvocation(
  nodePath = execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim(),
  platform: NodeJS.Platform = process.platform,
): NpmInvocation {
  const npmPath = platform === 'win32' ? join(dirname(nodePath), 'npm.cmd') : join(dirname(nodePath), 'npm')
  if (!isFile(npmPath)) throw new Error('未找到与 Node.js 配套的 npm')
  if (platform !== 'win32') return { command: npmPath, args: [] }

  const npmCli = [
    join(dirname(nodePath), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(nodePath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ].find(isFile)
  if (!npmCli) throw new Error('未找到 npm CLI 入口')
  return { command: nodePath, args: [npmCli] }
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile()
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value?.trim() || undefined
}

function parsePlatform(value: string): FunctionalModulePlatform {
  if (value === 'darwin' || value === 'linux' || value === 'win32') return value
  throw new Error(`当前平台不支持 dsh 模块: ${value}`)
}

function parseArchitecture(value: string): FunctionalModuleArchitecture {
  if (value === 'arm64' || value === 'x64') return value
  throw new Error(`当前架构不支持 dsh 模块: ${value}`)
}
