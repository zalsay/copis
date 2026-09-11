import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const settingsSource = readFileSync(join(import.meta.dir, 'VoiceInputSettings.tsx'), 'utf8')
const settingsStyles = readFileSync(join(import.meta.dir, 'VoiceInputSettings.css'), 'utf8')
const settingsTypes = readFileSync(join(import.meta.dir, '..', '..', '..', 'types', 'settings.ts'), 'utf8')
const serviceSource = readFileSync(join(import.meta.dir, '..', '..', '..', 'main', 'lib', 'voice-dictation-settings-service.ts'), 'utf8')
const ipcSource = readFileSync(join(import.meta.dir, '..', '..', '..', 'main', 'ipc', 'voice-dictation.ipc.ts'), 'utf8')
const workingAtomsSource = readFileSync(join(import.meta.dir, '..', '..', 'atoms', 'working-atoms.ts'), 'utf8')
const speechButtonSource = readFileSync(join(import.meta.dir, '..', 'ai-elements', 'speech-button.tsx'), 'utf8')

describe('语音输入设置识别模式契约', () => {
  test('Given 语音输入设置页 When 渲染识别模式 Then 提供 HTTP API 与 Copis 大模型两张卡片', () => {
    expect(settingsSource).toContain('使用免费语音识别')
    expect(settingsSource).toContain('使用 Copis 语音识别大模型')
    expect(settingsSource).toContain('浏览器自带的语音识别')
    expect(settingsSource).toContain("update({ provider: 'http-api' })")
    expect(settingsSource).toContain("update({ provider: 'copis-model' })")
    expect(settingsSource).toContain('消耗钻石')
    expect(settingsStyles).toContain('.copis-voice-mode-card')
    expect(settingsStyles).toContain('.is-selected')
  })

  test('Given 免费语音识别模式 When 展示配置 Then 使用浏览器自带识别且不要求豆包凭证', () => {
    for (const legacyDoubaoUi of [
      '豆包 APP ID',
      'Access Token',
      'Resource ID',
      '测试连接',
      '火山引擎',
      '自定义热词',
      'volc.seedasr.sauc.duration',
    ] as const) {
      expect(settingsSource).not.toContain(legacyDoubaoUi)
    }
  })

  test('Given 识别模式 When 切换模式 Then 持久化 provider 且兼容旧 doubao 配置', () => {
    expect(settingsTypes).toContain("export type VoiceDictationProvider = 'http-api' | 'copis-model'")
    expect(serviceSource).toContain("provider: 'http-api'")
    expect(serviceSource).toContain("raw.provider === 'copis-model'")
  })

  test('Given Copis 大模型模式 When 启动或测试语音输入 Then 主进程阻止并给出明确提示', () => {
    expect(ipcSource).toContain("settings.provider === 'copis-model'")
    expect(ipcSource).toContain('Copis 语音识别大模型尚未接入')
  })

  test('Given 语音输入设置页 When 检查原接口 Then 保留设置与麦克风权限链路', () => {
    for (const contract of [
      'getVoiceDictationSettings',
      'updateVoiceDictationSettings',
      'checkMicrophonePermission',
      'requestMicrophonePermission',
    ] as const) {
      expect(settingsSource).toContain(contract)
    }
  })

  test('Given composer 语音按钮 When 语音输入未开启 Then 提示并可直接跳转到语音输入设置', () => {
    expect(speechButtonSource).toContain('请先在设置中打开语音输入开关')
    expect(speechButtonSource).toContain("setWorkingSettingsSection('voice-input')")
    expect(speechButtonSource).toContain('workingSettingsOpenAtom')
    expect(workingAtomsSource).toContain('workingSettingsSectionAtom')
  })

  test('Given 识别模式卡片 When 检查左上角图标与左下角胶囊 Then 采用全应用统一的柔和高雅底色', () => {
    // 左上角图标统一采用柔和高雅底色规范
    const iconRule = settingsStyles.match(/\.copis-voice-mode-card-icon\s*\{([^}]*)\}/s)?.[1]
    expect(iconRule).toBeDefined()
    expect(iconRule).toContain('background: hsl(var(--muted) / 0.8);')
    expect(iconRule).toContain('color: hsl(var(--foreground) / 0.8);')
    expect(iconRule).toContain('border: 1px solid hsl(var(--border) / 0.5);')

    // 左下角胶囊标签统一采用柔和高雅底色规范
    const badgeRule = settingsStyles.match(/\.copis-voice-mode-card-badge\s*\{([^}]*)\}/s)?.[1]
    expect(badgeRule).toBeDefined()
    expect(badgeRule).toContain('background: hsl(var(--muted) / 0.8);')
    expect(badgeRule).toContain('color: hsl(var(--foreground) / 0.8);')
    expect(badgeRule).toContain('border: 1px solid hsl(var(--border) / 0.5);')

    // 严禁在图标与胶囊中使用旧的高饱和 var(--ui-primary) / var(--ui-primary-background)
    expect(iconRule).not.toContain('var(--ui-primary)')
    expect(badgeRule).not.toContain('var(--ui-primary)')
  })
})

