/**
 * 基金股市（美股、A 股、港股、基金与 ETF）行情聚合与自选管理服务。
 * 纯开箱即用免 Key 公开端点（腾讯财经 + Yahoo Finance 备用）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type BidAskLevel,
  type FundStockSearchResult,
  type KlinePeriod,
  type KlinePoint,
  type MarketCategory,
  type MarketQuote,
  type WatchlistItem,
} from '@copis/shared'
import { getConfigDir } from './config-paths'

export interface NormalizedSymbol {
  symbol: string
  wireSymbol: string
  market: MarketCategory
}

/** 规范化用户输入的标的代码（支持 600519、sh600519、00700、hk00700、AAPL、510050 等）。 */
export function normalizeSymbol(input: string): NormalizedSymbol {
  const trimmed = input.trim()
  if (!trimmed) {
    return { symbol: '', wireSymbol: '', market: 'cn' }
  }

  const lower = trimmed.toLowerCase()
  const upper = trimmed.toUpperCase()

  // 1. 明确带前缀的 A 股 (sh600519, sz000001, bj830000)
  if (/^(sh|sz|bj)\d{6}$/.test(lower)) {
    const code = lower.slice(2)
    const isFund = /^5[0-9]{5}$/.test(code) || /^1[56][0-9]{4}$/.test(code)
    return {
      symbol: lower,
      wireSymbol: lower,
      market: isFund ? 'fund' : 'cn',
    }
  }

  // 2. 明确带前缀的港股 (hk00700)
  if (/^hk\d{5}$/.test(lower)) {
    return {
      symbol: lower,
      wireSymbol: `r_${lower}`,
      market: 'hk',
    }
  }

  // 3. 明确带前缀的美股 (usAAPL)
  if (/^us[a-z.]+$/i.test(trimmed)) {
    const code = upper.slice(2)
    return {
      symbol: code,
      wireSymbol: `us${code}`,
      market: 'us',
    }
  }

  // 4. 纯 6 位数字代码 (A 股或场内基金/ETF)
  if (/^\d{6}$/.test(trimmed)) {
    if (/^5[0-9]{5}$/.test(trimmed)) {
      return { symbol: `sh${trimmed}`, wireSymbol: `sh${trimmed}`, market: 'fund' }
    }
    if (/^1[56][0-9]{4}$/.test(trimmed)) {
      return { symbol: `sz${trimmed}`, wireSymbol: `sz${trimmed}`, market: 'fund' }
    }
    if (/^[69]\d{5}$/.test(trimmed)) {
      return { symbol: `sh${trimmed}`, wireSymbol: `sh${trimmed}`, market: 'cn' }
    }
    if (/^[03]\d{5}$/.test(trimmed)) {
      return { symbol: `sz${trimmed}`, wireSymbol: `sz${trimmed}`, market: 'cn' }
    }
    if (/^[48]\d{5}$/.test(trimmed)) {
      return { symbol: `bj${trimmed}`, wireSymbol: `bj${trimmed}`, market: 'cn' }
    }
    return { symbol: `sh${trimmed}`, wireSymbol: `sh${trimmed}`, market: 'cn' }
  }

  // 5. 纯 5 位数字代码 (港股，如 00700)
  if (/^\d{5}$/.test(trimmed)) {
    return {
      symbol: `hk${trimmed}`,
      wireSymbol: `r_hk${trimmed}`,
      market: 'hk',
    }
  }

  // 6. 英文代码 (美股，如 AAPL, TSLA, NVDA)
  if (/^[a-zA-Z.]+$/.test(trimmed)) {
    return {
      symbol: upper,
      wireSymbol: `us${upper}`,
      market: 'us',
    }
  }

  return { symbol: trimmed, wireSymbol: trimmed, market: 'cn' }
}

