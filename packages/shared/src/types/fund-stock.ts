/**
 * 基金股市（美股、A 股、港股、基金与 ETF）共享类型与 IPC 通道定义。
 */

export type MarketCategory = 'us' | 'cn' | 'hk' | 'fund'

export interface BidAskLevel {
  price: number
  volume: number
}

export interface MarketQuote {
  symbol: string
  name: string
  market: MarketCategory
  price: number
  change: number
  changePercent: number
  high: number
  low: number
  open: number
  prevClose: number
  volume?: number
  amount?: number
  turnoverRate?: number
  pe?: number
  pb?: number
  marketCap?: number
  bids?: BidAskLevel[]
  asks?: BidAskLevel[]
  sparkline?: number[]
  updatedAt: number
}

export type KlinePeriod = '1m' | '5m' | '15m' | '30m' | '60m' | 'day' | 'week' | 'month'

export interface KlinePoint {
  time: string
  open: number
  close: number
  high: number
  low: number
  volume: number
  amount?: number
}

export interface WatchlistItem {
  id: string
  symbol: string
  name: string
  market: MarketCategory
  group?: string
  pinned?: boolean
  addedAt: number
}

export interface WatchlistGroup {
  id: string
  name: string
}

export interface FundStockSearchResult {
  symbol: string
  name: string
  market: MarketCategory
  pinyin?: string
}

export interface FundStockTerminalStatus {
  running: boolean
  port?: number
  url?: string
  error?: string
}

export const FUND_STOCK_IPC_CHANNELS = {
  GET_QUOTE: 'fund-stock:get-quote',
  GET_KLINES: 'fund-stock:get-klines',
  SEARCH_SYMBOLS: 'fund-stock:search-symbols',
  GET_WATCHLIST: 'fund-stock:get-watchlist',
  SAVE_WATCHLIST: 'fund-stock:save-watchlist',
  TERMINAL_STATUS: 'fund-stock:terminal-status',
  START_TERMINAL: 'fund-stock:start-terminal',
  STOP_TERMINAL: 'fund-stock:stop-terminal',
} as const

export type FundStockIpcChannel = (typeof FUND_STOCK_IPC_CHANNELS)[keyof typeof FUND_STOCK_IPC_CHANNELS]

/**
 * 判断两个标的代码是否指代同一标的（支持宽松前缀匹配、大小写不敏感与去前缀兼容）。
 * 例如：
 * - 'sh600519' 与 '600519' -> true
 * - 'hk00700' 与 '00700' -> true
 * - 'AAPL' 与 'aapl' -> true
 * - 'AAPL' 与 'usAAPL' -> true
 * - 'sh000001' 与 'sz000001' -> false（不同市场前缀明确不匹配）
 */
export function isSameSymbol(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false
  const aNorm = a.trim().toLowerCase()
  const bNorm = b.trim().toLowerCase()
  if (aNorm === bNorm) return true

  const aMatch = aNorm.match(/^(sh|sz|hk|bj|us)(.*)$/)
  const bMatch = bNorm.match(/^(sh|sz|hk|bj|us)(.*)$/)

  const aPrefix = aMatch ? aMatch[1] : ''
  const aBare = aMatch ? aMatch[2] : aNorm

  const bPrefix = bMatch ? bMatch[1] : ''
  const bBare = bMatch ? bMatch[2] : bNorm

  if (!aBare || aBare !== bBare) return false
  if (aPrefix && bPrefix && aPrefix !== bPrefix) return false

  return true
}
