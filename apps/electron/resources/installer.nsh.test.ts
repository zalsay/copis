import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const installerInclude = readFileSync(join(import.meta.dir, 'installer.nsh'), 'utf8')

describe('Windows 可视化升级安装器', () => {
  test('Given 自动更新 When NSIS 显示安装进度 Then 沿用既有安装范围且跳过选择页', () => {
    expect(installerInclude).toContain('!macro customInstallMode')
    expect(installerInclude).toContain('${if} ${isUpdated}')
    expect(installerInclude).toContain('StrCpy $isForceMachineInstall "1"')
    expect(installerInclude).toContain('StrCpy $isForceCurrentInstall "1"')
  })

  test('Given 自动更新写入完成 When 安装器结束 Then 从正式安装目录启动新版而非 old-install 临时目录', () => {
    expect(installerInclude).toContain('!macro customInstall')
    expect(installerInclude).toContain('${andIf} ${isForceRun}')
    expect(installerInclude).toContain('!insertmacro StartApp')
    expect(installerInclude).toContain('Quit')
    expect(installerInclude).not.toContain('old-install')
  })
})
