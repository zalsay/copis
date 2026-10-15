import { describe, expect, it, mock, beforeAll } from 'bun:test'

mock.module('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
    getName: () => 'Copis',
  },
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: () => null,
  },
  ipcMain: {
    handle: () => {},
    on: () => {},
  },
  dialog: {},
  clipboard: {
    readText: () => '',
    writeText: () => {},
  },
  nativeImage: {},
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  },
  session: {
    defaultSession: {},
  },
  desktopCapturer: {
    getSources: async () => [],
  },
  systemPreferences: {
    getMediaAccessStatus: () => 'granted',
  },
  shell: {
    openExternal: async () => {},
  },
  nativeTheme: {
    on: () => {},
  },
}))

mock.module('../index', () => ({
  getMainWindow: () => null,
}))

describe('voice-dictation-window desktop capture validation', () => {
  let validateDisplayMediaFrame: typeof import('./voice-dictation-window').validateDisplayMediaFrame
  let matchDesktopCaptureWindowSource: typeof import('./voice-dictation-window').matchDesktopCaptureWindowSource

  beforeAll(async () => {
    const mod = await import('./voice-dictation-window')
    validateDisplayMediaFrame = mod.validateDisplayMediaFrame
    matchDesktopCaptureWindowSource = mod.matchDesktopCaptureWindowSource
  })

  describe('validateDisplayMediaFrame', () => {
    it('rejects null or undefined frame', () => {
      expect(validateDisplayMediaFrame(null, 10)).toBe(false)
      expect(validateDisplayMediaFrame(undefined, 10)).toBe(false)
    })

    it('rejects subframe requests (frame.parent !== null)', () => {
      const subFrame = {
        parent: { id: 1 },
        webContents: { id: 10 },
      }
      expect(validateDisplayMediaFrame(subFrame, 10)).toBe(false)
    })

    it('rejects top frame if webContents.id does not match expected window', () => {
      const topFrameOther = {
        parent: null,
        webContents: { id: 99 },
      }
      expect(validateDisplayMediaFrame(topFrameOther, 10)).toBe(false)
    })

    it('accepts top frame with matching webContents.id', () => {
      const topFrameValid = {
        parent: null,
        webContents: { id: 10 },
      }
      expect(validateDisplayMediaFrame(topFrameValid, 10)).toBe(true)
    })

    it('supports frame with webContentsId property', () => {
      const frameWithId = {
        parent: null,
        webContentsId: 10,
      }
      expect(validateDisplayMediaFrame(frameWithId, 10)).toBe(true)
    })
  })

  describe('matchDesktopCaptureWindowSource', () => {
    it('returns exact matching window source by structure', () => {
      const sources = [
        { id: 'screen:0:0', name: 'Entire Screen' },
        { id: 'window:12:0', name: 'Other Window' },
        { id: 'window:123:0', name: 'Google Chrome - Target' },
        { id: 'window:1234:0', name: 'Another Chrome Window' },
      ]

      const matched = matchDesktopCaptureWindowSource(sources, 123)
      expect(matched).not.toBeNull()
      expect(matched?.id).toBe('window:123:0')
      expect(matched?.name).toBe('Google Chrome - Target')
    })

    it('does NOT fuzzy match window IDs (prevents window:12 or window:1234 matching 123)', () => {
      const sources = [
        { id: 'window:12:0', name: 'Window 12' },
        { id: 'window:1234:0', name: 'Window 1234' },
      ]

      const matched = matchDesktopCaptureWindowSource(sources, 123)
      expect(matched).toBeNull()
    })

    it('ignores screen sources even if ID contains target number', () => {
      const sources = [
        { id: 'screen:123:0', name: 'Screen 123' },
      ]

      const matched = matchDesktopCaptureWindowSource(sources, 123)
      expect(matched).toBeNull()
    })

    it('handles empty or malformed source IDs gracefully', () => {
      const sources = [
        { id: '', name: 'Empty' },
        { id: 'invalid', name: 'Invalid' },
        { id: 'window:', name: 'No parts' },
      ]

      const matched = matchDesktopCaptureWindowSource(sources, 123)
      expect(matched).toBeNull()
    })
  })
})
