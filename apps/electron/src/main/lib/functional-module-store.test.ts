import { afterEach, describe, expect, test } from 'bun:test'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  activateFunctionalModule,
  assembleFunctionalModule,
  cacheFunctionalModule,
  getFunctionalModulePaths,
  getFunctionalModuleArchiveLimit,
  moduleCacheComplete,
  readActiveFunctionalModule,
  type FunctionalModulePackage,
} from './functional-module-store'

const tempRoots: string[] = []

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'copis-functional-module-'))
  tempRoots.push(root)
  return root
}

function officeCliPackage(sha256: string): FunctionalModulePackage {
  return {
    name: 'officecli',
    version: '1.0.143',
    sha256,
    size: Buffer.byteLength('officecli-binary'),
    format: 'binary',
    entrypoint: 'bin/officecli',
    required: true,
  }
}

function createTarGzWithRootDirectory(files: Record<string, string>): Buffer {
  const entries = [createTarDirectoryEntry('./')]
  for (const [path, content] of Object.entries(files)) {
    entries.push(createTarFileEntry(`./${path}`, content))
  }
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]))
}

function createTarGzWithSymlink(linkPath: string, linkTarget: string): Buffer {
  return gzipSync(Buffer.concat([
    createTarDirectoryEntry('./'),
    createTarFileEntry('./bin/python3.12', 'python-runtime-binary'),
    createTarSymlinkEntry(`./${linkPath}`, linkTarget),
    Buffer.alloc(1024),
  ]))
}

function createTarGzWithPaxMetadata(files: Record<string, string>): Buffer {
  const entries = [createTarPaxHeader('./PaxHeader/currentdir'), createTarDirectoryEntry('./')]
  for (const [path, content] of Object.entries(files)) {
    entries.push(createTarPaxHeader(`./PaxHeader/${path}`), createTarFileEntry(`./${path}`, content))
  }
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]))
}

function createTarDirectoryEntry(path: string): Buffer {
  const header = Buffer.alloc(512)
  header.write(path)
  header[156] = '5'.charCodeAt(0)
  return header
}

function createTarFileEntry(path: string, content: string): Buffer {
  const body = Buffer.from(content)
  const header = Buffer.alloc(512)
  header.write(path)
  header.write(`${body.byteLength.toString(8).padStart(11, '0')}\0`, 124)
  header[156] = '0'.charCodeAt(0)
  const padding = Buffer.alloc((512 - (body.byteLength % 512)) % 512)
  return Buffer.concat([header, body, padding])
}

function createTarSymlinkEntry(path: string, target: string): Buffer {
  const header = Buffer.alloc(512)
  header.write(path)
  header.write(target, 157)
  header[156] = '2'.charCodeAt(0)
  return header
}

function createTarPaxHeader(path: string): Buffer {
  const body = Buffer.from('30 mtime=1786365923.349214887\n')
  const header = Buffer.alloc(512)
  header.write(path)
  header.write(`${body.byteLength.toString(8).padStart(11, '0')}\0`, 124)
  header[156] = 'x'.charCodeAt(0)
  const padding = Buffer.alloc((512 - (body.byteLength % 512)) % 512)
  return Buffer.concat([header, body, padding])
}

