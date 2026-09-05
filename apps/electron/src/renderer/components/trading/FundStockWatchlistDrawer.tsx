import React, { useState, useMemo } from 'react'
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetClose,
} from '@/components/ui/sheet'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  isSameSymbol,
  type WatchlistItem,
  type MarketCategory,
  type MarketQuote,
} from '@copis/shared'
import { fmtPrice, fmtPercent } from './trading-chart-utils'
import {
  Search,
  Plus,
  Trash2,
  Pin,
  PinOff,
  ArrowUp,
  ArrowDown,
  X,
  SlidersHorizontal,
  BookmarkCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'

export interface FundStockWatchlistDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  watchlist: WatchlistItem[]
  quotesMap: Record<string, MarketQuote>
  activeSymbol: string
  onSelectSymbol: (symbol: string, name: string, market: MarketCategory) => void
  onRemoveSymbol: (symbol: string) => void
  onTogglePin?: (symbol: string) => void
  onMoveItem?: (symbol: string, direction: 'up' | 'down', targetSymbol?: string) => void
  onClearWatchlist?: () => void
  onAddSymbolClick: () => void
}

const MARKET_FILTER_TABS: Array<{ id: 'all' | MarketCategory; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'cn', label: 'A 股' },
  { id: 'hk', label: '港股' },
  { id: 'us', label: '美股' },
  { id: 'fund', label: '基金/ETF' },
]

