import { describe, expect, it } from 'bun:test'
import { ChromeDesktopHelperClient, resolveHelperBinaryPath } from './chrome-desktop-helper-client'

describe('ChromeDesktopHelperClient', () => {
  it('resolves binary path on macOS', () => {
    if (process.platform === 'darwin') {
      const path = resolveHelperBinaryPath({ isPackaged: false })
      expect(path).not.toBeNull()
      expect(typeof path).toBe('string')
    }
  })

  it('runs checkPermissions and listWindows against compiled helper on macOS', async () => {
    if (process.platform !== 'darwin') return

    const client = new ChromeDesktopHelperClient()
    expect(client.isAvailable()).toBe(true)

    try {
      const perms = await client.checkPermissions()
      expect(perms).toBeDefined()
      expect(typeof perms.accessibility).toBe('boolean')
      expect(typeof perms.screenRecording).toBe('boolean')
      expect(perms.helperPath).toContain('chrome-desktop-helper')

      const windows = await client.listWindows()
      expect(Array.isArray(windows)).toBe(true)

    } finally {
      client.stop()
    }
  })

  it('Given stdin EOF When the main RunLoop is running Then helper exits without an orphan process', async () => {
    if (process.platform !== 'darwin') return
    const { spawnSync } = await import('node:child_process')
    const binary = resolveHelperBinaryPath({ isPackaged: false })
    if (!binary) throw new Error('Chrome helper 尚未构建')
    const result = spawnSync(binary, [], { input: '', encoding: 'utf8', timeout: 2000 })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('stdin EOF')
  })

  it('Scenario: Asynchronous cancellation during long operation resolves cancel immediately and returns CHROME_CANCELLED for in-flight command', async () => {
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { writeFileSync, unlinkSync } = await import('node:fs')

    const tmpScript = join(tmpdir(), `mock-helper-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sh`)
    const nodeCode = [
      "const readline = require('readline');",
      "const rl = readline.createInterface({ input: process.stdin });",
      "let cancelled = false;",
      "let pendingTypeId = null;",
      "rl.on('line', (line) => {",
      "  if (!line.trim()) return;",
      "  const msg = JSON.parse(line.trim());",
      "  if (msg.action === 'cancel') {",
      "    cancelled = true;",
      "    process.stdout.write(JSON.stringify({ id: msg.id, ok: true, data: { status: 'cancelled' } }) + '\\n');",
      "    if (pendingTypeId) {",
      "      process.stdout.write(JSON.stringify({ id: pendingTypeId, ok: false, error: 'CHROME_CANCELLED' }) + '\\n');",
      "      pendingTypeId = null;",
      "    }",
      "    return;",
      "  }",
      "  if (msg.action === 'list_windows') {",
      "    process.stdout.write(JSON.stringify({ id: msg.id, ok: true, windows: [] }) + '\\n');",
      "    return;",
      "  }",
      "  if (msg.action === 'type') {",
      "    pendingTypeId = msg.id;",
      "    setTimeout(() => {",
      "      if (pendingTypeId === msg.id) {",
      "        process.stdout.write(JSON.stringify({ id: msg.id, ok: !cancelled, error: cancelled ? 'CHROME_CANCELLED' : undefined }) + '\\n');",
      "        pendingTypeId = null;",
      "      }",
      "    }, 400);",
      "  }",
      "});",
    ].join(' ')

    const shScript = `#!/bin/sh\nexec node -e "${nodeCode.replace(/"/g, '\\"')}"\n`
    writeFileSync(tmpScript, shScript, { mode: 0o755 })

    const client = new ChromeDesktopHelperClient(tmpScript)
    try {
      // 预热进程，确保进程启动完成后再发起操作
      await client.listWindows()

      const typePromise = client.type(101, 2001, '很长的一段文字输入...')

      // 短暂延时后发送 cancel
      await new Promise((r) => setTimeout(r, 60))
      const cancelStart = Date.now()
      await client.cancel()
      const cancelTime = Date.now() - cancelStart

      // cancel 在主线程即时响应，必须迅速返回 (< 200ms)
      expect(cancelTime).toBeLessThan(200)

      // 原 type 请求必须收敛并返回 CHROME_CANCELLED
      const typeRes = await typePromise
      expect(typeRes.ok).toBe(false)
      expect(typeRes.error).toBe('CHROME_CANCELLED')
    } finally {
      client.stop()
      try {
        unlinkSync(tmpScript)
      } catch {}
    }
  })

  it('Given helper command stalls When deadline expires Then terminate the owned process', async () => {
    const { mkdtempSync, writeFileSync, existsSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const directory = mkdtempSync(join(tmpdir(), 'copis-helper-timeout-'))
    const path = join(directory, 'helper.js')
    writeFileSync(path, `#!${process.execPath}
process.on('SIGTERM', () => process.exit(0))
process.stdin.on('data', () => {})
`, { mode: 0o755 })
    const client = new ChromeDesktopHelperClient(path, 80)
    try {
      await expect(client.listWindows()).rejects.toThrow('超时')
      await expect(client.start()).resolves.toBeUndefined()
    } finally { client.stop(); rmSync(directory, {recursive:true, force:true}) }
  })

  it('Given an old child exits after restart Then keep the replacement helper usable', async () => {
    const { mkdtempSync, writeFileSync, existsSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const directory = mkdtempSync(join(tmpdir(), 'copis-helper-restart-'))
    const path = join(directory, 'helper.js')
    const marker = join(directory, 'started')
    const exited = join(directory, 'old-exited')
    writeFileSync(path, `#!${process.execPath}
const fs=require('fs'); const first=!fs.existsSync(${JSON.stringify(marker)});
fs.writeFileSync(${JSON.stringify(marker)},'ready');
process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(${JSON.stringify(exited)},'done');process.exit(0)},200));
if(first) setInterval(()=>{},1000);
require('readline').createInterface({input:process.stdin}).on('line',line=>{
  const command=JSON.parse(line);
  const reply=()=>process.stdout.write(JSON.stringify({id:command.id,ok:true,accessibility:true,windows:[]})+'\\n');
  if(command.action==='list_windows' && !first) setTimeout(reply,400); else reply()
});
`, {mode:0o755})
    const client=new ChromeDesktopHelperClient(path)
    try {
      await client.checkPermissions()
      client.stop()
      await client.checkPermissions()
      const pending = client.listWindows()
      const result = pending.then((windows) => ({ windows }), (error: Error) => ({ error: error.message }))
      const deadline=Date.now()+2000
      while(!existsSync(exited) && Date.now()<deadline) await Bun.sleep(10)
      expect(existsSync(exited)).toBe(true)
      expect(await result).toEqual({ windows: [] })
    } finally { client.stop(); await Bun.sleep(250); rmSync(directory,{recursive:true,force:true}) }
  })
})