describe('Copis 功能模块存储', () => {
  test('Given 已校验的模块源文件 When 写入模块缓存 Then 按名称和 sha256 复用完整缓存', async () => {
    const root = createRoot()
    const source = join(root, 'officecli-source')
    writeFileSync(source, 'officecli-binary')
    const paths = getFunctionalModulePaths(join(root, 'modules'))
    const packageInfo = officeCliPackage('a'.repeat(64))

    const payloadPath = await cacheFunctionalModule(paths, packageInfo, source)

    expect(moduleCacheComplete(paths, packageInfo)).toBe(true)
    expect(payloadPath).toBe(join(paths.cacheDir, 'officecli', packageInfo.sha256, 'payload', 'bin', 'officecli'))
    expect(await cacheFunctionalModule(paths, packageInfo, source)).toBe(payloadPath)
  })

  test('同时安装两个可选模块时两个入口都保持激活', async () => {
    const root = createRoot()
    const paths = getFunctionalModulePaths(root)
    const source = join(root, 'source')
    writeFileSync(source, 'officecli-binary')
    const modules = ['pi-worker', 'pi-web-extension'].map(name => ({
      ...officeCliPackage('b'.repeat(64)), name, required: false,
    }))
    const versions = await Promise.all(modules.map(async item => {
      await cacheFunctionalModule(paths, item, source)
      return assembleFunctionalModule(paths, item)
    }))
    await Promise.all(modules.map((item, index) => activateFunctionalModule(paths, item, versions[index]!)))
    for (const item of modules) expect(readActiveFunctionalModule(paths, item.name)?.name).toBe(item.name)
  })

  test('Given 完整模块缓存 When 组装并激活版本 Then active 记录只指向已完成的版本目录', async () => {
    const root = createRoot()
    const source = join(root, 'officecli-source')
    writeFileSync(source, 'officecli-binary')
    const paths = getFunctionalModulePaths(join(root, 'modules'))
    const packageInfo = officeCliPackage('b'.repeat(64))

    await cacheFunctionalModule(paths, packageInfo, source)
    const versionDir = await assembleFunctionalModule(paths, packageInfo)
    await activateFunctionalModule(paths, packageInfo, versionDir)

    const active = readActiveFunctionalModule(paths, packageInfo.name)
    expect(active).toMatchObject({
      name: 'officecli',
      version: '1.0.143',
      sha256: packageInfo.sha256,
    })
    expect(active?.path).toBe(join(versionDir, packageInfo.entrypoint))
  })

  test('Given 带 ./ 根目录条目的归档 When 组装 Then 在激活前报告递增的解压进度', async () => {
    const root = createRoot()
    const archive = createTarGzWithRootDirectory({
      'bin/node': 'node-runtime-binary',
      'bin/npm': 'npm-runtime-launcher',
    })
    const source = join(root, 'node-runtime.tar.gz')
    writeFileSync(source, archive)
    const paths = getFunctionalModulePaths(join(root, 'modules'))
    const packageInfo: FunctionalModulePackage = {
      name: 'node-runtime',
      version: '22.21.1',
      sha256: 'd'.repeat(64),
      size: archive.byteLength,
      format: 'tar.gz',
      entrypoint: 'bin/node',
      required: true,
    }

    await cacheFunctionalModule(paths, packageInfo, source)
    const progress: number[] = []
    const versionDir = await assembleFunctionalModule(paths, packageInfo, (fraction) => {
      expect(readActiveFunctionalModule(paths, 'node-runtime')).toBeUndefined()
      progress.push(fraction)
    })
    expect(progress[0]).toBeGreaterThan(0)
    expect(progress[0]).toBeLessThan(1)
    expect(progress).toEqual([...new Set(progress)].sort((left, right) => left - right))
    expect(progress.at(-1)).toBe(1)
    await activateFunctionalModule(paths, packageInfo, versionDir)

    expect(readActiveFunctionalModule(paths, 'node-runtime')?.path).toBe(join(versionDir, 'bin/node'))
  })

  test('Given 带 PAX 元数据头的 Node runtime 归档 When 组装 Then 正确激活入口文件', async () => {
    const root = createRoot()
    const archive = createTarGzWithPaxMetadata({
      'bin/node': 'node-runtime-binary',
      'bin/npm': 'npm-runtime-launcher',
    })
    const source = join(root, 'node-runtime-pax.tar.gz')
    writeFileSync(source, archive)
    const paths = getFunctionalModulePaths(join(root, 'modules'))
    const packageInfo: FunctionalModulePackage = {
      name: 'node-runtime',
      version: '22.21.1',
      sha256: 'e'.repeat(64),
      size: archive.byteLength,
      format: 'tar.gz',
      entrypoint: 'bin/node',
      required: true,
    }

    await cacheFunctionalModule(paths, packageInfo, source)
    const versionDir = await assembleFunctionalModule(paths, packageInfo)
    await activateFunctionalModule(paths, packageInfo, versionDir)

    expect(readActiveFunctionalModule(paths, 'node-runtime')?.path).toBe(join(versionDir, 'bin/node'))
  })

  test('跨多个数据块的文件完整落盘，缺少 gzip 尾部的归档不能完成组装', async () => {
    const root = createRoot()
    const paths = getFunctionalModulePaths(root)
    const content = 'copis-runtime\n'.repeat(70_000)
    const archive = createTarGzWithRootDirectory({ 'bin/dsh': content })
    const input = join(root, 'dsh.tar.gz')
    const valid: FunctionalModulePackage = {
      name: 'dsh', version: '0.2.2-rc.2', sha256: '8'.repeat(64),
      size: archive.length, format: 'tar.gz', entrypoint: 'bin/dsh', required: false,
    }
    writeFileSync(input, archive)
    await cacheFunctionalModule(paths, valid, input)
    const versionDir = await assembleFunctionalModule(paths, valid)
    expect(readFileSync(join(versionDir, 'bin/dsh'), 'utf8')).toBe(content)

    const truncated = archive.subarray(0, -8)
    const invalid = { ...valid, size: truncated.length, sha256: '9'.repeat(64) }
    writeFileSync(input, truncated)
    await cacheFunctionalModule(paths, invalid, input)
    const progress: number[] = []
    await expect(assembleFunctionalModule(paths, invalid, fraction => progress.push(fraction)))
      .rejects.toThrow('组装功能模块版本失败')
    expect(progress).not.toContain(1)
    expect(readdirSync(join(paths.versionsDir, 'dsh'))).toEqual([`${valid.version}-${valid.sha256}`])
  })

  test('Given Unix Python runtime 归档包含相对 symlink When 组装 Then 保留链接语义并激活入口', async () => {
    const root = createRoot()
    const archive = createTarGzWithSymlink('bin/python', 'python3.12')
    const source = join(root, 'python-runtime.tar.gz')
    writeFileSync(source, archive)
    const paths = getFunctionalModulePaths(join(root, 'modules'))
    const packageInfo: FunctionalModulePackage = {
      name: 'python-runtime',
      version: '3.12.14',
      sha256: 'f'.repeat(64),
      size: archive.byteLength,
      format: 'tar.gz',
      entrypoint: 'bin/python',
      required: true,
    }

    await cacheFunctionalModule(paths, packageInfo, source)
    const versionDir = await assembleFunctionalModule(paths, packageInfo)
    await activateFunctionalModule(paths, packageInfo, versionDir)

    expect(lstatSync(join(versionDir, 'bin/python')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(versionDir, 'bin/python'))).toBe('python3.12')
    expect(readActiveFunctionalModule(paths, 'python-runtime')?.path).toBe(join(versionDir, 'bin/python'))
  })

  test('Given Python runtime symlink 指向目标目录外 When 组装 Then 拒绝解包', async () => {
    const root = createRoot()
    const archive = createTarGzWithSymlink('bin/python', '../../outside')
    const source = join(root, 'python-runtime-unsafe.tar.gz')
    writeFileSync(source, archive)
    const paths = getFunctionalModulePaths(join(root, 'modules'))
    const packageInfo: FunctionalModulePackage = {
      name: 'python-runtime',
      version: '3.12.14',
      sha256: '0'.repeat(64),
      size: archive.byteLength,
      format: 'tar.gz',
      entrypoint: 'bin/python',
      required: true,
    }

    await cacheFunctionalModule(paths, packageInfo, source)

    await expect(assembleFunctionalModule(paths, packageInfo)).rejects.toThrow('符号链接目标超出目标目录')
  })

  test('Given 带目录穿越的入口路径 When 写入模块缓存 Then 拒绝不安全模块', async () => {
    const root = createRoot()
    const source = join(root, 'officecli-source')
    writeFileSync(source, 'officecli-binary')
    const paths = getFunctionalModulePaths(join(root, 'modules'))

    await expect(cacheFunctionalModule(
      paths,
      { ...officeCliPackage('c'.repeat(64)), entrypoint: '../outside' },
      source,
    )).rejects.toThrow('入口路径')
  })
})

test('Given 官方 DSH 归档增大 When 查询解包预算 Then 只允许 DSH 使用 1.5 GiB 且其他模块仍为 512 MiB', () => {
  expect(getFunctionalModuleArchiveLimit('dsh')).toBe(1536 * 1024 * 1024)
  expect(getFunctionalModuleArchiveLimit('python-runtime')).toBe(512 * 1024 * 1024)
  expect(getFunctionalModuleArchiveLimit('unrecognized')).toBe(512 * 1024 * 1024)
})
