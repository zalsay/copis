import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { activateFunctionalModule, assembleFunctionalModule, cacheFunctionalModule, getFunctionalModulePaths, type ActiveFunctionalModule } from './functional-module-store'
import { ChromeDesktopComponentClient } from './chrome-desktop-component-client'

// shebang、Unix 进程组和权限/链接校验需要 Unix 宿主；Linux 继续运行集成回归。
const describeUnixIntegration = describe.skipIf(process.platform === 'win32')

const windowInfo = { windowId: 42, pid: 123, title: 'Fixture', bounds: { x: 10, y: 20, width: 800, height: 600 } }
// SOI、SOF0（2×1）与 EOI；只用来验证文件边界和 JPEG 尺寸，不解码像素。
const jpeg = Buffer.from([255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 2, 1, 1, 17, 0, 255, 217])
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

// 真正执行独立 CLI 进程，保留文件、argv、JSON 与退出行为，只替代原生桌面能力。
const fakeCli = `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const dir = __dirname, args = process.argv.slice(2), action = args[0];
const config = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
const runtime = process.env.COPIS_CHROME_RUNTIME_DIR;
const get = flag => args[args.indexOf(flag) + 1];
const event = { action, args, runtime, helper: process.env.COPIS_CHROME_HELPER };
fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(event) + '\\n');
const reply = value => console.log(JSON.stringify({protocolVersion: 1, ok: true, ...value}));
(async () => {
 if (action === 'daemon') {
   if (args[1] !== 'stop') throw Error('错误 daemon 参数');
   fs.writeFileSync(path.join(dir, 'stopped'), 'yes');
   if (config.stopFailure) { console.log('bad stop'); process.exitCode = 1; return; }
   reply(config.stopResponse || {running: false}); return;
 }
 if (config.spawnChildAction === action) {
   require('node:child_process').spawn(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)", path.join(dir, 'child-pid')], {stdio: 'ignore'});
 }
 if (config.delayAction === action) await new Promise(resolve => setTimeout(resolve, config.delayMs || 2000));
 if (config.failAction === action) {
   if (config.stderr) console.error(config.stderr);
   if (config.raw !== undefined) process.stdout.write(config.raw);
   else reply({ ...(config.response || {}), ...(config.code ? {ok: false, error: {code: config.code, message: config.stderr || 'native error'}} : {}) });
   process.exitCode = config.exitCode || 0; return;
 }
 const win = ${JSON.stringify(windowInfo)};
 if (action === 'permissions') {
   const requested = args.includes('--request');
   if (requested && !config.allowPermissionRequest) throw Error('禁止请求权限');
   const permissions = (requested ? config.permissionRequestResult : undefined) || config.permissions || {accessibility: true, screenRecording: true};
   if (requested) {
     config.permissions = permissions;
     fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(config));
   }
   reply(permissions);
 }
 else if (action === 'windows') reply({windows: config.windows || [win]});
 else if (action === 'connect') {
   if (get('--window') !== '42') throw Error('错误窗口');
   if (config.permissions && !config.permissions.screenRecording) {
     reply({ok: false, error: {code: 'SCREEN_PERMISSION_REQUIRED', message: '需要屏幕录制权限'}}); process.exitCode = 1; return;
   }
   reply({connected: true, connectionId: 'native-connection', window: {...win, ...(config.connectWindow || {})}});
 } else if (action === 'observe') {
   if (get('--connection') !== 'native-connection' || args.includes('--out')) throw Error('错误 observe 参数');
   fs.mkdirSync(path.join(runtime, 'frames'), {recursive: true, mode: 0o700});
   let image = path.join(runtime, 'frames', 'native-frame.jpg');
   const bytes = Buffer.from('${jpeg.toString('base64')}', 'base64');
   if (config.frameMode === 'outside') { image = path.join(dir, 'outside.jpg'); fs.writeFileSync(image, bytes); }
   else if (config.frameMode === 'symlink') { fs.writeFileSync(path.join(dir, 'outside.jpg'), bytes); fs.symlinkSync(path.join(dir, 'outside.jpg'), image); }
   else if (config.frameMode === 'directory-link') {
     fs.rmdirSync(path.join(runtime, 'frames')); fs.mkdirSync(path.join(dir, 'external-frames'));
     fs.symlinkSync(path.join(dir, 'external-frames'), path.join(runtime, 'frames')); fs.writeFileSync(image, bytes);
   } else fs.writeFileSync(image, config.frameMode === 'large' ? Buffer.alloc(1024 * 1024 + 1) : config.frameMode === 'not-jpeg' ? Buffer.from('not jpeg') : bytes);
   reply({connectionId: 'native-connection', frameId: 'native-frame', imagePath: image, width: 2, height: 1,
     capturedAtMs: 1234, bounds: win.bounds, ...(config.frame || {})});
 } else {
   if (get('--connection') !== 'native-connection' || get('--frame') !== 'native-frame') throw Error('帧或连接被改写');
   if (config.permissions && !config.permissions.accessibility) {
     reply({ok: false, error: {code: 'ACCESSIBILITY_PERMISSION_REQUIRED', message: '需要输入权限'}}); process.exitCode = 1; return;
   }
   const expected = {click: ['--x','--y','--count'], scroll: ['--x','--y','--delta-y'], type: ['--text'], press: ['--key']}[action];
   if (!expected || expected.some(flag => !args.includes(flag))) throw Error('错误动作映射');
   reply({sent: true, connectionId: 'native-connection', frameId: 'native-frame'});
 }
})().catch(error => {console.error(error.message); process.exitCode = 1});
`

