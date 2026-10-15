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
})
