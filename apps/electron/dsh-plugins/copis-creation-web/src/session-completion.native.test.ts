import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

test.skipIf(process.platform === 'linux' && !process.env.DISPLAY)(
  'Given 真实隔离 preload 和完成监听 When DSH 结束及收到通知导航 Then 跨 IPC 仅上报一次并走官方会话入口',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'copis-completion-native-'))
    let child: ReturnType<typeof Bun.spawn> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const renderer = await Bun.build({ entrypoints: [join(import.meta.dir, 'test-fixtures/session-completion.ts')], outdir: dir, target: 'browser', format: 'iife' })
      const preload = await Bun.build({ entrypoints: [join(import.meta.dir, '../../../src/preload/dsh-bridge-preload.ts')], target: 'node', format: 'cjs', external: ['electron'] })
      if (!renderer.success || !preload.success) throw new Error('完成通知回归入口构建失败')
      await writeFile(join(dir, 'preload.cjs'), await preload.outputs[0].text())
      await writeFile(join(dir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><script src="session-completion.js"></script></body></html>')
      await writeFile(join(dir, 'main.cjs'), `
        const {app,BrowserWindow,ipcMain}=require('electron');
        const {writeFileSync}=require('node:fs');const {join}=require('node:path');const events=[];
        app.setPath('userData',join(__dirname,'user-data'));
        ipcMain.handle('settings:get',()=>({themeMode:'light',hiddenSidebarMenuItems:[]}));
        ipcMain.handle('settings:get-system-theme',()=>false);
        ipcMain.on('dsh-cordis:client-event',(_event,payload)=>events.push(payload));
        app.whenReady().then(async()=>{
          const win=new BrowserWindow({show:false,webPreferences:{preload:join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
          try {
            await win.loadFile(join(__dirname,'index.html'));
            await win.webContents.executeJavaScript('window.runCompletionCases()');
            win.webContents.send('dsh-cordis:dispatch-to-client',{type:'COPIS_DSH_OPEN_SESSION',sessionId:'native-test'});
            await new Promise(resolve=>setTimeout(resolve,100));
            const state=await win.webContents.executeJavaScript('({opened:window.completionOpened,remaining:window.disposeCompletion()})');
            writeFileSync(join(__dirname,'result.json'),JSON.stringify({events,state}));win.destroy();app.exit(0);
          } catch(error) {console.error(String(error));win.destroy();app.exit(1);}
        });
      `)
      const electron = createRequire(import.meta.url)('electron') as string
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      child = Bun.spawn([electron, join(dir, 'main.cjs')], { env, stdout: 'pipe', stderr: 'pipe' })
      const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text()
      const exit = await Promise.race([child.exited, new Promise<never>((_, reject) => { timer = setTimeout(() => { child!.kill(); reject(new Error('完成通知原生测试超时')) }, 30000) })])
      if (exit !== 0) throw new Error(`完成通知原生测试退出 ${exit}\n${await stdout}\n${await stderr}`)
      const result = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'))
      expect(result.events.filter((event: { type: string }) => event.type === 'COPIS_DSH_SESSION_COMPLETED')).toEqual([
        { type: 'COPIS_DSH_SESSION_COMPLETED', sessionId: 'native-test', title: 'Electron 完成回归', completionSeq: 10, viewed: false, windowFocused: false },
      ])
      expect(result.state).toEqual({ opened: ['native-test'], remaining: 0 })
      expect(result.events).toContainEqual({ type: 'COPIS_NAVIGATE', view: 'conversations' })
    } finally {
      if (timer) clearTimeout(timer)
      if (child && child.exitCode === null) { child.kill(); await child.exited }
      await rm(dir, { recursive: true, force: true })
    }
  }, 40000,
)
