import React from 'react'
import { useSetAtom } from 'jotai'
import { ExternalLink, TrendingDown, TrendingUp } from 'lucide-react'
import type { MarketQuote } from '@copis/shared'
import { activeViewAtom } from '@/atoms/active-view'
import { activeSymbolAtom } from '@/atoms/trading-atoms'
import { cn } from '@/lib/utils'

interface StockQuoteCardProps {
  quote: MarketQuote
  compact?: boolean
  className?: string
}

export function StockQuoteCard({ quote, compact = false, className }: StockQuoteCardProps): React.ReactElement {
  const setActiveView = useSetAtom(activeViewAtom)
  const setActiveSymbol = useSetAtom(activeSymbolAtom)

  const isPositive = quote.change > 0
  const isNegative = quote.change < 0
  const isZero = quote.change === 0

  const handleOpenTerminal = (): void => {
    setActiveSymbol(quote.symbol)
    setActiveView('fund-stock')
  }

  const marketTag = {
    cn: 'A股',
    hk: '港股',
    us: '美股',
    fund: '基金',
  }[quote.market] || 'A股'

  return (
    <div
      className={cn(
        'rounded-xl border border-border/60 bg-card p-3 shadow-sm hover:border-primary/40 transition-colors',
        className
      )}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
            {marketTag}
          </span>
          <span className="font-semibold text-sm truncate text-foreground">{quote.name}</span>
          <span className="text-xs text-muted-foreground font-mono">{quote.symbol}</span>
        </div>
        <button
          type="button"
          onClick={handleOpenTerminal}
          className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors"
          title="在基金股市中打开大图"
        >
          <span>查看</span>
          <ExternalLink className="w-3 h-3" />
        </button>
      </div>

      <div className="flex items-baseline justify-between gap-4 mt-2">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              'text-lg font-bold font-mono tracking-tight',
              isPositive && 'text-red-500 dark:text-red-400',
              isNegative && 'text-emerald-500 dark:text-emerald-400',
              isZero && 'text-muted-foreground'
            )}
          >
            {quote.price.toFixed(quote.market === 'fund' ? 3 : 2)}
          </span>
          <div
            className={cn(
              'flex items-center gap-0.5 text-xs font-medium font-mono px-1.5 py-0.5 rounded',
              isPositive && 'bg-red-500/10 text-red-500 dark:text-red-400',
              isNegative && 'bg-emerald-500/10 text-emerald-500 dark:text-emerald-400',
              isZero && 'bg-muted text-muted-foreground'
            )}
          >
            {isPositive && <TrendingUp className="w-3 h-3" />}
            {isNegative && <TrendingDown className="w-3 h-3" />}
            <span>
              {isPositive ? '+' : ''}
              {quote.changePercent.toFixed(2)}%
            </span>
          </div>
        </div>

        {!compact && (
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <div>
              <span>高: </span>
              <span className="font-mono text-foreground">{quote.high.toFixed(2)}</span>
            </div>
            <div>
              <span>低: </span>
              <span className="font-mono text-foreground">{quote.low.toFixed(2)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