async function fixture(version = '0.1.0', useArchive = false) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'cpc-test-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const paths = getFunctionalModulePaths(root)
  async function install(nextVersion: string) {
    const packageDir = `copis-chrome-${nextVersion}-darwin-${process.arch}`
    const versionDir = useArchive ? join(root, 'source', nextVersion) : join(paths.versionsDir, 'chrome-desktop-cli', nextVersion)
    const binDir = join(versionDir, packageDir)
    await mkdir(binDir, { recursive: true })
    const info = { name: 'chrome-desktop-cli', version: nextVersion, sha256: 'a'.repeat(64), size: 10, format: 'tar.gz' as const, entrypoint: `${packageDir}/copis-chrome`, required: false }
    const active: ActiveFunctionalModule = { ...info, path: join(binDir, 'copis-chrome') }
    await writeFile(active.path, fakeCli, { mode: 0o755 })
    await writeFile(join(binDir, 'copis-chrome-helper'), 'fixture', { mode: 0o755 })
    await writeFile(join(binDir, 'module.json'), JSON.stringify({ name: info.name, version: nextVersion, platform: 'darwin', arch: process.arch, protocolVersion: 1, entrypoint: 'copis-chrome', helper: 'copis-chrome-helper' }))
    await writeFile(join(binDir, 'scenario.json'), '{}')
    if (useArchive) {
      const archive = join(root, `component-${nextVersion}.tar.gz`)
      const tar = Bun.spawn(['tar', '-czf', archive, '-C', versionDir, packageDir], { stdout: 'ignore', stderr: 'pipe' })
      if (await tar.exited !== 0) throw Error(await new Response(tar.stderr).text())
      const payload = await readFile(archive)
      info.sha256 = createHash('sha256').update(payload).digest('hex')
      info.size = payload.length
      await cacheFunctionalModule(paths, info, archive)
      const assembled = await assembleFunctionalModule(paths, info)
      await activateFunctionalModule(paths, info, assembled)
      return { ...info, path: join(assembled, info.entrypoint) }
    }
    await writeFile(join(versionDir, 'module-lock.json'), JSON.stringify({ package: info }))
    await writeFile(join(versionDir, '.complete'), 'complete')
    await activateFunctionalModule(paths, info, versionDir)
    return active
  }
  const active = await install(version)
  const client = new ChromeDesktopComponentClient({ platform: 'darwin', moduleRootDir: root })
  cleanups.push(() => client.cancel().catch(() => {}))
  return { root, paths, active, client, install,
    configure: (value: object, component = active) => writeFile(join(dirname(component.path), 'scenario.json'), JSON.stringify(value)),
    events: async (component = active): Promise<Array<{ action: string; args: string[]; runtime: string; helper?: string }>> => {
      const file = join(dirname(component.path), 'events.jsonl')
      return existsSync(file) ? (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) : []
    },
  }
}

async function waitUntil(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 2500
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('等待 fixture 事件超时')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function rejectsCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toThrow(`${code}:`)
}

