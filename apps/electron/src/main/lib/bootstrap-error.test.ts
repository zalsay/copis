import { describe, expect, test } from 'bun:test'
import { formatBootstrapErrorDialog } from './bootstrap-error'

describe('formatBootstrapErrorDialog', () => {
  const logsDir = '/tmp/copis-test-logs'

  test('Given 网络错误 (TypeError: fetch failed) When 格式化启动弹窗 Then 返回简洁友好的网络提示', () => {
    const error = new TypeError('fetch failed')
    const dialog = formatBootstrapErrorDialog(error, logsDir)

    expect(dialog.title).toBe('网络连接异常')
    expect(dialog.content).toBe('未能连接到网络服务，部分功能可能暂不可用。\n\n请检查电脑网络连接后重试。')
    expect(dialog.content).not.toContain('常见原因与排查')
    expect(dialog.content).not.toContain('TypeError')
  })

  test('Given 嵌套 cause 为 ENOTFOUND 的网络错误 When 格式化启动弹窗 Then 返回网络异常弹窗', () => {
    const error = new TypeError('fetch failed')
    Object.assign(error, {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND download.copis.cn'), {
        code: 'ENOTFOUND',
      }),
    })
    const dialog = formatBootstrapErrorDialog(error, logsDir)

    expect(dialog.title).toBe('网络连接异常')
    expect(dialog.content).toContain('请检查电脑网络连接后重试')
  })

  test('Given 非网络致命错误 (配置损坏) When 格式化启动弹窗 Then 保留详细排查步骤与日志位置', () => {
    const error = new Error('~/.copis/config.json 格式损坏')
    const dialog = formatBootstrapErrorDialog(error, logsDir)

    expect(dialog.title).toBe('Copis 启动遇到错误')
    expect(dialog.content).toContain('部分功能可能不可用：')
    expect(dialog.content).toContain('~/.copis/config.json 格式损坏')
    expect(dialog.content).toContain(`日志位置：${logsDir}`)
    expect(dialog.content).toContain('常见原因与排查：')
    expect(dialog.content).toContain('1. 旧版 Copis 进程未退出')
  })
})
