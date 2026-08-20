import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const settingsRoot = join(import.meta.dir)
const panelSource = readFileSync(join(settingsRoot, '..', 'app-shell', 'CopisWorkingSettingsPanel.tsx'), 'utf8')
const workingAtomsSource = readFileSync(join(settingsRoot, '..', '..', 'atoms', 'working-atoms.ts'), 'utf8')

function readIfPresent(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

describe('关于/更新设置页契约', () => {
  test('Given 设置菜单 When 查看底部菜单 Then 提供关于/更新入口并渲染页面', () => {
    const source = readIfPresent(join(settingsRoot, 'AboutUpdatesSettings.tsx'))

    expect(existsSync(join(settingsRoot, 'AboutUpdatesSettings.tsx'))).toBe(true)
    expect(source).toContain('export function AboutUpdatesSettings')
    expect(panelSource).toContain("id: 'about'")
    expect(panelSource).toContain("label: '关于/更新'")
    expect(panelSource).toContain("activeSection === 'about' && <AboutUpdatesSettings />")
    expect(workingAtomsSource).toContain("| 'about'")
  })

  test('Given 关于页 When 展示主程序更新 Then 提供版本、检查更新、下载进度和安装入口', () => {
    const source = readIfPresent(join(settingsRoot, 'AboutUpdatesSettings.tsx'))

    expect(source).toContain('window.electronAPI.getAppInfo()')
    expect(source).toContain('checkForUpdates()')
    expect(source).toContain('downloadUpdate()')
    expect(source).toContain('installWhenIdle()')
    expect(source).toContain('updateStatusAtom')
    expect(source).toContain('updaterAvailableAtom')
    expect(source).toContain('status === \'downloading\'')
    expect(source).toContain('progress?.percent')
    expect(source).toContain("openExternal('https://copis.meetlife.com.cn')")
    expect(source).not.toContain('https://github.com/zalsay/copis/releases')
  })

  test('Given 桌面端卡片 When 展示主程序版本 Then 只保留一个当前版本描述', () => {
    const source = readIfPresent(join(settingsRoot, 'AboutUpdatesSettings.tsx'))
    const versionCopyMatches = source.match(/当前版本/g) ?? []

    expect(versionCopyMatches).toHaveLength(1)
  })

  test('Given 本地能力卡片 When 查看说明 Then 不显示自动管理描述', () => {
    const moduleSource = readIfPresent(join(settingsRoot, 'FunctionalModulesCard.tsx'))

    expect(moduleSource).not.toContain('Copis 会自动管理使用所需的本地能力')
  })

  test('Given 本地能力卡片 When 查看模块 Then 状态和操作位于右侧上下两行', () => {
    const moduleSource = readIfPresent(join(settingsRoot, 'FunctionalModulesCard.tsx'))

    expect(moduleSource).toContain('grid-cols-[minmax(0,1fr)_auto]')
    expect(moduleSource).toContain('flex-col items-end')
    expect(moduleSource).toContain('text-right')
    expect(moduleSource).toContain('justify-end')
    expect(moduleSource).toContain('col-span-2')
  })

  test('Given 关于页 When 查看本地模块 Then 复用功能模块卡片且不保留版本历史组件', () => {
    const source = readIfPresent(join(settingsRoot, 'AboutUpdatesSettings.tsx'))

    expect(source).toContain('<FunctionalModulesCard />')
    expect(source).toContain("from './FunctionalModulesCard'")
    expect(source).not.toContain('VersionHistory')
    expect(source).not.toContain('ReleaseNotesViewer')
  })
})
