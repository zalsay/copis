import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  PYTHON_RUNTIME_RELEASE_TAG,
  PYTHON_RUNTIME_VERSION,
  getPythonRuntimeAsset,
  packPythonRuntimeModule,
} from './prepare-python-runtime-module'

const temporaryDirectories: string[] = []

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
})

describe('Python runtime 功能模块准备', () => {
  test('Given 固定 Python release When 解析六个平台架构 Then 使用官方 install_only 归档和 SHA256', () => {
    expect(PYTHON_RUNTIME_RELEASE_TAG).toBe('20260814')
    expect(PYTHON_RUNTIME_VERSION).toBe('3.12.14')

    expect(getPythonRuntimeAsset('darwin', 'arm64')).toMatchObject({
      archiveName: 'cpython-3.12.14+20260814-aarch64-apple-darwin-install_only.tar.gz',
      sha256: '4572133a5542f306b9bdb155da5800f9e38950cd0a98d469b832ce256fe299ea',
    })
    expect(getPythonRuntimeAsset('darwin', 'x64')).toMatchObject({
      archiveName: 'cpython-3.12.14+20260814-x86_64-apple-darwin-install_only.tar.gz',
      sha256: '1a94c83264731e9603fbea78e57e7ca8f20e7d91eb866627ac2304621b0f6f1f',
    })
    expect(getPythonRuntimeAsset('linux', 'arm64')).toMatchObject({
      archiveName: 'cpython-3.12.14+20260814-aarch64-unknown-linux-gnu-install_only.tar.gz',
      sha256: '4952b18bafda1880d4ab1f86e1c348dbdb31f0e6d049e76dc5f052f2f796f1c5',
    })
    expect(getPythonRuntimeAsset('linux', 'x64')).toMatchObject({
      archiveName: 'cpython-3.12.14+20260814-x86_64-unknown-linux-gnu-install_only.tar.gz',
      sha256: '3297691ae34f75fed81ac424e040145fccb0bafe8e581cd5cadbddfa1c0766c0',
    })
    expect(getPythonRuntimeAsset('win32', 'arm64')).toMatchObject({
      archiveName: 'cpython-3.12.14+20260814-aarch64-pc-windows-msvc-install_only.tar.gz',
      sha256: '6a7e4b012dd74eeb674ca0591ad1e676fc8d37a650e71c7b2140c3c8ed632e30',
    })
    expect(getPythonRuntimeAsset('win32', 'x64')).toMatchObject({
      archiveName: 'cpython-3.12.14+20260814-x86_64-pc-windows-msvc-install_only.tar.gz',
      sha256: '7330282b47cd43a66b702d39078d2e5a88e580cee351d82f95045f21f5ee042a',
    })
  })

  test('Given python 根目录归档 When 整理 runtime Then 输出统一 bin/lib/include 布局', () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-python-runtime-module-'))
    temporaryDirectories.push(root)
    const sourceRoot = join(root, 'source', 'python')
    mkdirSync(join(sourceRoot, 'bin'), { recursive: true })
    mkdirSync(join(sourceRoot, 'lib', 'python3.12'), { recursive: true })
    mkdirSync(join(sourceRoot, 'include', 'python3.12'), { recursive: true })
    writeFileSync(join(sourceRoot, 'bin', 'python'), '#!/bin/sh\n', { mode: 0o755 })
    writeFileSync(join(sourceRoot, 'bin', 'python3.12'), '#!/bin/sh\n', { mode: 0o755 })
    writeFileSync(join(sourceRoot, 'lib', 'python3.12', 'site.py'), 'fixture\n')
    writeFileSync(join(sourceRoot, 'include', 'python3.12', 'Python.h'), 'fixture\n')

    const sourceArchive = join(root, 'source.tar.gz')
    execFileSync('tar', ['-czf', sourceArchive, '-C', join(root, 'source'), 'python'])
    const output = join(root, 'python-runtime.tar.gz')
    const sourceSha256 = createHash('sha256').update(readFileSync(sourceArchive)).digest('hex')

    const prepared = packPythonRuntimeModule({
      platform: 'darwin',
      arch: 'arm64',
      sourceArchive: readFileSync(sourceArchive),
      expectedSourceSha256: sourceSha256,
      output,
    })

    expect(prepared.version).toBe(PYTHON_RUNTIME_VERSION)
    expect(prepared.path).toBe(output)
    expect(prepared.size).toBe(readFileSync(output).byteLength)
    expect(prepared.sha256).toBe(createHash('sha256').update(readFileSync(output)).digest('hex'))

    const entries = execFileSync('tar', ['-tzf', output], { encoding: 'utf8' })
      .trim()
      .split(/\r?\n/)
      .map((entry) => entry.replace(/^\.\//, ''))
    expect(entries).toContain('bin/python')
    expect(entries).toContain('bin/python3.12')
    expect(entries).toContain('lib/python3.12/site.py')
    expect(entries).toContain('include/python3.12/Python.h')
    expect(entries.some((entry) => entry.startsWith('python/'))).toBe(false)
  })

  test('Given Windows 官方包入口位于 python/python.exe When 整理 runtime Then bin/python.exe 与 DLL/Lib 同目录可用', () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-python-runtime-win32-'))
    temporaryDirectories.push(root)
    const sourceRoot = join(root, 'source', 'python')
    mkdirSync(join(sourceRoot, 'Lib'), { recursive: true })
    mkdirSync(join(sourceRoot, 'DLLs'), { recursive: true })
    writeFileSync(join(sourceRoot, 'python.exe'), 'windows-python-executable\n')
    writeFileSync(join(sourceRoot, 'python312.dll'), 'python-runtime-dll\n')
    writeFileSync(join(sourceRoot, 'Lib', 'os.py'), 'fixture\n')
    writeFileSync(join(sourceRoot, 'DLLs', '_test.pyd'), 'fixture\n')

    const sourceArchive = join(root, 'source.tar.gz')
    execFileSync('tar', ['-czf', sourceArchive, '-C', join(root, 'source'), 'python'])
    const output = join(root, 'python-runtime.tar.gz')
    const sourceSha256 = createHash('sha256').update(readFileSync(sourceArchive)).digest('hex')

    const prepared = packPythonRuntimeModule({
      platform: 'win32',
      arch: 'x64',
      sourceArchive: readFileSync(sourceArchive),
      expectedSourceSha256: sourceSha256,
      output,
    })

    expect(prepared.version).toBe(PYTHON_RUNTIME_VERSION)
    const entries = execFileSync('tar', ['-tzf', output], { encoding: 'utf8' })
      .trim()
      .split(/\r?\n/)
      .map((entry) => entry.replace(/^\.\//, ''))
    expect(entries).toContain('bin/python.exe')
    expect(entries).toContain('bin/python312.dll')
    expect(entries).toContain('bin/Lib/os.py')
    expect(entries).toContain('bin/DLLs/_test.pyd')
    expect(entries).not.toContain('python.exe')
  })

  test('Given Unix 官方包包含 Python 入口 symlink When 整理 runtime Then 输出归档保留链接语义', () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-python-runtime-symlink-'))
    temporaryDirectories.push(root)
    const sourceRoot = join(root, 'source', 'python')
    mkdirSync(join(sourceRoot, 'bin'), { recursive: true })
    writeFileSync(join(sourceRoot, 'bin', 'python3.12'), 'python-runtime-binary\n', { mode: 0o755 })
    symlinkSync('python3.12', join(sourceRoot, 'bin', 'python'))

    const sourceArchive = join(root, 'source.tar.gz')
    execFileSync('tar', ['-czf', sourceArchive, '-C', join(root, 'source'), 'python'])
    const output = join(root, 'python-runtime.tar.gz')
    const sourceSha256 = createHash('sha256').update(readFileSync(sourceArchive)).digest('hex')

    packPythonRuntimeModule({
      platform: 'linux',
      arch: 'x64',
      sourceArchive: readFileSync(sourceArchive),
      expectedSourceSha256: sourceSha256,
      output,
    })

    const extracted = join(root, 'extracted')
    mkdirSync(extracted)
    execFileSync('tar', ['-xzf', output, '-C', extracted])
    expect(lstatSync(join(extracted, 'bin/python')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(extracted, 'bin/python'))).toBe('python3.12')
  })

  test('Given 官方归档摘要不匹配 When 整理 runtime Then 在写出前拒绝', () => {
    expect(() => packPythonRuntimeModule({
      platform: 'linux',
      arch: 'x64',
      sourceArchive: Buffer.from('not-an-archive'),
      expectedSourceSha256: '0'.repeat(64),
      output: join(tmpdir(), 'python-runtime-invalid.tar.gz'),
    })).toThrow('Python runtime 源归档 SHA256 校验失败')
  })
})
