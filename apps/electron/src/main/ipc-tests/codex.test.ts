import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CODEX_IPC_CHANNELS as C } from '../../types'
import { createIpcHarness } from './t2-harness'
import { stopCodexAppServer } from '../lib/codex-app-server-service'

const h = createIpcHarness()
const sendMock = mock(() => undefined)
const updateSettingsMock = mock((_updates?: any) => undefined)

mock.module('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
  },
  shell: { openExternal: async () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
  ipcMain: h.ipcMain,
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { send: sendMock },
      },
    ],
  },
}))

const inMemorySettings: Record<string, any> = { professionalMode: false }

mock.module('../lib/settings-service', () => ({
  getSettings: () => ({ ...inMemorySettings }),
  updateSettings: (updates: any) => {
    updateSettingsMock(updates)
    Object.assign(inMemorySettings, updates)
    return { ...inMemorySettings }
  },
}))

describe('Codex IPC Handlers (BDD)', () => {
  let dummyExecPath: string | null = null

  beforeEach(() => {
    sendMock.mockClear()
    updateSettingsMock.mockClear()
  })

  afterEach(async () => {
    await stopCodexAppServer()
    delete process.env.COPIS_CODEX_EXECUTABLE
    if (dummyExecPath && existsSync(dummyExecPath)) {
      try {
        unlinkSync(dummyExecPath)
      } catch {
        // ignore
      }
      dummyExecPath = null
    }
  })

  test('Given Codex App Server IPC 注册 When 调用查询、启动、停止 Then 状态机与设置正确同步并广播', async () => {
    dummyExecPath = join(tmpdir(), `mock-codex-ipc-${Date.now()}.sh`)
    writeFileSync(
      dummyExecPath,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "codex 0.8.0"\n  exit 0\nelif [ "$1" = "app-server" ] && [ "$2" = "--help" ]; then\n  echo "Usage: codex app-server --listen"\n  exit 0\nfi\nsleep 30\n',
      { mode: 0o755 },
    )
    process.env.COPIS_CODEX_EXECUTABLE = dummyExecPath

    const { registerCodexIpcHandlers } = await import('../ipc/codex.ipc')
    registerCodexIpcHandlers()

    // 1. CHECK_CLI
    const cliCheck = (await h.invoke(C.CHECK_CLI)) as { available: boolean; canStartAppServer: boolean }
    expect(cliCheck.available).toBe(true)
    expect(cliCheck.canStartAppServer).toBe(true)

    // 2. GET_STATUS
    const initialStatus = await h.invoke(C.GET_STATUS)
    expect(initialStatus).toEqual({ running: false })

    // 3. START_APP_SERVER
    const startedStatus = (await h.invoke(C.START_APP_SERVER)) as { running: boolean; port: number; pid?: number }
    expect(startedStatus.running).toBe(true)
    expect(typeof startedStatus.port).toBe('number')
    expect(typeof startedStatus.pid).toBe('number')
    expect(updateSettingsMock).toHaveBeenCalledWith({ professionalMode: true })

    // 启动时应通过 BrowserWindow 广播状态变更
    expect(sendMock).toHaveBeenCalledWith(
      C.ON_STATUS_CHANGED,
      expect.objectContaining({ running: true }),
    )

    // 3. STOP_APP_SERVER
    await h.invoke(C.STOP_APP_SERVER)
    expect(updateSettingsMock).toHaveBeenCalledWith({ professionalMode: false })

    // 停止后查询状态
    const stoppedStatus = (await h.invoke(C.GET_STATUS)) as { running: boolean }
    expect(stoppedStatus.running).toBe(false)
  })
})