/** 将腾讯 GBK 格式行情切片解析为统一 MarketQuote 对象。 */
export function parseTencentQuoteLine(line: string): MarketQuote | null {
  const match = line.match(/^v_([a-zA-Z0-9_]+)="([^"]*)";?$/)
  if (!match) return null

  if (!match || !match[1] || !match[2]) return null

  const rawWire = match[1]
  const content = match[2]

  const fields = content.split('~')
  if (fields.length < 30) return null

  const rawWireClean = rawWire.replace(/^r_/, '')
  const isHk = rawWire.startsWith('r_hk') || rawWireClean.startsWith('hk')
  const isUs = rawWire.startsWith('us')

  let market: MarketCategory = 'cn'
  let symbol = rawWireClean
  if (isHk) {
    market = 'hk'
    symbol = rawWireClean
  } else if (isUs) {
    market = 'us'
    symbol = rawWire.slice(2)
  } else if (/^(sh5[0-9]{5}|sz1[56][0-9]{4})$/.test(rawWireClean)) {
    market = 'fund'
  }

  const name = fields[1] || symbol
  const price = parseFloat(fields[3] || '0') || 0
  const prevClose = parseFloat(fields[4] || '0') || 0
  const open = parseFloat(fields[5] || '0') || 0
  const volume = parseFloat(fields[6] || '0') || 0
  const change = parseFloat(fields[31] || '0') || 0
  const changePercent = parseFloat(fields[32] || '0') || 0
  const high = parseFloat(fields[33] || '0') || 0
  const low = parseFloat(fields[34] || '0') || 0
  const amount = parseFloat(fields[37] || '0') || 0
  const turnoverRate = fields[38] ? parseFloat(fields[38]) : undefined
  const pe = fields[39] ? parseFloat(fields[39]) : undefined
  const marketCap = fields[44] ? parseFloat(fields[44]) : undefined
  const pb = fields[46] ? parseFloat(fields[46]) : undefined

  // 提取买卖五档盘口（A 股与部分标的具备五档）
  const bids: BidAskLevel[] = []
  const asks: BidAskLevel[] = []
  if (!isHk && !isUs) {
    // 买一至买五: 9,10, 11,12, 13,14, 15,16, 17,18
    for (let i = 0; i < 5; i++) {
      const p = parseFloat(fields[9 + i * 2] || '0')
      const v = parseFloat(fields[10 + i * 2] || '0')
      if (p > 0) bids.push({ price: p, volume: v })
    }
    // 卖一至卖五: 19,20, 21,22, 23,24, 25,26, 27,28
    for (let i = 0; i < 5; i++) {
      const p = parseFloat(fields[19 + i * 2] || '0')
      const v = parseFloat(fields[20 + i * 2] || '0')
      if (p > 0) asks.push({ price: p, volume: v })
    }
  }

  return {
    symbol,
    name,
    market,
    price,
    change,
    changePercent,
    high,
    low,
    open,
    prevClose,
    volume,
    amount,
    turnoverRate,
    pe,
    pb,
    marketCap,
    bids: bids.length ? bids : undefined,
    asks: asks.length ? asks : undefined,
    updatedAt: Date.now(),
  }
}

/** 批量获取多标的实时行情。 */
export async function fetchMarketQuotes(symbols: string[]): Promise<MarketQuote[]> {
  if (!symbols.length) return []

  const normalized = symbols.map(normalizeSymbol).filter((s) => s.wireSymbol)
  const wireList = normalized.map((s) => s.wireSymbol)
  const url = `http://qt.gtimg.cn/q=${wireList.join(',')}`

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const buffer = await res.arrayBuffer()
    const text = new TextDecoder('gbk').decode(buffer)
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)

    const quotes: MarketQuote[] = []
    for (const line of lines) {
      const q = parseTencentQuoteLine(line)
      if (q) quotes.push(q)
    }

    return quotes
  } catch (error) {
    console.error('[基金股市] 获取实时行情失败:', error)
    return []
  }
}

/** 映射周期到腾讯 K 线接口参数 */
function mapPeriodToTencent(period: KlinePeriod): string {
  switch (period) {
    case 'week':
      return 'week'
    case 'month':
      return 'month'
    case '1m':
    case '5m':
      return 'm5'
    case '15m':
      return 'm15'
    case '30m':
      return 'm30'
    case '60m':
      return 'm60'
    case 'day':
    default:
      return 'day'
  }
}

/** 获取标的 K 线历史数据。 */
export async function fetchKlines(
  symbolInput: string,
  period: KlinePeriod = 'day',
  count = 120
): Promise<KlinePoint[]> {
  const norm = normalizeSymbol(symbolInput)
  if (!norm.wireSymbol) return []

  const periodParam = mapPeriodToTencent(period)
  let endpoint = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
  let queryWire = norm.wireSymbol

  if (norm.market === 'hk') {
    endpoint = 'https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get'
    queryWire = norm.symbol // hk00700
  } else if (norm.market === 'us') {
    endpoint = 'https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get'
    queryWire = norm.wireSymbol.includes('.') ? norm.wireSymbol : `${norm.wireSymbol}.OQ`
  }

  const url = `${endpoint}?param=${queryWire},${periodParam},,,${count},qfq`

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
      },
    })
    if (!res.ok) return []

    const json = (await res.json()) as any
    if (json.code !== 0 || !json.data) return []

    // 查找对应标的数据键
    const targetData = json.data[queryWire] || json.data[norm.wireSymbol] || json.data[norm.symbol]
    if (!targetData) return []

    const klineRows: any[] =
      targetData[`qfq${periodParam}`] ||
      targetData[periodParam] ||
      targetData['day'] ||
      targetData['qfqday'] ||
      []

    const klines: KlinePoint[] = []
    for (const row of klineRows) {
      if (!Array.isArray(row) || row.length < 6) continue
      // row: [date, open, close, high, low, volume]
      const time = String(row[0])
      const open = parseFloat(row[1]) || 0
      const close = parseFloat(row[2]) || 0
      const high = parseFloat(row[3]) || 0
      const low = parseFloat(row[4]) || 0
      const volume = parseFloat(row[5]) || 0
      const amount = row[6] ? parseFloat(row[6]) : undefined

      klines.push({ time, open, close, high, low, volume, amount })
    }

    return klines
  } catch (error) {
    console.error(`[基金股市] 获取 K 线失败 (${symbolInput}):`, error)
    return []
  }
}

