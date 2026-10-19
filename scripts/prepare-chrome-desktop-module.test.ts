import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { prepareChromeDesktopModule, validateChromeDesktopArchive } from './prepare-chrome-desktop-module'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(options: { arch?: string; helperArch?: string; version?: string; helper?: boolean; platform?: string; targetArch?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'copis-chrome-module-'))
  roots.push(root)
  const name = `copis-chrome-0.1.2-darwin-${options.targetArch ?? 'arm64'}`
  const dir = join(root, name)
  mkdirSync(dir)
  const macho = (arch: string) => {
    const bytes = Buffer.alloc(32)
    bytes.writeUInt32LE(0xfeedfacf, 0)
    bytes.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4)
    return bytes
  }
  writeFileSync(join(dir, 'copis-chrome'), macho(options.arch ?? 'arm64'))
  chmodSync(join(dir, 'copis-chrome'), 0o755)
  if (options.helper !== false) {
    writeFileSync(join(dir, 'copis-chrome-helper'), macho(options.helperArch ?? 'arm64'))
    chmodSync(join(dir, 'copis-chrome-helper'), 0o755)
  }
  writeFileSync(join(dir, 'module.json'), JSON.stringify({ name: 'chrome-desktop-cli', version: options.version ?? '0.1.2', platform: options.platform ?? 'darwin', arch: options.arch ?? 'arm64', entrypoint: 'copis-chrome', helper: 'copis-chrome-helper', protocolVersion: 1, minimumOsVersion: '14.0' }))
  const archive = join(root, 'module.tar.gz')
  expect(spawnSync('tar', ['-czf', archive, '-C', root, name]).status).toBe(0)
  return { root, archive, name }
}

describe('Chrome 独立模块准备', () => {
  test('Given 完整独立归档 When 准备 Then 原样保留顶层目录和双二进制', () => {
    const { root, archive, name } = fixture()
    const output = join(root, 'resources', 'darwin-arm64.tar.gz')
    const result = prepareChromeDesktopModule({ platform: 'darwin', arch: 'arm64', version: '0.1.2', archive, output })
    expect(result.entrypoint).toBe(`${name}/copis-chrome`)
    expect(readFileSync(output)).toEqual(readFileSync(archive))
  })
  for (const options of [{ helper: false }, { helperArch: 'x64' }, { version: '0.2.0' }, { platform: 'linux' }, { arch: 'x64' }]) {
    test(`Given 不匹配或不完整归档 ${JSON.stringify(options)} When 校验 Then 拒绝`, () => {
      const { archive } = fixture(options)
      expect(() => validateChromeDesktopArchive(archive, 'darwin', 'arm64', '0.1.2')).toThrow()
    })
  }
  test('Given 已有 x64 双二进制归档 When 在其他架构机器准备 Then 仅校验复制而不交叉构建', () => {
    const { root, archive, name } = fixture({ targetArch: 'x64', arch: 'x64', helperArch: 'x64' })
    const result = prepareChromeDesktopModule({ platform: 'darwin', arch: 'x64', version: '0.1.2', archive, output: join(root, 'x64.tar.gz') })
    expect(result.entrypoint).toBe(`${name}/copis-chrome`)
  })
  test('Given 非 macOS 目标 When 准备 Then 在执行构建前明确拒绝', () => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(() => prepareChromeDesktopModule({ platform, arch: 'x64', version: '0.1.2' })).toThrow('仅支持 macOS')
    }
  })
  test('Given 无 archive 且目标不是本机架构 When 准备 Then 拒绝跨架构构建', () => {
    expect(() => prepareChromeDesktopModule({ platform: 'darwin', arch: process.arch === 'arm64' ? 'x64' : 'arm64', version: '0.1.2' })).toThrow('本机')
  })
})

const repoRoot = join(import.meta.dir, '..')
function localBun(args: string[], cwd = repoRoot, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['--no-env-file', ...args], { cwd, env: { PATH: process.env.PATH!, ...env }, encoding: 'utf8' })
}

