import { describe, expect, test, afterEach, beforeEach, afterAll, mock } from 'bun:test'
import { existsSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSettingsPath } from './config-paths'
import { getSettings, updateSettings } from './settings-service'

const tempRoot = mkdtempSync(join(tmpdir(), 'copis-settings-test-'))
mock.module('./config-paths', () => ({ getSettingsPath: () => join(tempRoot, 'settings.json') }))
mock.module('electron', () => ({ app: { isPackaged: true } }))
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }))

describe('settings-service appMode 持久化与归一化', () => {
  let originalSettings: string | undefined

  beforeEach(() => {
    const settingsPath = getSettingsPath()
    originalSettings = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : undefined
  })

  afterEach(() => {
    const settingsPath = getSettingsPath()
    if (originalSettings !== undefined) {
      writeFileSync(settingsPath, originalSettings, 'utf-8')
    } else if (existsSync(settingsPath)) {
      rmSync(settingsPath, { force: true })
    }
  })

  test('Given settings 文件不存在或无 appMode When 读取 getSettings Then 默认返回 agent 模式', () => {
    const settingsPath = getSettingsPath()
    writeFileSync(settingsPath, JSON.stringify({ themeMode: 'dark' }), 'utf-8')

    const settings = getSettings()
    expect(settings.appMode).toBe('agent')
  })

  test('Given settings 中保存了 creation 模式 When 读取 getSettings Then 返回 creation 模式', () => {
    const settingsPath = getSettingsPath()
    writeFileSync(settingsPath, JSON.stringify({ appMode: 'creation', themeMode: 'dark' }), 'utf-8')

    const settings = getSettings()
    expect(settings.appMode).toBe('creation')
  })

  test('Given 调用 updateSettings 更新为 creation 模式 When 读取 settings.json Then 成功持久化 creation 字段', () => {
    updateSettings({ appMode: 'creation' })

    const settings = getSettings()
    expect(settings.appMode).toBe('creation')

    const fileContent = JSON.parse(readFileSync(getSettingsPath(), 'utf-8'))
    expect(fileContent.appMode).toBe('creation')
  })

  test('Given 调用 updateSettings 传入非法值 When 持久化 Then 安全归一化为 agent 模式', () => {
    updateSettings({ appMode: 'invalid-mode' as unknown as 'agent' })

    const settings = getSettings()
    expect(settings.appMode).toBe('agent')

    const fileContent = JSON.parse(readFileSync(getSettingsPath(), 'utf-8'))
    expect(fileContent.appMode).toBe('agent')
  })
})
