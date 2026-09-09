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

describe('版本比较与已下载更新持久化机制', () => {
  test('Given 两个版本号 When compareSemver Then 正确比较主次版本与修订号', () => {
    expect(updaterModule.compareSemver('0.0.84', '0.0.83')).toBeGreaterThan(0)
    expect(updaterModule.compareSemver('0.0.84', '0.0.84')).toBe(0)
    expect(updaterModule.compareSemver('0.0.83', '0.0.84')).toBeLessThan(0)
    expect(updaterModule.compareSemver('v0.1.0', '0.0.99')).toBeGreaterThan(0)
    expect(updaterModule.compareSemver('1.0.0', '0.9.9')).toBeGreaterThan(0)
  })

  test('Given 本地已下载版本且高于最新版或等于最新版 When checkForUpdates Then 保持 downloaded 状态', async () => {
    const { writeFileSync, unlinkSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const fakeInstallerPath = join(tmpdir(), 'copis-fake-installer.dmg')
    writeFileSync(fakeInstallerPath, 'dummy installer content')

    await updaterModule.savePersistedDownloadedUpdate({
      version: '0.0.84',
      filePath: fakeInstallerPath,
      fileSize: 23,
      downloadUrl: 'https://example.com/Copis-0.0.84.dmg',
      downloadedAt: Date.now(),
    })

    checkAppUpdateMock.mockImplementationOnce(async () => ({
      available: true,
      version: '0.0.84',
      url: 'https://example.com/Copis-0.0.84.dmg',
      size: 23,
    }))

    await updaterModule.checkForUpdates()
    const status = updaterModule.getUpdateStatus()

    expect(status.status).toBe('downloaded')
    if (status.status === 'downloaded') {
      expect(status.version).toBe('0.0.84')
      expect(status.filePath).toBe(fakeInstallerPath)
    }

    // 清理
    await updaterModule.clearPersistedDownloadedUpdate(true)
    try { unlinkSync(fakeInstallerPath) } catch {}
  })

  test('Given 本地已下载版本低于远端最新版 When checkForUpdates Then 清理旧安装包并切换为 available 下载更新', async () => {
    const { writeFileSync, existsSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const fakeOldInstallerPath = join(tmpdir(), 'copis-fake-old-installer.dmg')
    writeFileSync(fakeOldInstallerPath, 'dummy old installer content')

    await updaterModule.savePersistedDownloadedUpdate({
      version: '0.0.83',
      filePath: fakeOldInstallerPath,
      fileSize: 27,
      downloadUrl: 'https://example.com/Copis-0.0.83.dmg',
      downloadedAt: Date.now(),
    })

    // 远端返回更高的 0.0.85
    checkAppUpdateMock.mockImplementationOnce(async () => ({
      available: true,
      version: '0.0.85',
      url: 'https://example.com/Copis-0.0.85.dmg',
      size: 100,
    }))

    await updaterModule.checkForUpdates()
    const status = updaterModule.getUpdateStatus()

    // 应切换为可下载状态，且版本为远端最新版 0.0.85
    expect(status.status).toBe('available')
    if (status.status === 'available') {
      expect(status.version).toBe('0.0.85')
      expect(status.downloadUrl).toBe('https://example.com/Copis-0.0.85.dmg')
    }

    // 旧文件应被清理
    expect(existsSync(fakeOldInstallerPath)).toBe(false)
  })

  test('Given 安装成功后再次启动 app（当前版本已是新版本） When 执行启动清理 Then 自动清理下载安装包与元数据', async () => {
    const { writeFileSync, existsSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const fakeInstalledPath = join(tmpdir(), 'copis-fake-installed.dmg')
    writeFileSync(fakeInstalledPath, 'installed package content')

    await updaterModule.savePersistedDownloadedUpdate({
      version: '0.0.84',
      filePath: fakeInstalledPath,
      fileSize: 25,
      downloadUrl: 'https://example.com/Copis-0.0.84.dmg',
      downloadedAt: Date.now(),
    })

    expect(existsSync(fakeInstalledPath)).toBe(true)
    expect(existsSync(updaterModule.getPersistedUpdateFilePath())).toBe(true)

    // 模拟新启动的 app 版本为 0.0.84（已更新完成）
    await updaterModule.cleanupDownloadedUpdatesOnStartup('0.0.84')

    // 安装包与持久化元数据应均被自动清理
    expect(existsSync(fakeInstalledPath)).toBe(false)
    expect(existsSync(updaterModule.getPersistedUpdateFilePath())).toBe(false)
  })
})
