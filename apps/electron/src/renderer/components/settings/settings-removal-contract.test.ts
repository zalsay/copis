import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const rendererRoot = join(import.meta.dir, '..', '..')
const appShellSource = readFileSync(join(rendererRoot, 'components/app-shell/AppShell.tsx'), 'utf8')
const workingPanelSource = readFileSync(join(rendererRoot, 'components/app-shell/CopisWorkingSettingsPanel.tsx'), 'utf8')
const appSource = readFileSync(join(rendererRoot, 'App.tsx'), 'utf8')
const onboardingSource = readFileSync(join(rendererRoot, 'components/onboarding/OnboardingView.tsx'), 'utf8')
const tabAtomsSource = readFileSync(join(rendererRoot, 'atoms/tab-atoms.ts'), 'utf8')
const tabBarSource = readFileSync(join(rendererRoot, 'components/tabs/TabBar.tsx'), 'utf8')
const tabContentSource = readFileSync(join(rendererRoot, 'components/tabs/TabContent.tsx'), 'utf8')

const productionSources = [
  join(rendererRoot, 'components/agent-skills/AgentSkillsView.tsx'),
  join(rendererRoot, 'components/agent/AgentConversationSurface.tsx'),
  join(rendererRoot, 'components/agent/SDKMessageRenderer.tsx'),
  join(rendererRoot, 'components/shortcuts/GlobalShortcuts.tsx'),
  join(rendererRoot, 'hooks/useOpenSession.ts'),
  join(rendererRoot, 'components/app-shell/AppShell.tsx'),
].map((filePath) => readFileSync(filePath, 'utf8'))

describe('本地设置旧入口清理契约', () => {
  test('Given 应用 Shell When 检查设置宿主 Then 本地 SettingsPanel 和 settings-tab 不再是生产入口', () => {
    expect(existsSync(join(rendererRoot, 'components/settings/SettingsPanel.tsx'))).toBe(false)
    expect(existsSync(join(rendererRoot, 'atoms/settings-tab.ts'))).toBe(false)
    expect(existsSync(join(rendererRoot, 'components/tutorial/TutorialBanner.tsx'))).toBe(false)
    expect(appShellSource).not.toContain("from '@/components/settings/SettingsPanel'")
    expect(appShellSource).not.toContain('settingsOpenAtom')

    for (const source of productionSources) {
      expect(source).not.toContain("from '@/atoms/settings-tab'")
    }
  })

  test('Given 设置菜单 When 检查旧页面 Then 本地旧设置移除且 Working 教程入口可用', () => {
    for (const legacyLabel of [
      '通用设置',
      '模型配置',
      '视觉助手',
      '提示词管理',
      '代理设置',
      'Agent 工具',
      '远程连接',
      '快捷键管理',
      '关于/更新',
      'Copis 教程',
    ] as const) {
      expect(workingPanelSource).not.toContain(legacyLabel)
    }

    for (const source of [appSource, onboardingSource]) {
      expect(source).not.toContain('TutorialBanner')
    }

    expect(workingPanelSource).toContain('查看使用教程')
    expect(workingPanelSource).toContain('handleOpenTutorial')
    expect(tabAtomsSource).toContain('TUTORIAL_TAB_ID')
    expect(tabAtomsSource).toContain("type: 'tutorial'")
    expect(tabContentSource).toContain('TutorialTabContent')
    expect(tabContentSource).toContain('getTutorialContent')

    for (const source of [tabBarSource]) {
      expect(source).not.toContain('TutorialTabContent')
    }
  })

  test('Given 四个迁移页面 When 检查原接口 Then 页面和文件关联导入链路仍存在', () => {
    const pageContracts = [
      ['VoiceInputSettings.tsx', ['getVoiceDictationSettings', 'updateVoiceDictationSettings', 'checkMicrophonePermission', 'requestMicrophonePermission']],
      ['MigrationSettings.tsx', ['migrationExportV2', 'migrationGetShareExportPreview', 'migrationSaveFileDialog']],
      ['StorageSettings.tsx', ['getStorageStats', 'cleanupStorage', 'cleanupTempStorage', 'autoCleanupTempOnStart']],
      ['AppearanceSettings.tsx', ['getSettings', 'updateThemeMode', 'updateThemeStyle', 'updateInterfaceVariant', 'setAppIcon']],
    ] as const

    for (const [fileName, contracts] of pageContracts) {
      const source = readFileSync(join(import.meta.dir, fileName), 'utf8')
      for (const contract of contracts) expect(source).toContain(contract)
    }

    expect(readFileSync(join(rendererRoot, 'atoms/theme.ts'), 'utf8')).toContain('window.electronAPI.updateSettings')

    expect(existsSync(join(rendererRoot, 'components/migration/MigrationImportDialog.tsx'))).toBe(true)
    expect(existsSync(join(rendererRoot, 'hooks/useMigrationImport.ts'))).toBe(true)
    expect(existsSync(join(rendererRoot, 'atoms/migration-atoms.ts'))).toBe(true)
    expect(existsSync(join(rendererRoot, '..', 'main/lib/migration-service.ts'))).toBe(true)
    expect(readFileSync(join(rendererRoot, '..', 'main/index.ts'), 'utf8')).toContain('MIGRATION_IPC_OPEN')
  })
})
