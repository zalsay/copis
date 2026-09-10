import { expect, mock, spyOn, test } from 'bun:test'
let settings = { archiveAfterDays: 7, autoCleanupTempOnStart: true, autoCleanupArchivedDays: 3 }
const archive = mock(() => 0)
const stale = mock(() => undefined)
const staleWorkspace = mock(() => undefined)
const temp = mock(async () => ({ freedBytes: 0 }))
const storage = mock(async () => ({ freedBytes: 0 }))
mock.module('../lib/settings-service', () => ({ getSettings: () => settings }))
mock.module('../lib/agent-session-manager', () => ({ autoArchiveAgentSessions: archive, cleanupStaleAttachedPaths: stale }))
mock.module('../lib/agent-workspace-manager', () => ({ cleanupStaleWorkspaceAttachedPaths: staleWorkspace }))
mock.module('../lib/storage-service', () => ({ cleanupStorage: storage, cleanupTempFiles: temp }))
test('Given 启动维护 When 导入和启动 Then 导入无副作用且仅创建一次每日归档计时器', async () => {
  const interval = spyOn(globalThis, 'setInterval').mockImplementation((() => 1) as unknown as typeof setInterval)
  try {
    const { startIpcArchiveMaintenance, startIpcStorageCleanup } = await import('../app/ipc-startup-maintenance')
    expect(interval).not.toHaveBeenCalled()
    expect(archive).not.toHaveBeenCalled()
    startIpcArchiveMaintenance()
    expect(archive).toHaveBeenCalledWith(7)
    expect(interval).toHaveBeenCalledTimes(1)
    expect(interval.mock.calls[0]?.[1]).toBe(86400000)
    expect(stale).toHaveBeenCalledTimes(1)
    expect(staleWorkspace).toHaveBeenCalledTimes(1)
    startIpcStorageCleanup()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(temp).toHaveBeenCalledTimes(1)
    expect(storage).toHaveBeenCalledWith({ categories: ['agent-sessions', 'sdk-config'], orphansOnly: false, archivedBeforeDays: 3 })
    settings = { archiveAfterDays: 0, autoCleanupTempOnStart: false, autoCleanupArchivedDays: 0 }
    const tick = interval.mock.calls[0]?.[0] as () => void
    tick()
    expect(archive).toHaveBeenCalledTimes(1)
    startIpcStorageCleanup()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(temp).toHaveBeenCalledTimes(1)
  } finally { interval.mockRestore() }
})

test('Given 维护服务失败 When 启动 Then 捕获异常且继续建立定时任务', async () => {
  const interval = spyOn(globalThis, 'setInterval').mockImplementation((() => 1) as unknown as typeof setInterval)
  const errorLog = spyOn(console, 'error').mockImplementation(() => {})
  const failure = new Error('维护失败')
  settings = { archiveAfterDays: 7, autoCleanupTempOnStart: true, autoCleanupArchivedDays: 3 }
  archive.mockImplementationOnce(() => { throw failure })
  stale.mockImplementationOnce(() => { throw failure })
  temp.mockRejectedValueOnce(failure)
  try {
    const { startIpcArchiveMaintenance, startIpcStorageCleanup } = await import('../app/ipc-startup-maintenance')
    expect(() => startIpcArchiveMaintenance()).not.toThrow()
    expect(interval).toHaveBeenCalledTimes(1)
    startIpcStorageCleanup()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(errorLog).toHaveBeenCalledWith('[自动归档] 自动归档失败:', failure)
    expect(errorLog).toHaveBeenCalledWith('[启动清理] 清理失效附加路径失败:', failure)
    expect(errorLog).toHaveBeenCalledWith('[存储清理] 启动时清理失败:', failure)
  } finally {
    interval.mockRestore()
    errorLog.mockRestore()
  }
})