describeUnixIntegration('Chrome 组件：受管模块与 CLI 协议 BDD', () => {
  test('Given active 组件 When 检查和列窗 Then 解析真实 JSON 且不连接或请求权限', async () => {
    const f = await fixture()
    expect(await f.client.checkPermissions()).toEqual({ accessibility: true, screenRecording: true, helperPath: join(dirname(f.active.path), 'copis-chrome-helper'), componentVersion: '0.1.0' })
    expect(await f.client.listWindows()).toEqual([windowInfo])
    const events = await f.events()
    expect(events.map(e => e.action)).toEqual(['permissions', 'windows'])
    expect(events[0]!.args).not.toContain('--request')
    expect((await lstat(events[0]!.runtime)).mode & 0o777).toBe(0o700)
    expect(Buffer.byteLength(join(events[0]!.runtime, 'daemon.sock'))).toBeLessThanOrEqual(100)
    await f.client.disconnect()
    expect(existsSync(events[0]!.runtime)).toBe(false)
    expect((await f.events()).at(-1)!.args.slice(0, 2)).toEqual(['daemon', 'stop'])
  })

  test('Given 未安装 When 按需准备 Then installer 后重读 active 而不使用返回的任意 path', async () => {
    const f = await fixture()
    await rm(f.paths.activeFile)
    const client = new ChromeDesktopComponentClient({ platform: 'darwin', moduleRootDir: f.root,
      installComponent: async () => { await f.install('0.2.0'); return { path: '/untrusted/copis-chrome' } },
    })
    cleanups.push(() => client.cancel())
    expect((await client.checkPermissions()).componentVersion).toBe('0.2.0')
    expect(await client.listWindows()).toEqual([windowInfo])
  })

  test('Given 安装失败和污染环境 When 检查 Then 提示功能模块设置且不回退旧 helper', async () => {
    const f = await fixture()
    await rm(f.paths.activeFile)
    const client = new ChromeDesktopComponentClient({ platform: 'darwin', moduleRootDir: f.root, installComponent: async () => { throw Error('secret-token') } })
    await expect(client.checkPermissions()).rejects.toThrow('功能模块设置')
    expect(await f.events()).toEqual([])
  })

  for (const [name, value] of Object.entries({ protocolVersion: 2, version: '99.0.0', platform: 'linux', arch: 'wrong', helper: '../helper', entrypoint: '../copis-chrome', name: 'other' })) {
    test(`Given metadata ${name} 不兼容 When 检查 Then 拒绝执行`, async () => {
      const f = await fixture()
      const path = join(dirname(f.active.path), 'module.json')
      const metadata = JSON.parse(await readFile(path, 'utf8'))
      await writeFile(path, JSON.stringify({ ...metadata, [name]: value }))
      await rejectsCode(f.client.listWindows(), 'CHROME_HELPER_FAILED')
      expect(await f.events()).toEqual([])
    })
  }

  for (const target of ['copis-chrome', 'copis-chrome-helper', 'module.json', 'package-directory']) {
    test(`Given ${target} 符号链接越界 When 检查 Then 拒绝受管路径污染`, async () => {
      const f = await fixture()
      const source = target === 'package-directory' ? dirname(f.active.path) : join(dirname(f.active.path), target)
      const outside = join(f.root, 'outside')
      const { rename } = await import('node:fs/promises')
      await rename(source, outside)
      await symlink(outside, source)
      await rejectsCode(f.client.checkPermissions(), 'CHROME_HELPER_FAILED')
      expect(await f.events()).toEqual([])
    })
  }

  test('Given resolver 返回受管目录之外入口 When 检查 Then 拒绝执行', async () => {
    const f = await fixture()
    const client = new ChromeDesktopComponentClient({ platform: 'darwin', moduleRootDir: f.root, resolveComponent: () => ({ ...f.active, path: '/tmp/copis-chrome' }) })
    await rejectsCode(client.listWindows(), 'CHROME_HELPER_FAILED')
  })

  test('Given CLI 入口不可执行 When 检查 Then 拒绝执行而不擅自修复入口', async () => {
    const f = await fixture()
    await chmod(f.active.path, 0o600)
    await rejectsCode(f.client.checkPermissions(), 'CHROME_HELPER_FAILED')
  })

  for (const scenario of [
    { raw: 'not json\n' }, { raw: '' }, { raw: '[]\n' }, { raw: '{"protocolVersion":2,"ok":true}\n' },
    { raw: '{"protocolVersion":1,"ok":"true"}\n' }, { raw: '{"protocolVersion":1,"ok":true}\n{}\n' },
    { response: { accessibility: true, screenRecording: true }, exitCode: 7 },
    { raw: 'x'.repeat(65537) }, { response: { accessibility: 'true', screenRecording: true } },
  ]) {
    test(`Given CLI 非法响应 ${JSON.stringify(scenario).slice(0, 75)} When 检查 Then 不视为成功`, async () => {
      const f = await fixture()
      await f.configure({ failAction: 'permissions', ...scenario })
      await rejectsCode(f.client.checkPermissions(), 'CHROME_HELPER_FAILED')
    })
  }

  test('Given 超时或 stderr 含文本和凭据 When invoke Then 有界失败且错误不泄露内容', async () => {
    const f = await fixture()
    const client = new ChromeDesktopComponentClient({ platform: 'darwin', moduleRootDir: f.root, commandTimeoutMs: 500 })
    cleanups.push(() => client.cancel())
    await f.configure({ delayAction: 'permissions' })
    await rejectsCode(client.checkPermissions(), 'CHROME_ACTION_UNCERTAIN')
    await f.configure({ failAction: 'permissions', exitCode: 1, raw: '', stderr: 'secret-token 用户输入文本 native-connection' })
    let message = ''
    try { await client.checkPermissions() } catch (error) { message = (error as Error).message }
    expect(message).toContain('CHROME_HELPER_FAILED:')
    expect(message).not.toMatch(/secret-token|用户输入文本|native-connection/)
  })

  test('Given 环境指定其他 helper/runtime When 检查 Then 实际使用独占目录和受管 helper', async () => {
    const f = await fixture()
    const originalHelper = process.env.COPIS_CHROME_HELPER, originalRuntime = process.env.COPIS_CHROME_RUNTIME_DIR
    try {
      process.env.COPIS_CHROME_HELPER = '/untrusted/helper'
      process.env.COPIS_CHROME_RUNTIME_DIR = '/untrusted/runtime'
      await f.client.checkPermissions()
      const event = (await f.events())[0]!
      expect(event.runtime).not.toBe('/untrusted/runtime')
      expect(event.helper).toBe(join(dirname(f.active.path), 'copis-chrome-helper'))
    } finally {
      if (originalHelper === undefined) delete process.env.COPIS_CHROME_HELPER; else process.env.COPIS_CHROME_HELPER = originalHelper
      if (originalRuntime === undefined) delete process.env.COPIS_CHROME_RUNTIME_DIR; else process.env.COPIS_CHROME_RUNTIME_DIR = originalRuntime
    }
  })
})

