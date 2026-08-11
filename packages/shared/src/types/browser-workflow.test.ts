import { describe, expect, test } from 'bun:test'
import { BROWSER_WORKFLOW_IPC_CHANNELS } from './browser-workflow'

describe('Browser Workflow 录制控制 IPC', () => {
  test('Given 工具栏开始录制 When 调用共享通道 Then 使用独立的 start-recording 通道', () => {
    expect(BROWSER_WORKFLOW_IPC_CHANNELS.START_RECORDING).toBe('browser-workflows:start-recording')
  })

  test('Given Browser 抽屉切换授权 When 调用共享通道 Then 只暴露高层控制模式', () => {
    expect(BROWSER_WORKFLOW_IPC_CHANNELS.SET_CONTROL_MODE).toBe('browser-workflows:set-control-mode')
    expect(Object.values(BROWSER_WORKFLOW_IPC_CHANNELS).some((channel) => /cdp|debugger/i.test(channel))).toBe(false)
  })

  test('Given 浏览器页签激活 When 恢复 AI浏览器会话 Then 使用独立的页签绑定查询通道', () => {
    expect(BROWSER_WORKFLOW_IPC_CHANNELS.SESSION_FOR_TAB).toBe('browser-workflows:session-for-tab')
  })
})
