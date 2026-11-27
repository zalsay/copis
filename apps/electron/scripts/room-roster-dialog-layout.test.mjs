import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { _electron } from 'playwright-core'
import postcss from 'postcss'
import tailwind from 'tailwindcss'
import loadConfig from 'tailwindcss/loadConfig.js'

// 使用隔离的隐藏窗口，只验证布局与交互；不读取用户配置或截屏。
test('群智能体弹窗适应会话区，长模型名不撑宽，键盘可在同层菜单选择后保存', { timeout: 45000 }, async () => {
  const cwd = resolve(import.meta.dirname, '..'), dir = await mkdtemp(join(tmpdir(), 'copis-roster-layout-'))
  let app
  try {
    await writeFile(join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(dir,'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1200,height:800,show:false,webPreferences:{backgroundThrottling:false}});w.loadFile(${JSON.stringify(join(dir,'test.html'))})})`)
    await writeFile(join(dir,'test.html'), '<!doctype html><html class="dark"><meta charset="utf-8"><link rel="stylesheet" href="test.css"><div id="pane" style="position:absolute;inset:0 0 0 240px;anchor-name:--copis-room-pane"></div><script src="fixture.js"></script></html>')
    const rc = await postcss([tailwind({ ...loadConfig(join(cwd,'tailwind.config.js')), content:[join(cwd,'src/renderer/components/{ui,dsh-group-chat}/*.{tsx,ts}')] })]).process(await readFile(join(cwd,'src/renderer/styles/globals.css'),'utf8'),{from:undefined})
    await writeFile(join(dir,'test.css'),rc.css)
    await build({
      absWorkingDir: cwd, tsconfig: 'tsconfig.json', entryPoints: ['scripts/test-fixtures/room-roster-layout.tsx'],
      jsx: 'automatic', bundle: true, outfile: join(dir, 'fixture.js'), define: {'process.env.NODE_ENV': '"production"'},
    })
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
    app=await _electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:[join(dir,'main.cjs')],cwd:dir,env})
    const page=await app.firstWindow();page.setDefaultTimeout(4500)
    const dialog=page.getByRole('dialog');await dialog.waitFor()
    for(const paneWidth of [900,340]) {
      await page.locator('#pane').evaluate((e,w)=>{e.style.width=w+'px';e.style.right='auto'},paneWidth)
      const [frame,pane]=await Promise.all([dialog.boundingBox(),page.locator('#pane').boundingBox()]);assert.ok(frame && pane)
      assert.ok(Math.abs(frame.width-Math.min(560,paneWidth-32))<1, `弹窗宽度 ${frame.width}，聊天区 ${paneWidth}`)
      assert.ok(Math.abs(frame.x+frame.width/2-pane.x-pane.width/2)<1,'应居中于聊天区')
      assert.ok(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth),'弹窗不应横向溢出')
    }
    const trigger=dialog.getByRole('combobox',{name:'本群回答模型'});const tb=await trigger.boundingBox();await trigger.focus();await trigger.press('ArrowDown')
    const menu=dialog.getByRole('listbox');await menu.waitFor();const item=menu.getByRole('option').first()
    assert.ok(await item.evaluate(e=>e.scrollWidth<=e.clientWidth),'长选项应换行')
    await menu.evaluate(async e=>{await new Promise(requestAnimationFrame);await Promise.all(e.getAnimations().map(a=>a.finished))});const box=await menu.boundingBox();assert.ok(box && tb && Math.abs(box.x-tb.x)<2 && Math.abs(box.width-tb.width)<2,`菜单应与触发器对齐: ${JSON.stringify({box,tb})}`)
    assert.ok(await menu.evaluate(e=>{const b=e.getBoundingClientRect();return e.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))}),'菜单不得被原生 dialog 遮挡')
    await page.keyboard.press('Escape');await menu.waitFor({state:'detached'});assert.equal(await page.getByRole('dialog',{name:'群智能体 · 测试群'}).count(),1)
    await trigger.press('ArrowDown');await menu.getByRole('option',{name:'快速模型'}).click();assert.equal(await page.evaluate(()=>window.writes.length),0)
    await dialog.getByRole('button',{name:'保存智能体'}).click();assert.equal(await page.evaluate(()=>window.writes[0]?.modelId),'m2')
    await page.locator('#pane').evaluate(e => { e.style.width = '900px' })
    const compact = await page.getByRole('dialog', {name:'紧凑弹窗'}).boundingBox()
    assert.equal(compact.width, 384, '其他弹窗仍然使用紧凑宽度')
  } finally { try { await app?.close() } finally { await rm(dir,{recursive:true,force:true}) } }
})
