import React, { useMemo } from 'react'
import type { MarketQuote } from '@copis/shared'
import { cn } from '@/lib/utils'
import { fmtCompact, fmtPercent, fmtPrice } from './trading-chart-utils'

export interface FundStockOrderbookPaneProps {
  currentQuote?: MarketQuote
  activeSymbol?: string
  className?: string
}

export function FundStockOrderbookPane({
  currentQuote,
  activeSymbol,
  className,
}: FundStockOrderbookPaneProps): React.JSX.Element {
  const asks = currentQuote?.asks || []
  const bids = currentQuote?.bids || []
  const hasOrderbook = asks.length > 0 && bids.length > 0

  // 1. 买卖力道比（∑bids / ∑asks 量占比）
  const buyVolume = useMemo(() => bids.reduce((sum, lvl) => sum + lvl.volume, 0), [bids])
  const sellVolume = useMemo(() => asks.reduce((sum, lvl) => sum + lvl.volume, 0), [asks])
  const totalVolume = buyVolume + sellVolume
  const buyRatio = totalVolume > 0 ? buyVolume / totalVolume : 0.5

  // 2. 最优买卖档与价差 (Spread)
  const bestBid = bids[0]?.price
  const bestAsk = asks[0]?.price
  const spread =
    bestBid !== undefined && bestAsk !== undefined && bestAsk >= bestBid
      ? bestAsk - bestBid
      : undefined

  // 3. 深度条基准最大档位量（两翼同尺，深度比例完全可比）
  const maxLevelVolume = useMemo(() => {
    if (!hasOrderbook) return 1
    return Math.max(
      ...bids.slice(0, 5).map((l) => l.volume),
      ...asks.slice(0, 5).map((l) => l.volume),
      1
    )
  }, [bids, asks, hasOrderbook])

  // 4. 卖盘倒序展示（卖五在顶、卖一贴近中间价差行）
  const askLevels = useMemo(() => {
    return asks.slice(0, 5).slice().reverse()
  }, [asks])

  // 5. 买盘正序展示（买一贴近中间价差行、买五在底）
  const bidLevels = useMemo(() => {
    return bids.slice(0, 5)
  }, [bids])

  // 6. 委比与委差
  const orderRatio = totalVolume > 0 ? ((buyVolume - sellVolume) / totalVolume) * 100 : 0
  const orderDiff = buyVolume - sellVolume

  // 7. 现价与昨收涨跌方向
  const isUp = currentQuote ? currentQuote.change >= 0 : true

  return (
    <div
      className={cn(
        'w-56 p-4 flex flex-col bg-card/20 border-l border-border/40 text-xs font-mono select-none overflow-hidden',
        className
      )}
    >
      {/* 盘口顶栏 Head (上对齐，与左侧 K 线周期栏统一高度与下边距) */}
      <div className="flex items-center justify-between pb-2.5 border-b border-border/40 min-h-8">
        <div className="flex items-center gap-1.5 font-semibold text-[11px] text-foreground/90">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          <span>实时盘口</span>
        </div>
        <span className="text-[10px] font-sans px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground">
          五档深度
        </span>
      </div>

      {!hasOrderbook ? (
        <div className="flex-1 flex flex-col items-center justify-start text-center text-[11px] text-muted-foreground/70 py-4 gap-2">
          {!currentQuote ? (
            <>
              <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <span>正在获取分时盘口撮合档位...</span>
            </>
          ) : (
            <div className="p-3 rounded-lg bg-muted/20 border border-border/30 text-left w-full space-y-1.5">
              <div className="font-semibold text-foreground/85 text-xs">暂无 Level-2 五档数据</div>
              <div className="text-[10px] text-muted-foreground/80 leading-relaxed">
                当前市场或标的行情源未提供实时五档撮合盘口，主视图持续展示逐笔价格与实时成交。
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 flex flex-col justify-start gap-2.5 my-2 overflow-y-auto trading-scrollbar">
          {/* 买卖力道比 Depth Meter（富途牛牛 / dsh-trading 同款双色填充槽） */}
          <div className="flex flex-col gap-1 pb-1">
            <div className="h-1.5 w-full bg-muted/40 rounded-full overflow-hidden flex">
              <div
                className="h-full bg-red-500 transition-all duration-300"
                style={{ width: `${(buyRatio * 100).toFixed(1)}%` }}
              />
              <div
                className="h-full bg-emerald-500 transition-all duration-300"
                style={{ width: `${((1 - buyRatio) * 100).toFixed(1)}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[10px] text-muted-foreground/80">
              <span className="text-red-500/90">委买 {(buyRatio * 100).toFixed(0)}%</span>
              <span className="text-emerald-500/90">委卖 {((1 - buyRatio) * 100).toFixed(0)}%</span>
            </div>
          </div>

          {/* 卖盘 Asks (卖五 ~ 卖一 倒序) */}
          <div className="flex flex-col gap-0.5">
            {askLevels.map((lvl, i) => {
              const askNumber = 5 - (5 - askLevels.length) - i
              const widthPct = Math.min(100, (lvl.volume / maxLevelVolume) * 100).toFixed(1)
              return (
                <div
                  key={`ask-${i}`}
                  className="relative flex items-center justify-between px-1.5 py-0.5 rounded text-[11px] overflow-hidden hover:bg-muted/40 transition-colors"
                >
                  {/* 深度填充条（靠右对齐或满铺） */}
                  <span
                    className="absolute right-0 top-0 bottom-0 bg-emerald-500/15 pointer-events-none transition-all duration-200"
                    style={{ width: `${widthPct}%` }}
                  />
                  <span className="relative z-1 text-[10px] text-muted-foreground/60 w-7">
                    卖{askNumber}
                  </span>
                  <span className="relative z-1 text-emerald-500 font-semibold flex-1 text-center">
                    {fmtPrice(lvl.price)}
                  </span>
                  <span className="relative z-1 text-muted-foreground/80 text-[11px] text-right w-12 truncate">
                    {fmtCompact(lvl.volume)}
                  </span>
                </div>
              )
            })}
          </div>

          {/* 中间夹层：现价指示与价差行 (Spread Banner) */}
          <div className="my-1.5 py-1 px-2 rounded bg-muted/40 border border-border/40 flex items-center justify-between">
            <div className="flex items-baseline gap-1.5">
              <span className={cn('text-sm font-bold', isUp ? 'text-red-500' : 'text-emerald-500')}>
                {currentQuote ? fmtPrice(currentQuote.price) : '--'}
              </span>
              {currentQuote && (
                <span className={cn('text-[10px] font-medium', isUp ? 'text-red-500' : 'text-emerald-500')}>
                  {fmtPercent(currentQuote.changePercent)}
                </span>
              )}
            </div>
            {spread !== undefined && (
              <span className="text-[10px] text-muted-foreground/75 font-mono">
                差 {fmtPrice(spread)}
              </span>
            )}
          </div>

          {/* 买盘 Bids (买一 ~ 买五 正序) */}
          <div className="flex flex-col gap-0.5">
            {bidLevels.map((lvl, i) => {
              const widthPct = Math.min(100, (lvl.volume / maxLevelVolume) * 100).toFixed(1)
              return (
                <div
                  key={`bid-${i}`}
                  className="relative flex items-center justify-between px-1.5 py-0.5 rounded text-[11px] overflow-hidden hover:bg-muted/40 transition-colors"
                >
                  {/* 深度填充条 */}
                  <span
                    className="absolute right-0 top-0 bottom-0 bg-red-500/15 pointer-events-none transition-all duration-200"
                    style={{ width: `${widthPct}%` }}
                  />
                  <span className="relative z-1 text-[10px] text-muted-foreground/60 w-7">
                    买{i + 1}
                  </span>
                  <span className="relative z-1 text-red-500 font-semibold flex-1 text-center">
                    {fmtPrice(lvl.price)}
                  </span>
                  <span className="relative z-1 text-muted-foreground/80 text-[11px] text-right w-12 truncate">
                    {fmtCompact(lvl.volume)}
                  </span>
                </div>
              )
            })}
          </div>

          {/* 底部微型指标卡片（委比、委差、振幅） */}
          <div className="mt-2 pt-2 border-t border-border/30 grid grid-cols-2 gap-1 text-[10px]">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground/60">委比:</span>
              <span
                className={cn(
                  'font-semibold',
                  orderRatio > 0 ? 'text-red-500' : orderRatio < 0 ? 'text-emerald-500' : 'text-muted-foreground'
                )}
              >
                {orderRatio > 0 ? `+${orderRatio.toFixed(1)}%` : `${orderRatio.toFixed(1)}%`}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground/60">委差:</span>
              <span
                className={cn(
                  'font-semibold',
                  orderDiff > 0 ? 'text-red-500' : orderDiff < 0 ? 'text-emerald-500' : 'text-muted-foreground'
                )}
              >
                {orderDiff > 0 ? `+${fmtCompact(orderDiff)}` : fmtCompact(orderDiff)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground/60">最高:</span>
              <span className="text-red-500 font-medium">
                {currentQuote?.high ? fmtPrice(currentQuote.high) : '--'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground/60">最低:</span>
              <span className="text-emerald-500 font-medium">
                {currentQuote?.low ? fmtPrice(currentQuote.low) : '--'}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