describeUnixIntegration('Chrome 组件：连接、原生帧和取消 BDD', () => {
  test('Given windowId 与 pid 不匹配 When 连接 Then 在 connect 前拒绝', async () => {
    const f = await fixture()
    await rejectsCode(f.client.connectWindow(42, 999), 'CHROME_WINDOW_UNAVAILABLE')
    expect((await f.events()).map(e => e.action)).not.toContain('connect')
  })

  test('Given 列窗后连接身份变化 When 连接 Then 拒绝响应并停止 runtime', async () => {
    const f = await fixture()
    await f.configure({ connectWindow: { pid: 999 } })
    await rejectsCode(f.client.connectWindow(42, 123), 'CHROME_WINDOW_UNAVAILABLE')
    expect((await f.events()).at(-1)!.action).toBe('daemon')
  })

  test('Given 未连接 When observe/input Then 不调用 CLI', async () => {
    const f = await fixture()
    await rejectsCode(f.client.observe(), 'CHROME_WINDOW_UNAVAILABLE')
    await rejectsCode(f.client.input('native-frame', { action: 'press', key: 'Enter' }), 'CHROME_WINDOW_UNAVAILABLE')
    expect(await f.events()).toEqual([])
  })

  test('Given 原生 observe When 读取 Then 仅返回私有 JPEG 的 base64 和 native frameId', async () => {
    const f = await fixture()
    expect(await f.client.connectWindow(42, 123)).toEqual(windowInfo)
    const frame = await f.client.observe()
    expect(frame).toEqual({ frameId: 'native-frame', width: 2, height: 1, capturedAt: 1234, bounds: windowInfo.bounds, data: jpeg.toString('base64') })
    expect((await f.events()).map(e => e.action)).toEqual(['permissions', 'windows', 'connect', 'observe'])
  })

  for (const config of [
    { frameMode: 'outside' }, { frameMode: 'symlink' }, { frameMode: 'directory-link' }, { frameMode: 'large' }, { frameMode: 'not-jpeg' },
    { frame: { width: 1601 } }, { frame: { width: 3 } }, { frame: { height: 0 } }, { frame: { capturedAtMs: -1 } },
    { frame: { connectionId: 'other' } }, { frame: { bounds: { x: 0, y: 0, width: 0, height: 1 } } },
  ]) {
    test(`Given 不可信帧 ${JSON.stringify(config)} When observe Then 拒绝`, async () => {
      const f = await fixture()
      await f.configure(config)
      await f.client.connectWindow(42, 123)
      await expect(f.client.observe()).rejects.toThrow(/^CHROME_/)
    })
  }

  test('Given 四种输入 When 重用 native frameId Then 使用图片坐标且不额外观察', async () => {
    const f = await fixture()
    await f.client.connectWindow(42, 123)
    await f.client.observe()
    await f.client.input('native-frame', { action: 'click', x: 1, y: 0, clickCount: 2 })
    await f.client.input('native-frame', { action: 'scroll', x: 1, y: 0, deltaY: -120 })
    await f.client.input('native-frame', { action: 'type', text: '你好 "$()`\n' })
    await f.client.input('native-frame', { action: 'press', key: 'Cmd+L' })
    const events = (await f.events()).slice(4)
    expect(events.map(e => e.args.filter(a => a !== '--json'))).toEqual([
      ['click', '--connection', 'native-connection', '--frame', 'native-frame', '--x', '1', '--y', '0', '--count', '2'],
      ['scroll', '--connection', 'native-connection', '--frame', 'native-frame', '--x', '1', '--y', '0', '--delta-y', '-120'],
      ['type', '--connection', 'native-connection', '--frame', 'native-frame', '--text', '你好 "$()`\n'],
      ['press', '--connection', 'native-connection', '--frame', 'native-frame', '--key', 'Cmd+L'],
    ])
  })

  for (const [native, code] of Object.entries({ CONNECTION_BUSY: 'CHROME_BUSY', BUSY: 'CHROME_BUSY', FRAME_UNKNOWN: 'CHROME_FRAME_STALE', FRAME_GEOMETRY_CHANGED: 'CHROME_GEOMETRY_CHANGED', WINDOW_UNAVAILABLE: 'CHROME_WINDOW_UNAVAILABLE', FOCUS_LOST: 'CHROME_FOCUS_LOST', FOCUS_UNVERIFIED: 'CHROME_FOCUS_LOST', SCREEN_PERMISSION_REQUIRED: 'CHROME_SCREEN_PERMISSION_REQUIRED', ACCESSIBILITY_PERMISSION_REQUIRED: 'CHROME_INPUT_PERMISSION_REQUIRED', HELPER_TIMEOUT: 'CHROME_ACTION_UNCERTAIN', HELPER_EOF: 'CHROME_ACTION_UNCERTAIN', CAPTURE_TIMEOUT: 'CHROME_ACTION_UNCERTAIN', CAPTURE_FAILED: 'CHROME_CAPTURE_FAILED', IMAGE_TOO_LARGE: 'CHROME_CAPTURE_FAILED' })) {
    test(`Given native ${native} When 执行动作 Then 映射 ${code} 且不重试`, async () => {
      const f = await fixture()
      await f.client.connectWindow(42, 123)
      const action = native.startsWith('CAPTURE_') || native === 'IMAGE_TOO_LARGE' ? 'observe' : 'press'
      await f.configure({ failAction: action, code: native, exitCode: 1, stderr: 'secret-token 用户文本' })
      await rejectsCode(action === 'observe' ? f.client.observe() : f.client.input('native-frame', { action: 'press', key: 'Enter' }), code)
      expect((await f.events()).filter(e => e.action === action)).toHaveLength(1)
      if (native.startsWith('FOCUS') || native === 'FRAME_GEOMETRY_CHANGED') {
        await f.configure({})
        expect((await f.client.observe()).frameId).toBe('native-frame')
      }
    })
  }

  test('Given active 更新 When 已连接输入与新连接 Then 旧连接固定路径、新连接采用新版本', async () => {
    const f = await fixture()
    await f.client.checkPermissions()
    const second = await f.install('0.2.0')
    await f.client.connectWindow(42, 123)
    expect((await f.events()).map(e => e.action)).not.toContain('connect')
    const third = await f.install('0.3.0')
    await f.client.input('native-frame', { action: 'press', key: 'Enter' })
    expect((await f.events(second)).map(e => e.action)).toEqual(['permissions', 'windows', 'connect', 'press'])
    expect(await f.events(third)).toEqual([])
    await f.client.cancel()
    const oldRuntime = (await f.events(second))[0]!.runtime
    expect(existsSync(oldRuntime)).toBe(false)
    await f.client.connectWindow(42, 123)
    expect((await f.events(third)).map(e => e.action)).toEqual(['permissions', 'windows', 'connect'])
    expect((await f.events(third))[0]!.runtime).not.toBe(oldRuntime)
  })

  test('Given 两个 main 客户端 When 同版本连接 Then runtime 隔离且停止不互相影响', async () => {
    const f = await fixture()
    const other = new ChromeDesktopComponentClient({ platform: 'darwin', moduleRootDir: f.root })
    cleanups.push(() => other.cancel())
    await f.client.connectWindow(42, 123)
    await other.connectWindow(42, 123)
    const windows = (await f.events()).filter(e => e.action === 'windows')
    expect(windows[0]!.runtime).not.toBe(windows[1]!.runtime)
    await f.client.cancel()
    expect(existsSync(windows[0]!.runtime)).toBe(false)
    expect(existsSync(windows[1]!.runtime)).toBe(true)
    expect((await other.observe()).frameId).toBe('native-frame')
  })

  test('Given input 阻塞 When cancel Then stop 并行完成、动作取消且目录清理', async () => {
    const f = await fixture()
    await f.client.connectWindow(42, 123)
    await f.configure({ delayAction: 'type', delayMs: 2000 })
    const input = f.client.input('native-frame', { action: 'type', text: 'private-text' }).catch(error => error as Error)
    await waitUntil(async () => (await f.events()).some(e => e.action === 'type'))
    const started = Date.now()
    await f.client.cancel()
    expect(Date.now() - started).toBeLessThan(1200)
    expect(((await input) as Error).message).toContain('CHROME_CANCELLED:')
    const events = await f.events()
    expect(events.at(-1)!.args.slice(0, 2)).toEqual(['daemon', 'stop'])
    expect(existsSync(events[0]!.runtime)).toBe(false)
  })

  test('Given connect 在途 When cancel 和新连接 Then 旧响应不能复活连接', async () => {
    const f = await fixture()
    await f.configure({ delayAction: 'connect', delayMs: 1000 })
    const connecting = f.client.connectWindow(42, 123).catch(error => error as Error)
    await waitUntil(async () => (await f.events()).some(e => e.action === 'connect'))
    await f.client.cancel()
    expect(((await connecting) as Error).message).toContain('CHROME_CANCELLED:')
    await f.configure({})
    await f.client.connectWindow(42, 123)
    expect((await f.client.observe()).frameId).toBe('native-frame')
  })

  test('Given resolver 在途 When stop Then 迟到的解析不启动 daemon', async () => {
    const f = await fixture()
    let finish!: (active: ActiveFunctionalModule) => void
    const client = new ChromeDesktopComponentClient({ platform: 'darwin', moduleRootDir: f.root, resolveComponent: () => new Promise(resolve => { finish = resolve }) })
    const connecting = client.connectWindow(42, 123).catch(error => error as Error)
    await waitUntil(async () => Boolean(finish))
    client.stop()
    finish(f.active)
    expect(((await connecting) as Error).message).toContain('CHROME_CANCELLED:')
    await client.cancel()
    expect(await f.events()).toEqual([])
  })

  test('Given daemon stop 失败 When disconnect Then 明确失败并保留可重试清理的 runtime', async () => {
    const f = await fixture()
    await f.client.connectWindow(42, 123)
    const runtime = (await f.events())[0]!.runtime
    await f.configure({ stopFailure: true })
    await rejectsCode(f.client.disconnect(), 'CHROME_HELPER_FAILED')
    expect(existsSync(runtime)).toBe(true)
    await f.configure({})
    await f.client.cancel()
    expect(existsSync(runtime)).toBe(false)
  })
})

