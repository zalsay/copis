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

      await client.cancel()
    } finally {
      client.stop()
    }
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
})
