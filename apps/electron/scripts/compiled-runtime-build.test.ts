import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  COPIS_PI_WORKER_SUBCOMMAND,
  createCompiledRuntimeArgs,
  resolveCompiledRuntimeAssets,
  resolveCompiledRuntimeMode,
} from './compiled-runtime-build'

describe('Copis 自包含运行时构建', () => {
  test('Given Windows 构建 When 生成 Bun 编译参数 Then 使用组合入口和短路径 Bun', () => {
    expect(createCompiledRuntimeArgs({
      entryFile: 'C:\\copis\\apps\\electron\\scripts\\compiled-runtime-entry.ts',
      outFile: 'C:\\copis\\apps\\electron\\resources\\bin\\win32-x64\\copis.exe',
      compileExecutablePath: 'C:\\Temp\\bun-temp.exe',
    })).toEqual([
      'build',
      '--compile',
      '--compile-executable-path',
      'C:\\Temp\\bun-temp.exe',
      '--outfile',
      'C:\\copis\\apps\\electron\\resources\\bin\\win32-x64\\copis.exe',
      'C:\\copis\\apps\\electron\\scripts\\compiled-runtime-entry.ts',
    ])
  })

  test('Given 内部 Worker 子命令 When 解析运行模式 Then 进入 Pi Worker', () => {
    expect(resolveCompiledRuntimeMode([
      'C:\\copis\\copis.exe',
      'C:\\copis\\compiled-runtime-entry.ts',
      COPIS_PI_WORKER_SUBCOMMAND,
    ])).toBe('pi-worker')
    expect(resolveCompiledRuntimeMode([
      'C:\\copis\\copis.exe',
      'C:\\copis\\compiled-runtime-entry.ts',
      'session',
      'list',
    ])).toBe('cli')
  })

  test('Given Pi 图片处理依赖 When 收集组合运行时资源 Then 将 Photon WASM 放到二进制旁', () => {
    expect(resolveCompiledRuntimeAssets({
      photonWasmSource: '/repo/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm',
      outDir: '/repo/apps/electron/resources/bin/darwin-arm64',
    })).toEqual([{
      source: '/repo/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm',
      destination: '/repo/apps/electron/resources/bin/darwin-arm64/photon_rs_bg.wasm',
    }])
  })

  test('Given Electron 打包配置 When 检查 ASAR 契约 Then 不解包完整 node_modules 或 JS Worker', () => {
    const config = readFileSync(join(import.meta.dir, '..', 'electron-builder.yml'), 'utf8')
    const asarSection = config.slice(
      config.indexOf('asarUnpack:'),
      config.indexOf('# 跳过 npm install'),
    )

    expect(asarSection).not.toContain('- "node_modules/**/*"')
    expect(asarSection).not.toContain('- "dist/pi-rpc-worker.cjs"')
    expect(config).toContain('- "!dist/pi-rpc-worker.cjs"')
    expect(config).toContain('- "!node_modules/**/*.map"')
    expect(config).toContain('- "!node_modules/**/*.d.ts"')
  })
})