describeUnixIntegration('Chrome 组件：停止确认与注入边界 BDD', () => {
  test('Given stop 未确认退出 When cancel Then 不删除可能仍活跃的 runtime', async () => {
    const f = await fixture()
    await f.client.connectWindow(42, 123)
    const runtime = (await f.events())[0]!.runtime
    await f.configure({ stopResponse: { running: true } })
    await rejectsCode(f.client.cancel(), 'CHROME_HELPER_FAILED')
    expect(existsSync(runtime)).toBe(true)
    await f.configure({})
    await f.client.cancel()
    expect(existsSync(runtime)).toBe(false)
  })

  test('Given 恶意原生错误码 When input Then 只允许既有共享码且不泄露原文', async () => {
    const f = await fixture()
    await f.client.connectWindow(42, 123)
    await f.configure({ failAction: 'press', code: 'toString', exitCode: 1, stderr: 'secret-token' })
    await rejectsCode(f.client.input('native-frame', { action: 'press', key: 'Enter' }), 'CHROME_HELPER_FAILED')
  })

  test('Given executor 同步抛出文本 When 检查 Then 转换为无敏感内容的固定错误', async () => {
    const f = await fixture()
    const client = new ChromeDesktopComponentClient({ platform: 'darwin', moduleRootDir: f.root, executeCommand: command => {
      cleanups.push(() => rm(command.env.COPIS_CHROME_RUNTIME_DIR!, { recursive: true, force: true }))
      throw Error('secret-token 用户输入')
    } })
    await rejectsCode(client.checkPermissions(), 'CHROME_HELPER_FAILED')
    // 注入执行器永远失败，清理仍由测试负责；生产客户端保留失败 runtime 供重试。
    await client.cancel().catch(() => {})
  })

  test('Given 两个同时连接 When 完成 Then 只建立一次原生连接并返回 BUSY', async () => {
    const f = await fixture()
    const results = await Promise.allSettled([f.client.connectWindow(42, 123), f.client.connectWindow(42, 123)])
    expect(results[0]!.status).toBe('fulfilled')
    expect(results[1]!.status).toBe('rejected')
    expect((results[1] as PromiseRejectedResult).reason.message).toContain('CHROME_BUSY:')
    expect((await f.events()).filter(event => event.action === 'connect')).toHaveLength(1)
  })
})

