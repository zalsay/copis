import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureTradingWebProfile,
  getDshTradingStatus,
  startDshTradingServer,
  stopDshTradingServer,
} from './dsh-trading-service'

describe('dsh-trading-service', () => {
  test('Given 临时 DSH 目录 When 初始化 trading-web profile Then 生成只读展示配置并禁止交易执行', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'copis-test-dsh-'))
    try {
      const profileDir = ensureTradingWebProfile(tempDir)
      expect(existsSync(profileDir)).toBe(true)

      const cordisConfigPath = join(profileDir, 'cordis.json')
      expect(existsSync(cordisConfigPath)).toBe(true)

      const parsed = JSON.parse(readFileSync(cordisConfigPath, 'utf-8'))
      expect(parsed.features.tradingExecution).toBe(false)
      expect(parsed.features.liveTrading).toBe(false)
      expect(parsed.features.orderRouting).toBe(false)
      expect(parsed.features.readOnlyMarketData).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('Given 未找到 dsh 运行程序 When 启动服务 Then 优雅降级返回错误信息并不崩溃', async () => {
    const status = await startDshTradingServer({
      dshCommand: undefined,
    })
    expect(status.running).toBe(false)
    expect(status.error).toContain('未找到已激活的 dsh 运行时')
  })

  test('Given 停止服务调用 When 停止 Then 状态恢复为未运行', () => {
    const status = stopDshTradingServer()
    expect(status.running).toBe(false)
    expect(getDshTradingStatus().running).toBe(false)
  })
})
