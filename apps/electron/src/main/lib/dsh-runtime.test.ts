import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDshCommand, resolveDshNode } from './dsh-runtime'
import {
  activateFunctionalModule,
  getFunctionalModulePaths,
  type FunctionalModulePackage,
} from './functional-module-store'

const tempRoots: string[] = []

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

function createTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'copis-dsh-runtime-test-'))
  tempRoots.push(dir)
  return dir
}

describe('dsh-runtime', () => {
  test('未激活时返回 undefined', () => {
    const root = createTempRoot()
    expect(resolveDshCommand(root)).toBeUndefined()
    expect(resolveDshNode(root)).toBeUndefined()
  })

  test('激活 dsh 且入口存在时成功解析命令路径', () => {
    const root = createTempRoot()
    const paths = getFunctionalModulePaths(root)
    const versionDirName = 'dsh-0.1.2'
    const versionDir = join(paths.versionsDir, versionDirName)
    const binDir = join(versionDir, 'bin')
    mkdirSync(binDir, { recursive: true })

    const launcherName = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
    const launcherPath = join(binDir, launcherName)
    writeFileSync(launcherPath, '#!/bin/sh\necho dsh\n', 'utf8')
    chmodSync(launcherPath, 0o755)

    const packageInfo: FunctionalModulePackage = {
      name: 'dsh',
      version: '0.1.2',
      sha256: 'a'.repeat(64),
      size: 100,
      format: 'tar.gz',
      entrypoint: `bin/${launcherName}`,
      required: true,
    }

    writeFileSync(join(versionDir, '.complete'), '', 'utf8')
    writeFileSync(join(versionDir, 'module-lock.json'), JSON.stringify({ package: packageInfo }), 'utf8')

    mkdirSync(paths.rootDir, { recursive: true })
    writeFileSync(paths.activeFile, JSON.stringify({
      modules: {
        dsh: {
          ...packageInfo,
          versionDir: `versions/${versionDirName}`,
        },
      },
    }), 'utf8')

    const resolved = resolveDshCommand(root)
    expect(resolved).toBe(launcherPath)
  })

  test('激活 node-runtime 时成功解析 node 路径', () => {
    const root = createTempRoot()
    const paths = getFunctionalModulePaths(root)
    const versionDirName = 'node-runtime-20.18.0'
    const versionDir = join(paths.versionsDir, versionDirName)
    const binDir = join(versionDir, 'bin')
    mkdirSync(binDir, { recursive: true })

    const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
    const nodePath = join(binDir, nodeName)
    writeFileSync(nodePath, '#!/bin/sh\necho node\n', 'utf8')
    chmodSync(nodePath, 0o755)

    const packageInfo: FunctionalModulePackage = {
      name: 'node-runtime',
      version: '20.18.0',
      sha256: 'b'.repeat(64),
      size: 200,
      format: 'tar.gz',
      entrypoint: `bin/${nodeName}`,
      required: true,
    }

    writeFileSync(join(versionDir, '.complete'), '', 'utf8')
    writeFileSync(join(versionDir, 'module-lock.json'), JSON.stringify({ package: packageInfo }), 'utf8')

    mkdirSync(paths.rootDir, { recursive: true })
    writeFileSync(paths.activeFile, JSON.stringify({
      modules: {
        'node-runtime': {
          ...packageInfo,
          versionDir: `versions/${versionDirName}`,
        },
      },
    }), 'utf8')

    const resolved = resolveDshNode(root)
    expect(resolved).toBe(nodePath)
  })
})