export function FundStockWatchlistDrawer({
  open,
  onOpenChange,
  watchlist,
  quotesMap,
  activeSymbol,
  onSelectSymbol,
  onRemoveSymbol,
  onTogglePin,
  onMoveItem,
  onClearWatchlist,
  onAddSymbolClick,
}: FundStockWatchlistDrawerProps): React.ReactElement {
  const [marketFilter, setMarketFilter] = useState<'all' | MarketCategory>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [isConfirmingClear, setIsConfirmingClear] = useState(false)

  // 过滤并按置顶优先排序
  const filteredItems = useMemo(() => {
    let list = [...watchlist]

    if (marketFilter !== 'all') {
      list = list.filter((item) => item.market === marketFilter)
    }

    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase()
      list = list.filter(
        (item) =>
          item.name.toLowerCase().includes(q) ||
          item.symbol.toLowerCase().includes(q)
      )
    }

    // 置顶项优先排在前面，其余保持原有序列
    return list.sort((a, b) => {
      const aPin = a.pinned ? 1 : 0
      const bPin = b.pinned ? 1 : 0
      return bPin - aPin
    })
  }, [watchlist, marketFilter, searchQuery])

  // 各分类数量统计
  const countsByMarket = useMemo(() => {
    const counts = { all: watchlist.length, cn: 0, hk: 0, us: 0, fund: 0 }
    for (const item of watchlist) {
      if (item.market in counts) {
        counts[item.market]++
      }
    }
    return counts
  }, [watchlist])

  const handleClearAll = () => {
    if (!isConfirmingClear) {
      setIsConfirmingClear(true)
      return
    }
    onClearWatchlist?.()
    setIsConfirmingClear(false)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        hideClose
        side="right"
        className="w-[380px] sm:max-w-[420px] p-0 flex flex-col gap-0 bg-card/95 backdrop-blur-md border-l border-border/50 text-foreground z-[100] titlebar-no-drag"
        aria-describedby={undefined}
      >
        <SheetTitle className="sr-only">我的自选</SheetTitle>

        {/* 抽屉顶栏 Header (添加 titlebar-no-drag 避免 Electron 窗口顶部拖拽遮挡点击事件) */}
        <div className="shrink-0 border-b border-border/50 px-4 py-3.5 flex items-center justify-between titlebar-no-drag">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-[var(--ui-primary-background)] text-[var(--ui-primary)]">
              <SlidersHorizontal className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-foreground">我的自选</h3>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted font-medium text-muted-foreground">
                  共 {watchlist.length} 个
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                支持置顶排序、分类筛选与快速移出
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1 titlebar-no-drag">
            <SheetClose asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-foreground cursor-pointer titlebar-no-drag"
                title="关闭抽屉"
              >
                <X className="w-4 h-4 pointer-events-none" />
              </Button>
            </SheetClose>
          </div>
        </div>

        {/* 筛选与搜索工具条 */}
        <div className="shrink-0 px-4 pt-3 pb-2.5 flex flex-col gap-2.5 border-b border-border/30 bg-muted/20">
          {/* 市场分类 Tab */}
          <div className="flex items-center gap-1 overflow-x-auto scrollbar-none pb-0.5">
            {MARKET_FILTER_TABS.map((tab) => {
              const count = countsByMarket[tab.id]
              const isSelected = marketFilter === tab.id
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setMarketFilter(tab.id)}
                  className={cn(
                    'px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors flex items-center gap-1 flex-shrink-0',
                    isSelected
                      ? 'bg-[var(--ui-primary-background)] text-[var(--ui-primary)] font-semibold shadow-xs'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/70'
                  )}
                >
                  <span>{tab.label}</span>
                  <span
                    className={cn(
                      'text-[10px] px-1 py-0.2 rounded-full font-mono',
                      isSelected ? 'bg-[var(--ui-primary)]/15 text-[var(--ui-primary)]' : 'bg-muted/80 text-muted-foreground'
                    )}
                  >
                    {count}
                  </span>
                </button>
              )
            })}
          </div>

          {/* 搜索框 */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="在自选中快速筛选名称或代码..."
              className="h-8 pl-8 pr-8 text-xs bg-background/80"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>

        {/* 标的列表容器 */}
        <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 select-none">
          {filteredItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-center p-4">
              <div className="w-10 h-10 rounded-full bg-muted/60 flex items-center justify-center text-muted-foreground mb-2.5">
                <Search className="w-5 h-5" />
              </div>
              <div className="text-xs text-muted-foreground mb-3">
                <p className="font-medium text-foreground mb-0.5">未找到匹配的标的</p>
                <p>
                  {searchQuery
                    ? '没有符合搜索关键词的自选标的'
                    : '点击下方按钮快速搜索并添加 A 股 / 港股 / 美股 / 基金'}
                </p>
              </div>
              <Button
                size="sm"
                onClick={() => {
                  onOpenChange(false)
                  onAddSymbolClick()
                }}
                className="ui-primary-button gap-1.5 mt-1 text-xs font-medium shadow-xs border border-[color-mix(in_srgb,var(--ui-primary)_30%,transparent)] bg-[var(--ui-primary-background)] text-[var(--ui-primary)] hover:bg-[color-mix(in_srgb,var(--ui-primary)_18%,var(--ui-primary-background))] hover:text-[var(--ui-primary)]"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>立即添加自选标的</span>
              </Button>
            </div>
          ) : (
            filteredItems.map((item, index) => {
              const quote = quotesMap[item.symbol] || quotesMap[item.symbol.toLowerCase()]
              const isActive = isSameSymbol(activeSymbol, item.symbol)
              const isPos = quote ? quote.change > 0 : false
              const isNeg = quote ? quote.change < 0 : false

              const marketLabel =
                item.market === 'cn'
                  ? 'A股'
                  : item.market === 'hk'
                  ? '港股'
                  : item.market === 'us'
                  ? '美股'
                  : '基金'

              return (
                <div
                  key={item.symbol}
                  onClick={() => onSelectSymbol(item.symbol, item.name, item.market)}
                  className={cn(
                    'group/item relative flex items-center justify-between p-2.5 rounded-lg border text-xs cursor-pointer transition-all',
                    isActive
                      ? 'bg-primary/10 border-primary/50 shadow-xs ring-1 ring-primary/30'
                      : 'bg-card/50 border-border/40 hover:bg-accent/40 hover:border-border/70'
                  )}
                >
                  {/* 左侧：标的信息 */}
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <span
                      className={cn(
                        'text-[10px] px-1.5 py-0.5 rounded font-mono font-medium flex-shrink-0',
                        item.market === 'cn' && 'bg-blue-500/10 text-blue-500',
                        item.market === 'hk' && 'bg-orange-500/10 text-orange-500',
                        item.market === 'us' && 'bg-purple-500/10 text-purple-500',
                        item.market === 'fund' && 'bg-emerald-500/10 text-emerald-500'
                      )}
                    >
                      {marketLabel}
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-foreground truncate max-w-[110px]">
                          {item.name}
                        </span>
                        {item.pinned && (
                          <span className="flex-shrink-0" title="已置顶">
                            <Pin className="w-3 h-3 text-primary fill-primary" />
                          </span>
                        )}
                      </div>
                      <span className="font-mono text-[10px] text-muted-foreground block truncate">
                        {item.symbol}
                      </span>
                    </div>
                  </div>

                  {/* 中间：行情数据 */}
                  <div className="text-right flex-shrink-0 px-2 font-mono">
                    <div
                      className={cn(
                        'font-semibold text-xs',
                        isPos && 'text-red-500 dark:text-red-400',
                        isNeg && 'text-emerald-500 dark:text-emerald-400',
                        !isPos && !isNeg && 'text-muted-foreground'
                      )}
                    >
                      {quote ? fmtPrice(quote.price) : '--'}
                    </div>
                    <div
                      className={cn(
                        'text-[10px]',
                        isPos && 'text-red-500/90 dark:text-red-400/90',
                        isNeg && 'text-emerald-500/90 dark:text-emerald-400/90',
                        !isPos && !isNeg && 'text-muted-foreground/70'
                      )}
                    >
                      {quote ? fmtPercent(quote.changePercent) : '--'}
                    </div>
                  </div>

                  {/* 右侧：快捷操作按钮 */}
                  <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover/item:opacity-100 transition-opacity">
                    {/* 置顶切换 */}
                    {onTogglePin && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          onTogglePin(item.symbol)
                        }}
                        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                        title={item.pinned ? '取消置顶' : '置顶标的'}
                        aria-label={item.pinned ? '取消置顶' : '置顶标的'}
                      >
                        {item.pinned ? (
                          <PinOff className="w-3.5 h-3.5 text-primary" />
                        ) : (
                          <Pin className="w-3.5 h-3.5" />
                        )}
                      </button>
                    )}

                    {/* 上移排序 */}
                    {onMoveItem && index > 0 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          onMoveItem(item.symbol, 'up', filteredItems[index - 1]?.symbol)
                        }}
                        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                        title="上移"
                        aria-label="上移"
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </button>
                    )}

                    {/* 下移排序 */}
                    {onMoveItem && index < filteredItems.length - 1 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          onMoveItem(item.symbol, 'down', filteredItems[index + 1]?.symbol)
                        }}
                        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                        title="下移"
                        aria-label="下移"
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </button>
                    )}

                    {/* 移除自选 */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        onRemoveSymbol(item.symbol)
                      }}
                      className="p-1 rounded hover:bg-destructive/15 text-muted-foreground hover:text-destructive transition-colors"
                      title="移出自选"
                      aria-label="移出自选"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* 抽屉底部 Footer 操作区 */}
        <div className="shrink-0 border-t border-border/50 p-3 bg-card/70 flex items-center justify-between gap-2">
          {watchlist.length > 0 && onClearWatchlist ? (
            isConfirmingClear ? (
              <div className="flex items-center gap-1.5">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleClearAll}
                  className="h-8 text-xs px-2.5"
                >
                  确定清空
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsConfirmingClear(false)}
                  className="h-8 text-xs px-2 text-muted-foreground"
                >
                  取消
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearAll}
                className="h-8 text-xs text-muted-foreground hover:text-destructive gap-1 px-2"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>清空自选</span>
              </Button>
            )
          ) : (
            <div />
          )}

          <Button
            size="sm"
            onClick={() => {
              onOpenChange(false)
              onAddSymbolClick()
            }}
            className="ui-primary-button h-8 text-xs gap-1.5 px-3 font-medium shadow-xs border border-[color-mix(in_srgb,var(--ui-primary)_30%,transparent)] bg-[var(--ui-primary-background)] text-[var(--ui-primary)] hover:bg-[color-mix(in_srgb,var(--ui-primary)_18%,var(--ui-primary-background))] hover:text-[var(--ui-primary)] cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>添加自选标的</span>
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
