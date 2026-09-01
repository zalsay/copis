import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('生产 CDP 启动契约 (browser-cdp-startup-contract)', () => {
  test('Given 生产主进程入口 When 检查启动逻辑 Then 不包含全局 CDP 端口配置与 remote-debugging-port 开关', () => {
    const mainIndexPath = join(__dirname, '../index.ts')
    const mainIndexContent = readFileSync(mainIndexPath, 'utf8')

    expect(mainIndexContent).not.toContain('configurePlaywrightCdpEndpoint')
    expect(mainIndexContent).not.toContain('remote-debugging-port')
  })
})
