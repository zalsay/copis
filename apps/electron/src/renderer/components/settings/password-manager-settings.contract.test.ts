import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const settingsRoot = import.meta.dir
const componentPath = join(settingsRoot, 'PasswordManagerSettings.tsx')
const componentSource = readFileSync(componentPath, 'utf8')
const panelSource = readFileSync(join(settingsRoot, '..', 'app-shell', 'CopisWorkingSettingsPanel.tsx'), 'utf8')
const webBrowserSurfaceSource = readFileSync(join(settingsRoot, '..', 'web-browser', 'WebBrowserSurface.tsx'), 'utf8')
const preloadSource = readFileSync(join(settingsRoot, '..', '..', '..', 'preload', 'index.ts'), 'utf8')

describe('PasswordManagerSettings Contract', () => {
  test('component exists and exports PasswordManagerSettings', () => {
    expect(existsSync(componentPath)).toBe(true)
    expect(componentSource).toContain('export function PasswordManagerSettings')
  })

  test('calls required webPasswords electronAPI methods', () => {
    const requiredApis = [
      'webPasswords.list',
      'webPasswords.getSettings',
      'webPasswords.updateSettings',
      'webPasswords.reveal',
      'webPasswords.remove',
      'webPasswords.listDisabledOrigins',
      'webPasswords.removeDisabledOrigin',
    ]

    for (const api of requiredApis) {
      expect(preloadSource).toContain(api.split('.')[1]!)
    }
  })

  test('contains UI elements for switches, search, copy and reveal', () => {
    expect(componentSource).toContain('提示保存密码')
    expect(componentSource).toContain('自动填充密码')
    expect(componentSource).toContain('offerToSavePasswords')
    expect(componentSource).toContain('autoFillPasswords')
    expect(componentSource).toContain('已保存的密码')
    expect(componentSource).toContain('从不保存密码的网站')
    expect(componentSource).toContain('handleToggleReveal')
    expect(componentSource).toContain('handleCopyPassword')
    expect(componentSource).toContain('handleDelete')
  })

  test('CopisWorkingSettingsPanel integrates PasswordManagerSettings', () => {
    expect(panelSource).toContain("id: 'passwords'")
    expect(panelSource).toContain("label: '密码管理'")
    expect(panelSource).toContain('<PasswordManagerSettings />')
  })

  test('WebBrowserSurface integrates WebPasswordPromptBanner and WebPasswordKeyPopover', () => {
    expect(webBrowserSurfaceSource).toContain('WebPasswordPromptBanner')
    expect(webBrowserSurfaceSource).toContain('WebPasswordKeyPopover')
    expect(webBrowserSurfaceSource).toContain('onPromptChanged')
  })
})
