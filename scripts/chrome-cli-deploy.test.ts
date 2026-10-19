import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = join(import.meta.dir, '..')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const fixtureBun = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
const log = (phase, detail = {}) => fs.appendFileSync(process.env.FIXTURE_COMMAND_LOG, JSON.stringify({phase,args,...detail})+'\\n');
const get = name => args.includes(name) ? args[args.indexOf(name)+1] : undefined;
const saveManifest = file => { fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,JSON.stringify({platforms:{'darwin-arm64':{modules:{'chrome-desktop-cli':{version:'0.1.0'}}}}})); };
if (args[0].endsWith('bump-electron-version.ts')) { log('app-version-read'); console.log('0.0.98'); }
else if (args[0] === '-e') { log('summary'); console.log('chrome-desktop-cli=0.1.0'); }
else if (args[0] === 'install') { log('install'); }
else if (args[0] === 'run' && args[1] === 'prepare:chrome-desktop-cli-module') {
  const archive = get('--archive'); log(archive ? 'validate-archive' : 'build-source');
  if (process.env.FIXTURE_FAIL_PHASE === 'build') process.exit(9);
  const out = get('--output'); fs.mkdirSync(path.dirname(out),{recursive:true});
  fs.writeFileSync(out, archive ? fs.readFileSync(archive) : 'fresh-rust-swift-build');
}
else if (args[0] === 'run' && args[1] === 'build:functional-module-manifest') { log('manifest'); saveManifest(get('--output')); }
else if (args[0] === 'run' && args[1] === 'publish:functional-modules') {
  log('upload'); if (process.env.FIXTURE_FAIL_PHASE === 'upload') process.exit(10);
  saveManifest(get('--manifest-output'));
}
else { log('unexpected'); console.error('unexpected fixture command'); process.exit(90); }
`
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'copis-chrome-deploy-'))
  roots.push(root)
  const bin = join(root, 'fixture-bun/bin')
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(root, 'apps/electron/resources/chrome-desktop-cli'), { recursive: true })
  copyFileSync(join(repoRoot, 'deploy.sh'), join(root, 'deploy.sh'))
  writeFileSync(join(root, 'package.json'), '{}')
  writeFileSync(join(root, 'apps/electron/package.json'), '{}')
  const bun = join(bin, 'bun'); writeFileSync(bun, fixtureBun); chmodSync(bun, 0o755)
  const log = join(root, 'commands.jsonl')
  const output = join(root, 'apps/electron/resources/chrome-desktop-cli/darwin-arm64.tar.gz')
  writeFileSync(output, 'stale-existing-archive')
  function run(args: string[], extraEnv: Record<string,string> = {}) {
    return spawnSync('bash', [join(root, 'deploy.sh'), ...args], { cwd: root, encoding: 'utf8', timeout: 20_000,
      env: { PATH: process.env.PATH!, BUN_INSTALL: join(root, 'fixture-bun'), FIXTURE_COMMAND_LOG: log, COS_PUBLIC_BASE_URL: 'https://example.invalid', COS_SECRET_ID: 'fixture-secret-id', COS_SECRET_KEY: 'fixture-secret-key', ...extraEnv },
    })
  }
  const events = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as {phase:string;args:string[]}) : []
  return { root, output, run, events }
}

const target = ['--platform','darwin','--arch','arm64']
describe.skipIf(process.platform === 'win32')('deploy --chrome-cli 真实脚本执行链', () => {
  test('Given 默认Chrome-only When --chrome-cli Then 从源码重建并依次生成manifest和上传，不安装JS依赖或构建其他模块', () => {
    const f=setup(); const result=f.run(['--chrome-cli',...target])
    expect(result.status).toBe(0)
    expect(f.events().map(event=>event.phase)).toEqual(['app-version-read','build-source','manifest','upload','summary'])
    expect(readFileSync(f.output,'utf8')).toBe('fresh-rust-swift-build')
    const upload=f.events().find(event=>event.phase==='upload')!
    expect(upload.args).toContain('--chrome-desktop-cli')
    expect(upload.args).toContain('--chrome-desktop-cli-archive')
    expect(upload.args).not.toContain('--rust-binary')
    expect(result.stdout+result.stderr).not.toContain('fixture-secret')
  })
  test('Given --skip-publish When --chrome-cli Then 重建组件但不生成或上传manifest', () => {
    const f=setup(); const result=f.run(['--chrome-cli','--skip-publish',...target])
    expect(result.status).toBe(0)
    expect(f.events().map(event=>event.phase)).toEqual(['app-version-read','build-source'])
  })
  test('Given 明确提供归档和版本 When 使用短参数 Then 校验该归档并将版本传到manifest与上传', () => {
    const f=setup(); const archive=join(f.root,'chosen.tar.gz'); writeFileSync(archive,'selected-archive')
    const result=f.run(['--chrome-cli','--chrome-cli-archive',archive,'--chrome-cli-version','0.1.0',...target])
    expect(result.status).toBe(0)
    expect(f.events().map(event=>event.phase)).toEqual(['app-version-read','validate-archive','manifest','upload','summary'])
    expect(readFileSync(f.output,'utf8')).toBe('selected-archive')
    for (const phase of ['manifest','upload']) {
      const args=f.events().find(event=>event.phase===phase)!.args
      expect(args[args.indexOf('--chrome-desktop-cli-version')+1]).toBe('0.1.0')
    }
  })
  test('Given 旧长参数 When 发布 Then 与短参数兼容且不安装无关依赖', () => {
    const f=setup(); const result=f.run(['--chrome-desktop-cli',...target])
    expect(result.status).toBe(0)
    expect(f.events().map(event=>event.phase)).toEqual(['app-version-read','build-source','manifest','upload','summary'])
  })
  test('Given --install显式覆盖 When --chrome-cli Then 只按明确要求安装一次', () => {
    const f=setup(); const result=f.run(['--chrome-cli','--install','--skip-publish',...target])
    expect(result.status).toBe(0)
    expect(f.events().map(event=>event.phase)).toEqual(['app-version-read','install','build-source'])
  })
  test('Given 构建失败 When --chrome-cli Then 不生成manifest或上传', () => {
    const f=setup(); const result=f.run(['--chrome-cli',...target],{FIXTURE_FAIL_PHASE:'build'})
    expect(result.status).not.toBe(0)
    expect(f.events().map(event=>event.phase)).toEqual(['app-version-read','build-source'])
  })
  test('Given 上传失败 When --chrome-cli Then 失败退出且不打印发布成功', () => {
    const f=setup(); const result=f.run(['--chrome-cli',...target],{FIXTURE_FAIL_PHASE:'upload'})
    expect(result.status).not.toBe(0)
    expect(result.stdout).not.toContain('功能模块发布完成')
  })
  for (const args of [['--chrome-cli','--platform','linux','--arch','x64'],['--chrome-cli','--rust'],['--chrome-cli','--chrome-cli-archive'],['--chrome-cli','--chrome-cli-version']]) {
    test(`Given 非法组合${args.join(' ')} When deploy Then 构建和上传均不发生`, () => {
      const f=setup(); const result=f.run(args)
      expect(result.status).not.toBe(0)
      expect(f.events()).toEqual([])
    })
  }
  for (const name of ['archive','version']) for (const reverse of [false,true]) {
    test(`Given ${name}短长别名提供不同值且reverse=${reverse} When deploy Then 构建前拒绝冲突`, () => {
      const f=setup()
      const flags=[`--chrome-cli-${name}`,'one',`--chrome-desktop-cli-${name}`,'two']
      const args=reverse ? [...flags.slice(2),...flags.slice(0,2)] : flags
      const result=f.run(['--chrome-cli',...args,...target])
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('冲突')
      expect(f.events()).toEqual([])
    })
  }
  test('Given 两组别名值相同 When deploy Then 只校验和发布一次', () => {
    const f=setup(); const archive=join(f.root,'chosen.tar.gz'); writeFileSync(archive,'same-archive')
    const result=f.run(['--chrome-cli','--chrome-cli-archive',archive,'--chrome-desktop-cli-archive',archive,'--chrome-cli-version','0.1.0','--chrome-desktop-cli-version','0.1.0',...target])
    expect(result.status).toBe(0)
    expect(f.events().map(event=>event.phase)).toEqual(['app-version-read','validate-archive','manifest','upload','summary'])
  })
  test('Given 环境有旧版本配置 When 显式CLI提供新值 Then CLI覆盖环境而不视为别名冲突', () => {
    const f=setup(); const result=f.run(['--chrome-cli','--skip-publish','--chrome-cli-version','0.1.0',...target],{COPIS_CHROME_DESKTOP_CLI_VERSION:'9.9.9'})
    expect(result.status).toBe(0)
    const prepare=f.events().find(event=>event.phase==='build-source')!
    expect(prepare.args[prepare.args.indexOf('--version')+1]).toBe('0.1.0')
  })
  test('Given 查看帮助 When --help Then 说明短入口和兼容参数', () => {
    const f=setup(); const result=f.run(['--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('--chrome-cli')
    expect(result.stdout).toContain('--chrome-desktop-cli')
    expect(result.stdout).toContain('重新构建')
  })
})