describe('Chrome 本地 manifest 与部署集成', () => {
  test('Given 完整归档 When 实际执行 manifest CLI Then 发布独立 0.1.2 与原始顶层入口', () => {
    const { root, archive, name } = fixture()
    const output = join(root, 'manifest.json')
    const result = localBun(['scripts/build-functional-module-manifest.ts', '--chrome-desktop-cli', '--platform', 'darwin', '--arch', 'arm64', '--chrome-desktop-cli-archive', archive, '--chrome-desktop-cli-version', '0.1.2', '--version', '99.0.0', '--public-base-url', 'https://example.invalid', '--output', output])
    expect(result.status).toBe(0)
    const modules = JSON.parse(readFileSync(output, 'utf8')).platforms['darwin-arm64'].modules
    expect(Object.keys(modules)).toEqual(['chrome-desktop-cli'])
    expect(modules['chrome-desktop-cli']).toMatchObject({ version: '0.1.2', required: false, entrypoint: `${name}/copis-chrome`, format: 'tar.gz' })
  })
  test('Given 环境变量提供 Chrome-only When 执行 manifest CLI Then 正确识别 archive/version', () => {
    const { root, archive } = fixture()
    const output = join(root, 'manifest-env.json')
    const result = localBun(['scripts/build-functional-module-manifest.ts', '--output', output], repoRoot, { COPIS_CHROME_DESKTOP_CLI_ONLY: '1', COPIS_CHROME_DESKTOP_CLI_ARCHIVE: archive, COPIS_CHROME_DESKTOP_CLI_VERSION: '0.1.2', COPIS_MODULE_PLATFORM: 'darwin', COPIS_MODULE_ARCH: 'arm64', COS_PUBLIC_BASE_URL: 'https://example.invalid' })
    expect(result.status).toBe(0)
    expect(JSON.parse(readFileSync(output, 'utf8')).platforms['darwin-arm64'].modules['chrome-desktop-cli'].version).toBe('0.1.2')
  })
  test('Given 非 macOS Chrome-only When manifest/publish CLI 执行 Then 在读取 COS 配置前拒绝', () => {
    for (const script of ['build-functional-module-manifest.ts', 'publish-functional-modules.ts']) {
      const result = localBun([`scripts/${script}`, '--chrome-desktop-cli', '--platform', 'win32', '--arch', 'x64'])
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('仅支持 macOS')
      expect(result.stderr).not.toContain('缺少 COS_SECRET')
    }
  })
  test('Given 本地归档 When deploy Chrome-only 且 skip-publish Then 仅准备组件而不构建 Rust API/Swift', () => {
    const { root, archive } = fixture()
    mkdirSync(join(root, 'apps/electron'), { recursive: true })
    mkdirSync(join(root, 'scripts'))
    writeFileSync(join(root, 'deploy.sh'), readFileSync(join(repoRoot, 'deploy.sh')))
    writeFileSync(join(root, 'scripts/bump-electron-version.ts'), 'console.log("0.4.0")')
    writeFileSync(join(root, 'apps/electron/package.json'), '{}')
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { 'prepare:chrome-desktop-cli-module': `"${process.execPath}" --no-env-file "${join(repoRoot, 'scripts/prepare-chrome-desktop-module.ts')}"` } }))
    const result = spawnSync('bash', [join(root, 'deploy.sh'), '--skip-install', '--skip-publish', '--chrome-desktop-cli', '--platform', 'darwin', '--arch', 'arm64', '--chrome-desktop-cli-archive', archive], { cwd: root, env: { PATH: process.env.PATH!, BUN_INSTALL: join(root, 'no-bun') }, encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('prepare:chrome-desktop-cli-module')
    expect(result.stdout).not.toContain('构建 Rust HTTP API')
    expect(readFileSync(join(root, 'apps/electron/resources/chrome-desktop-cli/darwin-arm64.tar.gz'))).toEqual(readFileSync(archive))
  })
})

test('Given 非 Chrome 发布或非 macOS 全量发布 When 存在无关 Chrome 版本配置 Then 跳过 Chrome 校验', () => {
  const { root, archive } = fixture()
  const rust = join(root, 'rust')
  writeFileSync(rust, 'Rust binary fixture')
  const result = localBun(['scripts/build-functional-module-manifest.ts', '--rust', '--platform', 'win32', '--arch', 'x64', '--rust-binary', rust, '--chrome-desktop-cli-version', '9.9.9', '--chrome-desktop-cli-archive', archive, '--public-base-url', 'https://example.invalid', '--output', join(root, 'rust-manifest.json')])
  expect(result.status).toBe(0)
})

describe('Chrome CLI 短参数端到端入口', () => {
  test('Given --chrome-cli和短archive/version When 生成manifest Then 仍使用独立版本与顶层入口', () => {
    const { root, archive, name } = fixture()
    const output = join(root,'chrome-cli-manifest.json')
    const result = localBun(['scripts/build-functional-module-manifest.ts','--chrome-cli','--platform','darwin','--arch','arm64','--chrome-cli-archive',archive,'--chrome-cli-version','0.1.2','--public-base-url','https://example.invalid','--output',output])
    expect(result.status).toBe(0)
    const modules=JSON.parse(readFileSync(output,'utf8')).platforms['darwin-arm64'].modules
    expect(Object.keys(modules)).toEqual(['chrome-desktop-cli'])
    expect(modules['chrome-desktop-cli']).toMatchObject({version:'0.1.2',entrypoint:`${name}/copis-chrome`,required:false})
  })
  test('Given 非macOS短Chrome-only When manifest/publish Then 在读取COS配置前拒绝', () => {
    for(const script of ['build-functional-module-manifest.ts','publish-functional-modules.ts']) {
      const result=localBun([`scripts/${script}`,'--chrome-cli','--platform','linux','--arch','x64'])
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('仅支持 macOS')
      expect(result.stderr).not.toContain('缺少 COS_SECRET')
    }
  })
  test('Given Chrome短参数和其他单模块开关 When manifest/publish Then 不混合发布', () => {
    for(const script of ['build-functional-module-manifest.ts','publish-functional-modules.ts']) {
      const result=localBun([`scripts/${script}`,'--chrome-cli','--rust','--platform','darwin','--arch','arm64'])
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('不能同时使用')
    }
  })
})
