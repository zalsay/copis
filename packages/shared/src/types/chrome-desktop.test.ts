import { describe, expect, it } from 'bun:test'
import {
  CHROME_DESKTOP_ALLOWED_KEYS,
  CHROME_DESKTOP_DEFAULT_SHORTCUT,
  CHROME_DESKTOP_ENDPOINT,
  CHROME_DESKTOP_IPC_CHANNELS,
  type ChromeDesktopErrorCode,
  type ChromeDesktopState,
  type ChromeDesktopToolName,
} from './chrome-desktop'

describe('chrome-desktop shared types and constants', () => {
  it('defines correct endpoint and default shortcut', () => {
    expect(CHROME_DESKTOP_ENDPOINT).toBe('/api/internal/agent/chrome-desktop-tool')
    expect(CHROME_DESKTOP_DEFAULT_SHORTCUT).toBe('Control+Option+Command+.')
  })

  it('defines allowed key whitelist covering common navigation and editing', () => {
    expect(CHROME_DESKTOP_ALLOWED_KEYS).toContain('Enter')
    expect(CHROME_DESKTOP_ALLOWED_KEYS).toContain('Tab')
    expect(CHROME_DESKTOP_ALLOWED_KEYS).toContain('Cmd+L')
    expect(CHROME_DESKTOP_ALLOWED_KEYS).toContain('Cmd+A')
    expect(CHROME_DESKTOP_ALLOWED_KEYS).toContain('Escape')
    expect(CHROME_DESKTOP_ALLOWED_KEYS.length).toBe(21)
  })

  it('defines IPC channels with unique channel names', () => {
    const values = Object.values(CHROME_DESKTOP_IPC_CHANNELS)
    const uniqueValues = new Set(values)
    expect(uniqueValues.size).toBe(values.length)
    expect(CHROME_DESKTOP_IPC_CHANNELS.CHECK_STATUS).toBe('chrome-desktop:check-status')
    expect(Object.keys(CHROME_DESKTOP_IPC_CHANNELS)).not.toContain('REQUEST_FRAME')
  })

  it('verifies state and error code types compile cleanly', () => {
    const state: ChromeDesktopState = 'active'
    const err: ChromeDesktopErrorCode = 'CHROME_BUSY'
    const tool: ChromeDesktopToolName = 'ChromeDesktopObserve'
    expect(state).toBe('active')
    expect(err).toBe('CHROME_BUSY')
    expect(tool).toBe('ChromeDesktopObserve')
  })
})
