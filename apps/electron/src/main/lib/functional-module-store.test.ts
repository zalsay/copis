import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activateFunctionalModule,
  assembleFunctionalModule,
  cacheFunctionalModule,
  getFunctionalModulePaths,
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
    required: false,
  }
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
