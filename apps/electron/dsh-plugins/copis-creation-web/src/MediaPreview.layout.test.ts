import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

// LinkeDOM 不计算布局，尺寸回归必须由真实 Chromium 执行；不截图、不访问生产配置。
test.skipIf(process.platform === 'linux' && !process.env.DISPLAY)(
  'Given 横竖屏视频 When 原生侧栏缩窄或降低高度 Then 完整等比显示且不溢出、不重建播放器',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'copis-media-layout-'))
    let child: ReturnType<typeof Bun.spawn> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const build = await Bun.build({
        entrypoints: [join(import.meta.dir, 'test-fixtures/media-preview-layout.tsx')],
        outdir: dir, target: 'browser', format: 'iife',
      })
      if (!build.success) throw new Error('尺寸测试入口构建失败')
      await writeFile(join(dir, 'index.html'), `<!doctype html><html><head><style>
        /* 与官方文档预览相同的定高、可滚动内容区；工具栏占用 38px。 */
        #pane { display:flex; flex-direction:column; width:640px; height:720px; }
        #toolbar { flex:none; height:38px; }
        #body { flex:auto; min-height:0; overflow:auto; position:relative; white-space:pre; }
        </style></head><body><div id="pane"><div id="toolbar"></div><div id="body"></div></div>
        <script src="media-preview-layout.js"></script></body></html>`)
      await writeFile(join(dir, 'main.cjs'), `
        const {app,BrowserWindow}=require('electron');
        const {writeFileSync}=require('node:fs');
        const {join}=require('node:path');
        app.setPath('userData',join(__dirname,'user-data'));
        app.whenReady().then(async()=>{
          const win=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{backgroundThrottling:false}});
          win.webContents.setAudioMuted(true);
          try {
            await win.loadFile(join(__dirname,'index.html'));
            const cases=await win.webContents.executeJavaScript('window.runLayoutCases()');
            writeFileSync(join(__dirname,'result.json'),JSON.stringify(cases));
            win.destroy();app.exit(0);
          } catch(error) { console.error(String(error));win.destroy();app.exit(1); }
        });
      `)
      const electron = createRequire(import.meta.url)('electron') as string
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      child = Bun.spawn([electron, join(dir, 'main.cjs')], { env, stdout: 'pipe', stderr: 'pipe' })
      const stdout = new Response(child.stdout).text()
      const stderr = new Response(child.stderr).text()
      const exit = await Promise.race([
        child.exited,
        new Promise<never>((_, reject) => { timer = setTimeout(() => { child!.kill(); reject(new Error('原生尺寸测试超时')) }, 30000) }),
      ])
      if (exit !== 0) throw new Error(`原生尺寸测试退出 ${exit}\n${await stdout}\n${await stderr}`)
      const cases = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'))
      expect(cases).toHaveLength(8)
      for (const result of cases) {
        const context = `素材 ${result.source.join('x')}，侧栏 ${result.pane.join('x')}`
        expect(result.inside, context).toBe(true)
        expect(result.noOverflow, context).toBe(true)
        expect(result.preview[0], context).toBeCloseTo(result.body[0], 0)
        expect(result.preview[1], context).toBeCloseTo(result.body[1], 0)
        expect(result.video[0], context).toBeGreaterThan(0)
        expect(result.video[1], context).toBeGreaterThan(0)
        expect(result.fit, context).toBe('contain')
        expect(result.sameElement && result.sameSource && result.controls && result.paused, context).toBe(true)
      }
    } finally {
      if (timer) clearTimeout(timer)
      if (child && child.exitCode === null) { child.kill(); await child.exited }
      await rm(dir, { recursive: true, force: true })
    }
  },
  40000,
)
