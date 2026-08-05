import { describe, expect, test } from 'bun:test'
import { acquireBrowserWorkflowProfileLease } from './browser-workflow-profile-lease'

describe('Browser Workflow Profile lease', () => {
  test('Given 一个运行已占用 Profile When 另一个会话申请 Then 拒绝并保留原占用者', () => {
    const partition = 'persist:test-browser-workflow-conflict'
    const releaseFirst = acquireBrowserWorkflowProfileLease(partition, 'session-1')
    expect(() => acquireBrowserWorkflowProfileLease(partition, 'session-2')).toThrow('另一个运行占用')

    releaseFirst()
    const releaseSecond = acquireBrowserWorkflowProfileLease(partition, 'session-2')
    releaseSecond()
  })

  test('Given 同一会话重复获取 lease When 当前 lease 未释放 Then 也必须拒绝第二个运行', () => {
    const partition = 'persist:test-browser-workflow-reentrant'
    const releaseFirst = acquireBrowserWorkflowProfileLease(partition, 'session-1')
    expect(() => acquireBrowserWorkflowProfileLease(partition, 'session-1')).toThrow('另一个运行占用')

    releaseFirst()
    const releaseSecond = acquireBrowserWorkflowProfileLease(partition, 'session-1')
    releaseSecond()
  })

  test('Given lease 已释放 When 重复调用释放函数 Then 状态保持可重入', () => {
    const partition = 'persist:test-browser-workflow-release'
    const release = acquireBrowserWorkflowProfileLease(partition, 'session-1')
    release()
    release()

    const next = acquireBrowserWorkflowProfileLease(partition, 'session-2')
    next()
  })
})
