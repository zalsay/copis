import { describe, expect, test } from 'bun:test'
import { BROWSER_WORKFLOW_IPC_CHANNELS } from './browser-workflow'

describe('Browser Workflow 录制控制 IPC', () => {
  test('Given 工具栏开始录制 When 调用共享通道 Then 使用独立的 start-recording 通道', () => {
    expect(BROWSER_WORKFLOW_IPC_CHANNELS.START_RECORDING).toBe('browser-workflows:start-recording')
  })
})
