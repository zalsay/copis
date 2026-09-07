import { describe, expect, test } from 'bun:test'
import { DSH_CORDIS_IPC_CHANNELS } from './dsh'
import type { AgentRuntime } from './agent-provider'

describe('DSH Cordis 模式 IPC 与共享类型契约', () => {
  test('Given DSH Cordis 通道常量 When 查询通道名称 Then 包含 START、GET_STATUS、STOP 与 RELOAD', () => {
    expect(DSH_CORDIS_IPC_CHANNELS.START).toBe('dsh-cordis:start')
    expect(DSH_CORDIS_IPC_CHANNELS.GET_STATUS).toBe('dsh-cordis:get-status')
    expect(DSH_CORDIS_IPC_CHANNELS.STOP).toBe('dsh-cordis:stop')
    expect(DSH_CORDIS_IPC_CHANNELS.RELOAD).toBe('dsh-cordis:reload')
    expect(DSH_CORDIS_IPC_CHANNELS.ON_STATUS_CHANGE).toBe('dsh-cordis:status-change')
    expect(DSH_CORDIS_IPC_CHANNELS.READ_FILE).toBe('dsh-cordis:read-file')
    expect(DSH_CORDIS_IPC_CHANNELS.SHOW_ITEM_IN_FOLDER).toBe('dsh-cordis:show-item-in-folder')
    expect(DSH_CORDIS_IPC_CHANNELS.LIST_DIRECTORY).toBe('dsh-cordis:list-directory')
  })

  test('Given AgentRuntime 类型 When 声明运行时 Then 兼容 pi 与 dsh', () => {
    const piRuntime: AgentRuntime = 'pi'
    const dshRuntime: AgentRuntime = 'dsh'
    expect(piRuntime).toBe('pi')
    expect(dshRuntime).toBe('dsh')
  })
})