describeUnixIntegration('Chrome 组件：后台启动取消 BDD', () => {
  test('Given CLI 正在启动后台子进程 When cancel Then 子进程不会在停止后残留', async () => {
    const f = await fixture()
    await f.configure({ spawnChildAction: 'connect', delayAction: 'connect', delayMs: 3000 })
    const connecting = f.client.connectWindow(42, 123).catch(error => error as Error)
    const pidPath = join(dirname(f.active.path), 'child-pid')
    await waitUntil(async () => existsSync(pidPath))
    const pid = Number(await readFile(pidPath, 'utf8'))
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    cleanups.push(async () => { if (alive()) process.kill(pid, 'SIGKILL') })
    await f.client.cancel()
    expect(((await connecting) as Error).message).toContain('CHROME_CANCELLED:')
    await waitUntil(async () => !alive())
    expect(alive()).toBe(false)
  })
})

describeUnixIntegration('Chrome 组件：真实归档安装 BDD', () => {
  test('Given tar.gz 经 store 缓存、解包和激活 When 准备 Then 校验后修复 helper 0644 并执行安装入口', async () => {
    const f = await fixture('0.4.0', true)
    const helper = join(dirname(f.active.path), 'copis-chrome-helper')
    expect((await lstat(helper)).mode & 0o777).toBe(0o644)
    expect((await lstat(f.active.path)).mode & 0o111).not.toBe(0)
    expect((await f.client.checkPermissions()).componentVersion).toBe('0.4.0')
    expect((await lstat(helper)).mode & 0o777).toBe(0o755)
    expect(await f.client.connectWindow(42, 123)).toEqual(windowInfo)
    expect((await f.client.observe()).data).toBe(jpeg.toString('base64'))
    const runtime = (await f.events())[0]!.runtime
    await f.client.disconnect()
    expect(existsSync(runtime)).toBe(false)
  })

  test('Given 归档 helper 0644 且协议不符 When 准备 Then 校验失败前不修改权限', async () => {
    const f = await fixture('0.4.0', true)
    const helper = join(dirname(f.active.path), 'copis-chrome-helper')
    const metadataPath = join(dirname(f.active.path), 'module.json')
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
    await writeFile(metadataPath, JSON.stringify({ ...metadata, protocolVersion: 2 }))
    await rejectsCode(f.client.checkPermissions(), 'CHROME_HELPER_FAILED')
    expect((await lstat(helper)).mode & 0o777).toBe(0o644)
    expect(await f.events()).toEqual([])
  })

  test('Given helper 被换成指向外部的链接 When 准备 Then 不给外部文件加执行权限', async () => {
    const f = await fixture('0.4.0', true)
    const helper = join(dirname(f.active.path), 'copis-chrome-helper')
    const outside = join(f.root, 'outside-helper')
    await writeFile(outside, 'outside', { mode: 0o644 })
    await rm(helper)
    await symlink(outside, helper)
    await rejectsCode(f.client.checkPermissions(), 'CHROME_HELPER_FAILED')
    expect((await lstat(outside)).mode & 0o777).toBe(0o644)
    expect(await f.events()).toEqual([])
  })
})

