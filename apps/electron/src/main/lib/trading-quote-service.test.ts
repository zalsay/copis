import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getWatchlist,
  normalizeSymbol,
  parseTencentQuoteLine,
  saveWatchlist,
} from './trading-quote-service'

describe('trading-quote-service', () => {
  describe('normalizeSymbol', () => {
    test('Given 纯数字 6 位 A 股代码 When 规范化 Then 识别对应市场与前缀', () => {
      expect(normalizeSymbol('600519')).toEqual({
        symbol: 'sh600519',
        wireSymbol: 'sh600519',
        market: 'cn',
      })
      expect(normalizeSymbol('000001')).toEqual({
        symbol: 'sz000001',
        wireSymbol: 'sz000001',
        market: 'cn',
      })
      expect(normalizeSymbol('300750')).toEqual({
        symbol: 'sz300750',
        wireSymbol: 'sz300750',
        market: 'cn',
      })
    })

    test('Given ETF 与基金代码 When 规范化 Then 识别为 fund 市场', () => {
      expect(normalizeSymbol('510050')).toEqual({
        symbol: 'sh510050',
        wireSymbol: 'sh510050',
        market: 'fund',
      })
      expect(normalizeSymbol('159915')).toEqual({
        symbol: 'sz159915',
        wireSymbol: 'sz159915',
        market: 'fund',
      })
    })

    test('Given 港股纯数字 5 位代码或带前缀 When 规范化 Then 识别为 hk 市场与 r_ 前缀 wire', () => {
      expect(normalizeSymbol('00700')).toEqual({
        symbol: 'hk00700',
        wireSymbol: 'r_hk00700',
        market: 'hk',
      })
      expect(normalizeSymbol('hk09988')).toEqual({
        symbol: 'hk09988',
        wireSymbol: 'r_hk09988',
        market: 'hk',
      })
    })

    test('Given 美股字母代码或 us 前缀 When 规范化 Then 识别为 us 市场', () => {
      expect(normalizeSymbol('AAPL')).toEqual({
        symbol: 'AAPL',
        wireSymbol: 'usAAPL',
        market: 'us',
      })
      expect(normalizeSymbol('usTSLA')).toEqual({
        symbol: 'TSLA',
        wireSymbol: 'usTSLA',
        market: 'us',
      })
    })
  })

  describe('parseTencentQuoteLine', () => {
    test('Given A 股腾讯行情字符串 When 解析 Then 正确提取价格、涨跌幅、五档盘口与市值', () => {
      const sample = 'v_sh600519="1~贵州茅台~600519~1800.00~1780.00~1790.00~50000~0~0~1799.00~10~1798.00~20~0~0~0~0~0~0~1801.00~15~1802.00~25~0~0~0~0~0~0~~20260904~20.00~1.12~1810.00~1785.00~1800.00/50000/90000000~50000~90000~0.5~25.5~~1810.00~1785.00~1.40~22000.00~22000.00~8.5~";'
      const parsed = parseTencentQuoteLine(sample)
      expect(parsed).not.toBeNull()
      expect(parsed?.symbol).toBe('sh600519')
      expect(parsed?.name).toBe('贵州茅台')
      expect(parsed?.price).toBe(1800)
      expect(parsed?.change).toBe(20)
      expect(parsed?.changePercent).toBe(1.12)
      expect(parsed?.high).toBe(1810)
      expect(parsed?.low).toBe(1785)
      expect(parsed?.bids?.length).toBeGreaterThanOrEqual(2)
      expect(parsed?.asks?.length).toBeGreaterThanOrEqual(2)
      expect(parsed?.bids?.[0]).toEqual({ price: 1799, volume: 10 })
      expect(parsed?.asks?.[0]).toEqual({ price: 1801, volume: 15 })
    })

    test('Given 港股腾讯行情字符串 When 解析 Then 正确提取港股行情并标记 market 为 hk', () => {
      const sample = 'v_r_hk00700="100~腾讯控股~00700~440.00~430.00~435.00~12000000~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~2026/09/04~10.00~2.33~445.00~432.00~440.00~12000000~5200000000~0~18.5~~";'
      const parsed = parseTencentQuoteLine(sample)
      expect(parsed).not.toBeNull()
      expect(parsed?.symbol).toBe('hk00700')
      expect(parsed?.name).toBe('腾讯控股')
      expect(parsed?.market).toBe('hk')
      expect(parsed?.price).toBe(440)
      expect(parsed?.change).toBe(10)
      expect(parsed?.changePercent).toBe(2.33)
    })

    test('Given 美股腾讯行情字符串 When 解析 Then 正确提取美股行情并标记 market 为 us', () => {
      const sample = 'v_usAAPL="200~苹果~AAPL.OQ~328.00~324.00~325.00~30000000~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~~2026-09-03~4.00~1.23~330.00~324.00~USD~30000000~9800000000~0.2~30.0~~";'
      const parsed = parseTencentQuoteLine(sample)
      expect(parsed).not.toBeNull()
      expect(parsed?.symbol).toBe('AAPL')
      expect(parsed?.name).toBe('苹果')
      expect(parsed?.market).toBe('us')
      expect(parsed?.price).toBe(328)
      expect(parsed?.changePercent).toBe(1.23)
    })
  })

  describe('Watchlist storage', () => {
    test('Given 临时目录 When 初始读取与保存自选 Then 正常持久化', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'copis-test-watchlist-'))
      try {
        const defaultList = getWatchlist(tempDir)
        expect(defaultList.length).toBeGreaterThan(0)

        const custom = [
          {
            id: 'test-1',
            symbol: 'AAPL',
            name: 'Apple',
            market: 'us' as const,
            addedAt: Date.now(),
          },
        ]
        saveWatchlist(custom, tempDir)

        const reloaded = getWatchlist(tempDir)
        expect(reloaded).toEqual(custom)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })
  })
})
