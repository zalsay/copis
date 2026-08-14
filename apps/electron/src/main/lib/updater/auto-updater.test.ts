import { describe, expect, mock, test } from 'bun:test'

const migrateLegacyAgentWorkspaceProjectDirectories = mock(() => {})
const checkForUpdatesMock = mock(async () => {})

mock.module('electron', () => ({
  BrowserWindow: class {},
  app: { isPackaged: true },
}))

mock.module('electron-updater', () => ({
  autoUpdater: {
    checkForUpdates: checkForUpdatesMock,
    on: () => {},
    setFeedURL: () => {},
    logger: undefined,
    autoDownload: false,
    autoInstallOnAppQuit: false,
  },
}))

mock.module('../agent-workspace-manager', () => ({
  migrateLegacyAgentWorkspaceProjectDirectories,
}))

const updaterModule = await import('./auto-updater')

describe('自动更新入口的工作区迁移', () => {
  test('Given 进入更新检查入口 When 检查更新 Then 先触发旧项目目录迁移再调用更新器', async () => {
    await updaterModule.checkForUpdates()

    expect(migrateLegacyAgentWorkspaceProjectDirectories).toHaveBeenCalledTimes(1)
    expect(checkForUpdatesMock).toHaveBeenCalledTimes(1)
  })

  test('Given 旧项目迁移抛错 When 检查更新 Then 记录错误并继续调用更新器', async () => {
    migrateLegacyAgentWorkspaceProjectDirectories.mockImplementationOnce(() => {
      throw new Error('migration failed')
    })

    await updaterModule.checkForUpdates()

    expect(checkForUpdatesMock).toHaveBeenCalledTimes(2)
  })
})
