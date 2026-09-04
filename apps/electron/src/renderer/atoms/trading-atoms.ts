/**
 * 基金股市（美股、A 股、港股、基金与 ETF）前端状态管理。
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type {
  FundStockTerminalStatus,
  KlinePeriod,
  KlinePoint,
  MarketCategory,
  MarketQuote,
  WatchlistItem,
} from '@copis/shared'

/** 用户自选列表 */
export const tradingWatchlistAtom = atom<WatchlistItem[]>([])

/** 当前聚焦查看的标的代码（默认贵州茅台） */
export const activeSymbolAtom = atom<string>('sh600519')

/** 市场分类筛选器：all | cn | hk | us | fund */
export const activeMarketFilterAtom = atom<MarketCategory | 'all'>('all')

/** 实时行情缓存 Map (以规范化 symbol 为键) */
export const tradingQuotesMapAtom = atom<Record<string, MarketQuote>>({})

/** 终端后台服务状态 */
export const tradingTerminalStatusAtom = atom<FundStockTerminalStatus>({ running: false })

/** 当前选中的 K 线周期 */
export const activeKlinePeriodAtom = atom<KlinePeriod>('day')

/** 当前标的 K 线历史数据 */
export const activeKlinesAtom = atom<KlinePoint[]>([])

/** K 线数据加载状态 */
export const klinesLoadingAtom = atom<boolean>(false)

/** 搜索框关键词 */
export const symbolSearchQueryAtom = atom<string>('')

/** 内容区打开的标的页签项 */
export interface TradingTabItem {
  symbol: string
  name: string
  market: MarketCategory
}

/** 内容区已打开的标的页签列表 */
export const tradingOpenTabsAtom = atom<TradingTabItem[]>([])

export const DEFAULT_TRADING_AI_DOCK_WIDTH = 288
export const MIN_TRADING_AI_DOCK_WIDTH = 220
export const MAX_TRADING_AI_DOCK_WIDTH = 520

/** 基金股市右侧 AI 投研助手栏宽度（默认 288px，支持在 220px ~ 520px 之间拖拽调节，持久化至 localStorage） */
export const tradingAiDockWidthAtom = atomWithStorage<number>(
  'copis-trading-ai-dock-width',
  DEFAULT_TRADING_AI_DOCK_WIDTH
)

/** 基金股市右侧 AI 投研助手绑定的专属会话 ID（持久化至 localStorage） */
export const tradingAiSessionIdAtom = atomWithStorage<string | null>(
  'copis-trading-ai-session-id',
  null
)

