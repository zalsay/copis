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
      await writeFile(join(dir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><aside id="root" class="hHd-Xa_root" style="width:280px;height:800px"></aside><script src="native-more.js"></script></body></html>')
      await writeFile(join(dir, 'main.cjs'), `
        const {app,BrowserWindow,ipcMain}=require('electron');
        const {writeFileSync}=require('node:fs');
        const {join}=require('node:path');
        const events=[];
        app.setPath('userData',join(__dirname,'user-data'));
        let settings={themeMode:'light',creationThemeColor:'#166534',hiddenSidebarMenuItems:['schedule','memory']};
        ipcMain.handle('settings:get',()=>settings);
        ipcMain.handle('settings:update',(_event,updates)=>(settings={...settings,...updates}));
        ipcMain.handle('settings:get-system-theme',()=>false);
        ipcMain.on('dsh-cordis:client-event',(_event,payload)=>events.push(payload));
        app.whenReady().then(async()=>{
          const win=new BrowserWindow({show:false,width:900,height:900,webPreferences:{preload:join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
          try {
            await win.loadFile(join(__dirname,'index.html'));
            const {cases,subviewSidebar}=await win.webContents.executeJavaScript('window.runMoreCases()');
            const points = await win.webContents.executeJavaScript('window.mountRoomPaintFixture()');
            const read = async (fn,...args) => win.webContents.executeJavaScript('('+fn+')(...'+JSON.stringify(args)+')');
            const paint = selector => read(sel=>getComputedStyle(document.querySelector('#room-paint '+sel)).backgroundColor,selector);
            const rowPaint=[];
            win.webContents.debugger.attach();
            for (const token of ['rgba(38, 49, 72, 0.06)','rgba(255, 255, 255, 0.08)']) {
              await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:850,y:800});
              await read(t=>{const host=document.querySelector('#room-paint');host.style.setProperty('--dsw-alias-interactive-bg-hover',t);host.querySelector('[data-active]').dataset.active='true'},token);
              const paints=[await paint('.YDXeBa_selected'),await paint('.copis-room-row')];
              await read(()=>{document.querySelector('#room-paint [data-active]').dataset.active='false'});
              const children=[];
              for(const [i,selector] of ['.copis-room-toggle','.copis-room-heading .copis-room-action','.copis-room-row','.copis-room-row'].entries()) {
                await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...points[i]});
                paints.push(await paint(selector));
                if(i>=2) children.push(await paint(i===2 ? '.copis-room-row > button' : '.copis-room-more'));
              }
              await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:850,y:800});
              await read(()=>{document.querySelector('#room-paint .copis-room-more').focus();document.querySelector('#room-paint .copis-room-heading .copis-room-action').setAttribute('aria-expanded','true')});
              paints.push(await paint('.copis-room-row'),await paint('.copis-room-heading .copis-room-action'));
              await read(()=>{document.activeElement.blur();document.querySelector('#room-paint .copis-room-heading .copis-room-action').setAttribute('aria-expanded','false')});
              const gap=await read(()=>{const r=document.querySelector('#room-paint');return r.querySelector('.copis-room-row').getBoundingClientRect().top-r.querySelector('.copis-room-heading').getBoundingClientRect().bottom});
              const spacing=await read(()=>{
                const slot=document.querySelector('#room-paint .copis-room-unread-slot');
                const label=slot.nextElementSibling, dot=slot.firstElementChild;
                const start=label.getBoundingClientRect().left;
                const result={width:slot.getBoundingClientRect().width,gap:start-dot.getBoundingClientRect().right};
                dot.remove(); const readStart=label.getBoundingClientRect().left; slot.append(dot);
                return {...result,shift:readStart-start};
              });
              rowPaint.push({token,paints,children,gap,spacing});
            }
            win.webContents.debugger.detach();
            await read(()=>document.querySelector('#room-paint').remove());
            const pinSettings=await win.webContents.executeJavaScript(\`(async()=>{
              const initial=await window.copisBridge.getPinnedMenuItems();
              await window.copisBridge.setPinnedMenuItems(['search','memory','memory']);
              const pinned=await window.copisBridge.getPinnedMenuItems();
              await window.copisBridge.setPinnedMenuItems([]);
              return {initial,pinned,cleared:await window.copisBridge.getPinnedMenuItems()};
            })()\`);
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
            writeFileSync(join(__dirname,'result.json'),JSON.stringify({cases,subviewSidebar,pinSettings,events,starts,rowPaint}));
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
      const { cases, subviewSidebar, pinSettings, events, starts, rowPaint } = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'))
      expect(subviewSidebar).toEqual({
        sidebarWidth: 280, leftInset: 8, rightInset: 8,
        returnLabel: '"返回会话"', maskLabel: 'none', shortcut: '"Esc"',
      })
      expect(pinSettings).toEqual({ initial: ['search', 'automations'], pinned: ['search', 'memory'], cleared: [] })
      expect(starts).toBe(2)
      expect(cases).toHaveLength(2)
      for (const { token, paints, children, gap, spacing } of rowPaint) {
        // 目录标题悬停透明；工作区选中行、加号与群行继续使用次要底色。
        expect(paints).toEqual([token, token, 'rgba(0, 0, 0, 0)', token, token, token, token, token])
        expect(children).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'])
        expect(gap).toBe(6)
        expect(spacing.width).toBe(8)
        expect(spacing.gap).toBeGreaterThanOrEqual(8)
        expect(spacing.gap).toBeLessThanOrEqual(9)
        expect(spacing.shift).toBe(0)
      }
      for (const result of cases) {
        expect(result.aggregateDot.width, `侧栏展开=${result.wide} 的聚合红点宽度`).toBe(7)
        expect(result.aggregateDot.height).toBe(7)
        if (result.wide) for (const layout of result.aggregateDot.titleLayout) {
          expect(layout.gap).toBeGreaterThanOrEqual(8)
          expect(layout.gap).toBeLessThanOrEqual(9)
          expect(layout.lines).toBe(1)
          expect(layout.sameLine).toBe(true)
        }
        expect(result.groupBelowWorkspaces, '群聊应独立位于工作区下方，不落入网格留白列').toBe(true)
        if (result.wide) {
          expect(result.focusedMenuColor).toBe('rgb(22, 101, 52)')
          expect(result.focusedMenuFill).toBe('rgba(22, 101, 52, 0.15)')
          expect(result.menuFitsWorkspace, '菜单应占用工作区内容列且不能与工作区重叠').toBe(true)
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
      expect(events.filter((e: { type: string }) => e.type === 'COPIS_DSH_SIDEBAR_INFO').map((e: { width: number }) => e.width)).toEqual([280, 400])
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
