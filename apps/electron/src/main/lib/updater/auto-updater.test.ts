import { describe, expect, mock, test } from 'bun:test'

const migrateLegacyAgentWorkspaceProjectDirectories = mock(() => {})
const checkAppUpdateMock = mock(async () => ({
  available: false,
  version: '',
  url: '',
}))

mock.module('electron', () => ({
  BrowserWindow: class {},
  app: {
    isPackaged: true,
    getVersion: () => '0.0.0',
  },
  shell: {},
}))

mock.module('../app-update-service', () => ({
  checkAppUpdateViaRustApi: checkAppUpdateMock,
}))

mock.module('../auto-install-update', () => ({
  autoInstallDownloadedUpdate: mock(async () => ({
    kind: 'unsupported',
    installed: false,
  })),
}))

mock.module('../agent-workspace-manager', () => ({
  migrateLegacyAgentWorkspaceProjectDirectories,
}))

const updaterModule = await import('./auto-updater')

describe('自动更新入口的工作区迁移', () => {
  test('Given 进入更新检查入口 When 检查更新 Then 先触发旧项目目录迁移再调用 Rust API', async () => {
    await updaterModule.checkForUpdates()

    expect(migrateLegacyAgentWorkspaceProjectDirectories).toHaveBeenCalledTimes(1)
    expect(checkAppUpdateMock).toHaveBeenCalledTimes(1)
  })

  test('Given 旧项目迁移抛错 When 检查更新 Then 记录错误并继续调用 Rust API', async () => {
    migrateLegacyAgentWorkspaceProjectDirectories.mockImplementationOnce(() => {
      throw new Error('migration failed')
    })

    await updaterModule.checkForUpdates()

    expect(checkAppUpdateMock).toHaveBeenCalledTimes(2)
  })
})
