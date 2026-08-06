import { describe, expect, test } from 'bun:test'
import {
  resolveBundledCliPath,
  resolveCompiledRuntimeBinaryName,
  resolveCompiledRuntimeDirectoryName,
} from './compiled-runtime-path'

describe('Copis 自包含运行时平台路径', () => {
  test('Windows x64 使用带平台架构的 exe', () => {
    expect(resolveCompiledRuntimeDirectoryName('win32', 'x64')).toBe('win32-x64')
    expect(resolveCompiledRuntimeBinaryName('win32')).toBe('copis.exe')
  })

  test('macOS ARM 与 Intel 使用不同的二进制名称', () => {
    expect(resolveCompiledRuntimeDirectoryName('darwin', 'arm64')).toBe('darwin-arm64')
    expect(resolveCompiledRuntimeDirectoryName('darwin', 'x64')).toBe('darwin-x64')
    expect(resolveCompiledRuntimeBinaryName('darwin')).toBe('copis')
  })

  test('启动时优先选择当前平台架构，旧包回退到无后缀名称', () => {
    const resourcesPath = '/Applications/Copis.app/Contents/Resources'
    expect(resolveBundledCliPath({
      resourcesPath,
      platform: 'darwin',
      arch: 'arm64',
      exists: (path) => path.endsWith('/bin/darwin-arm64/copis'),
    })).toBe(`${resourcesPath}/bin/darwin-arm64/copis`)

    expect(resolveBundledCliPath({
      resourcesPath,
      platform: 'darwin',
      arch: 'x64',
      exists: (path) => path.endsWith('/bin/copis'),
    })).toBe(`${resourcesPath}/bin/copis`)
  })
})