/** 搜索股票、ETF 或基金。 */
export async function searchSymbols(keyword: string): Promise<FundStockSearchResult[]> {
  const trimmed = keyword.trim()
  if (!trimmed) return []

  const url = `https://smartbox.gtimg.cn/s3/?t=all&q=${encodeURIComponent(trimmed)}`

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
      },
    })
    if (!res.ok) return []

    const buffer = await res.arrayBuffer()
    const text = new TextDecoder('gbk').decode(buffer)
    const match = text.match(/v_hint="([^"]*)"/)
    if (!match || !match[1]) return []

    const rawItems = match[1].split('^')
    const results: FundStockSearchResult[] = []

    for (const item of rawItems) {
      const parts = item.split('~')
      if (parts.length < 3 || !parts[1] || !parts[2]) continue
      const rawMarket = parts[0]
      const code = parts[1]
      const name = parts[2]
      const pinyin = parts[3]

      let market: MarketCategory = 'cn'
      let symbol = `${rawMarket}${code}`

      if (rawMarket === 'hk') {
        market = 'hk'
        symbol = `hk${code}`
      } else if (rawMarket === 'us') {
        market = 'us'
        symbol = code
      } else if (/^(sh5|sz1)/.test(`${rawMarket}${code}`)) {
        market = 'fund'
      }

      results.push({
        symbol,
        name,
        market,
        pinyin,
      })
    }

    return results
  } catch (error) {
    console.error(`[基金股市] 搜索标的失败 (${keyword}):`, error)
    return []
  }
}

/** 默认预置自选列表 */
const DEFAULT_WATCHLIST: WatchlistItem[] = [
  { id: 'item-1', symbol: 'sh600519', name: '贵州茅台', market: 'cn', group: '核心资产', pinned: true, addedAt: 1 },
  { id: 'item-2', symbol: 'sz300750', name: '宁德时代', market: 'cn', group: '核心资产', addedAt: 2 },
  { id: 'item-3', symbol: 'hk00700', name: '腾讯控股', market: 'hk', group: '港股科技', addedAt: 3 },
  { id: 'item-4', symbol: 'hk03690', name: '美团-W', market: 'hk', group: '港股科技', addedAt: 4 },
  { id: 'item-5', symbol: 'AAPL', name: '苹果公司', market: 'us', group: '美股巨头', addedAt: 5 },
  { id: 'item-6', symbol: 'NVDA', name: '英伟达', market: 'us', group: '美股巨头', pinned: true, addedAt: 6 },
  { id: 'item-7', symbol: 'sh510050', name: '上证50ETF', market: 'fund', group: '指数ETF', addedAt: 7 },
  { id: 'item-8', symbol: 'sh513100', name: '纳指ETF', market: 'fund', group: '指数ETF', addedAt: 8 },
]

function getWatchlistFilePath(rootDir?: string): string {
  const dir = rootDir || getConfigDir()
  return join(dir, 'fund-stock-watchlist.json')
}

/** 获取用户自选列表 */
export function getWatchlist(rootDir?: string): WatchlistItem[] {
  const filePath = getWatchlistFilePath(rootDir)
  if (!existsSync(filePath)) {
    return DEFAULT_WATCHLIST
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw)
    return Array.isArray(data) && data.length ? data : DEFAULT_WATCHLIST
  } catch {
    return DEFAULT_WATCHLIST
  }
}

/** 保存用户自选列表 */
export function saveWatchlist(items: WatchlistItem[], rootDir?: string): void {
  const filePath = getWatchlistFilePath(rootDir)
  const dir = rootDir || getConfigDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(filePath, JSON.stringify(items, null, 2), 'utf-8')
}

