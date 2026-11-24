import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

test.skipIf(process.platform === 'linux' && !process.env.DISPLAY)(
  'Given 真实插件与隔离 preload When 点击 DSH 更多 Then 原生点击和弹层均不被接管且显式 Copis 入口保留',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'copis-native-more-'))
    let child: ReturnType<typeof Bun.spawn> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const renderer = await Bun.build({ entrypoints: [join(import.meta.dir, 'test-fixtures/native-more.tsx')], outdir: dir, target: 'browser', format: 'iife' })
      const preload = await Bun.build({ entrypoints: [join(import.meta.dir, '../../../src/preload/dsh-bridge-preload.ts')], target: 'node', format: 'cjs', external: ['electron'] })
      if (!renderer.success || !preload.success) throw new Error('原生更多回归入口构建失败')
      await writeFile(join(dir, 'preload.cjs'), await preload.outputs[0].text())
      await writeFile(join(dir, 'index.html'), '<!doctype html><html><body><aside id="root" class="hHd-Xa_root" style="width:280px;height:800px"></aside><script src="native-more.js"></script></body></html>')
      await writeFile(join(dir, 'main.cjs'), `
        const {app,BrowserWindow,ipcMain}=require('electron');
        const {writeFileSync}=require('node:fs');
        const {join}=require('node:path');
        const events=[];
        app.setPath('userData',join(__dirname,'user-data'));
        ipcMain.handle('settings:get',()=>({themeMode:'light',hiddenSidebarMenuItems:[]}));
        ipcMain.handle('settings:get-system-theme',()=>false);
        ipcMain.on('dsh-cordis:client-event',(_event,payload)=>events.push(payload));
        app.whenReady().then(async()=>{
          const win=new BrowserWindow({show:false,width:900,height:900,webPreferences:{preload:join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
          try {
            await win.loadFile(join(__dirname,'index.html'));
            const cases=await win.webContents.executeJavaScript('window.runMoreCases()');
            const waitForTag = tag => new Promise(resolve => {
              const listener = (_, e) => { if (e.tab === tag) { ipcMain.off('dsh-cordis:client-event', listener); resolve(); } };
              ipcMain.on('dsh-cordis:client-event', listener);
            });
            const send = id => win.webContents.send('dsh-cordis:dispatch-to-client', {type:'COPIS_DSH_NEW_SESSION',requestId:id});
            const mount = async () => { const ready = waitForTag('dsh-client-ready'); await win.webContents.executeJavaScript('window.mountNavigationFixture()'); await ready; };
            const deliver = async id => { const ack = waitForTag('dsh-session-accepted:'+id); send(id); await ack; };
            send('cold'); await mount(); await deliver('cold');
            await win.loadFile(join(__dirname,'index.html')); await mount(); await deliver('cold'); await deliver('next');
            const starts = await win.webContents.executeJavaScript('Number(sessionStorage.fixtureStarts)');
            writeFileSync(join(__dirname,'result.json'),JSON.stringify({cases,events,starts}));
            win.destroy();app.exit(0);
          } catch(error) { console.error(String(error));win.destroy();app.exit(1); }
        });
      `)
      const electron = createRequire(import.meta.url)('electron') as string
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      child = Bun.spawn([electron, join(dir, 'main.cjs')], { env, stdout: 'pipe', stderr: 'pipe' })
      const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text()
      const exit = await Promise.race([child.exited, new Promise<never>((_, reject) => { timer = setTimeout(() => { child!.kill(); reject(new Error('原生更多测试超时')) }, 30000) })])
      if (exit !== 0) throw new Error(`原生更多测试退出 ${exit}\n${await stdout}\n${await stderr}`)
      const { cases, events, starts } = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'))
      expect(starts).toBe(2)
      expect(cases).toHaveLength(2)
      for (const result of cases) {
        if (result.wide) {
          expect(result.heading?.font).toBe('14px')
          expect(result.heading?.iconWidth).toBeGreaterThan(0)
          expect(result.heading).toEqual(result.settings)
          expect(result.item.iconLeft - result.heading.iconLeft).toBe(16)
          expect(result.toggle.iconLeft - result.heading.iconLeft).toBe(16)
        } else {
          expect(result.item.iconLeft).toBe(result.settings.iconLeft)
        }
        expect(result.nativeOpenedOnce, `侧栏展开=${result.wide}`).toBe(true)
        expect(result.prevented).toBe(false)
        expect(result.menuVisible).toBe(true)
        expect(result.panelVisible).toBe(true)
        expect(result.overlayVisible).toBe(true)
        expect(result.copisSubviewActive).toBe(false)
      }
      expect(events.filter((e: { type: string }) => e.type === 'COPIS_OPEN_SETTINGS')).toHaveLength(1)
      expect(events.filter((e: { type: string }) => e.type === 'COPIS_SWITCH_MODE')).toHaveLength(0)
    } finally {
      if (timer) clearTimeout(timer)
      if (child && child.exitCode === null) { child.kill(); await child.exited }
      await rm(dir, { recursive: true, force: true })
    }
  },
  40000,
)