describeUnixIntegration('Chrome 组件：权限修复的路径边界 BDD', () => {
  test('Given module-store 根目录有系统路径别名 When 准备 Then 使用实际受管入口和 helper', async () => {
    const f = await fixture('0.4.0', true)
    const alias = join(f.root, 'root-alias')
    await symlink(f.root, alias)
    const client = new ChromeDesktopComponentClient({ platform: 'darwin', moduleRootDir: alias })
    cleanups.push(() => client.cancel())
    expect((await client.checkPermissions()).helperPath).toBe(join(dirname(f.active.path), 'copis-chrome-helper'))
  })

  test('Given helper 是外部文件的硬链接 When 准备 Then 不通过 chmod 修改外部文件', async () => {
    const f = await fixture('0.4.0', true)
    const helper = join(dirname(f.active.path), 'copis-chrome-helper')
    const outside = join(f.root, 'outside-helper')
    await writeFile(outside, 'outside', { mode: 0o644 })
    await rm(helper)
    await link(outside, helper)
    await rejectsCode(f.client.checkPermissions(), 'CHROME_HELPER_FAILED')
    expect((await lstat(outside)).mode & 0o777).toBe(0o644)
  })
})


describeUnixIntegration('Chrome 组件：用户确认后的首次系统授权 BDD', () => {
  test('Given 首次未授予任何权限 When 自动检查和列窗 Then 只读取权限且不弹系统授权', async () => {
    const f = await fixture()
    await f.configure({ permissions: { screenRecording: false, accessibility: false } })
    expect(await f.client.checkPermissions()).toMatchObject({ screenRecording: false, accessibility: false })
    expect(await f.client.listWindows()).toEqual([windowInfo])
    const events = await f.events()
    expect(events.map(event => event.action)).toEqual(['permissions', 'windows'])
    expect(events.some(event => event.args.includes('--request'))).toBe(false)
  })

  test('Given 用户确认且首次无权限 When 请求后授予两项权限 Then 连接成功且可观察输入', async () => {
    const f = await fixture()
    await f.configure({ allowPermissionRequest: true,
      permissions: { screenRecording: false, accessibility: false },
      permissionRequestResult: { screenRecording: true, accessibility: true },
    })
    expect(await f.client.connectWindow(42, 123)).toEqual(windowInfo)
    expect((await f.client.observe()).frameId).toBe('native-frame')
    await f.client.input('native-frame', { action: 'press', key: 'Enter' })
    const events = await f.events()
    expect(events.map(event => event.action)).toEqual(['permissions', 'permissions', 'windows', 'connect', 'observe', 'press'])
    expect(events[0]!.args).not.toContain('--request')
    expect(events[1]!.args).toContain('--request')
    expect(events.filter(event => event.args.includes('--request'))).toHaveLength(1)
  })

  test('Given 两项权限已经授权 When 用户确认连接 Then 先只读检查且绝不重复请求', async () => {
    const f = await fixture()
    expect(await f.client.connectWindow(42, 123)).toEqual(windowInfo)
    const events = await f.events()
    expect(events.map(event => event.action)).toEqual(['permissions', 'windows', 'connect'])
    expect(events.some(event => event.args.includes('--request'))).toBe(false)
  })

  test('Given 用户确认但拒绝录屏 When 请求返回仍未授权 Then 报录屏权限码并停止 runtime', async () => {
    const f = await fixture()
    await f.configure({ allowPermissionRequest: true,
      permissions: { screenRecording: false, accessibility: false },
      permissionRequestResult: { screenRecording: false, accessibility: true },
    })
    await rejectsCode(f.client.connectWindow(42, 123), 'CHROME_SCREEN_PERMISSION_REQUIRED')
    const events = await f.events()
    expect(events.map(event => event.action)).toEqual(['permissions', 'permissions', 'daemon'])
    expect(events[1]!.args).toContain('--request')
    expect(existsSync(events[0]!.runtime)).toBe(false)
  })

  test('Given 录屏已授权但用户拒绝 AX When 确认连接 Then 保留只读连接并在输入时报权限码', async () => {
    const f = await fixture()
    await f.configure({ allowPermissionRequest: true,
      permissions: { screenRecording: true, accessibility: false },
      permissionRequestResult: { screenRecording: true, accessibility: false },
    })
    expect(await f.client.connectWindow(42, 123)).toEqual(windowInfo)
    expect((await f.client.observe()).frameId).toBe('native-frame')
    await rejectsCode(f.client.input('native-frame', { action: 'press', key: 'Enter' }), 'CHROME_INPUT_PERMISSION_REQUIRED')
    expect((await f.client.checkPermissions()).accessibility).toBe(false)
    const events = await f.events()
    expect(events.filter(event => event.args.includes('--request'))).toHaveLength(1)
    expect(events.some(event => event.action === 'daemon')).toBe(false)
  })

  test('Given 仅缺少 AX When 用户确认并授予 AX Then 请求一次后允许输入', async () => {
    const f = await fixture()
    await f.configure({ allowPermissionRequest: true,
      permissions: { screenRecording: true, accessibility: false },
      permissionRequestResult: { screenRecording: true, accessibility: true },
    })
    await f.client.connectWindow(42, 123)
    await f.client.input('native-frame', { action: 'press', key: 'Enter' })
    expect((await f.events()).filter(event => event.args.includes('--request'))).toHaveLength(1)
  })

  test('Given 确认连接的权限检查在途 When cancel Then 不在取消后继续请求系统授权', async () => {
    const f = await fixture()
    await f.configure({ permissions: { screenRecording: false, accessibility: false }, delayAction: 'permissions' })
    const connecting = f.client.connectWindow(42, 123).catch(error => error as Error)
    await waitUntil(async () => (await f.events()).some(event => event.action === 'permissions'))
    await f.client.cancel()
    expect(((await connecting) as Error).message).toContain('CHROME_CANCELLED:')
    const events = await f.events()
    expect(events.some(event => event.args.includes('--request'))).toBe(false)
    expect(events.some(event => ['windows', 'connect'].includes(event.action))).toBe(false)
  })
})


describe('Chrome 组件：跨平台纯逻辑 BDD', () => {
  for (const platform of ['linux', 'win32'] as const) {
    test(`Given ${platform} When 检查、列窗或连接 Then 在解析安装与执行前拒绝`, async () => {
      const unexpectedDependency = (): never => { throw Error('不支持的平台不能解析、安装或执行组件') }
      const client = new ChromeDesktopComponentClient({
        platform,
        moduleRootDir: join(tmpdir(), 'copis-unused-component-store'),
        resolveComponent: unexpectedDependency,
        installComponent: unexpectedDependency,
        executeCommand: unexpectedDependency,
      })
      await rejectsCode(client.checkPermissions(), 'CHROME_UNSUPPORTED_CONTEXT')
      await rejectsCode(client.listWindows(), 'CHROME_UNSUPPORTED_CONTEXT')
      await rejectsCode(client.connectWindow(42, 123), 'CHROME_UNSUPPORTED_CONTEXT')
    })
  }
})
