/**
 * FundStockSearchDialog - 基金股市专用搜索弹窗
 *
 * UI 风格严格对齐主菜单全局搜索弹窗 (SearchDialog)：
 * - 采用 Radix Dialog 架构与全屏毛玻璃背景遮罩
 * - 输入框支持清空、即时防抖联想与 Enter / 点击搜索
 * - 搜索建议列表支持高亮匹配文本、市场徽章、拼音代码互搜
 * - 支持键盘上下键选择、Enter 打开标的页签并加入自选、Esc 关闭
 * - 空输入时展示热门推荐标的（A股/港股/美股/ETF）
 */

import * as React from 'react'
import { Search, X, Loader2, TrendingUp, Plus, Check } from 'lucide-react'
import { Dialog, DialogContent, DialogPortal, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { isSameSymbol, type FundStockSearchResult, type MarketCategory, type MarketQuote } from '@copis/shared'

export interface FundStockSearchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (item: FundStockSearchResult) => void
  quotesMap?: Record<string, MarketQuote>
  openSymbols?: string[]
}

/** 热门精选标的推荐 */
const POPULAR_RECOMMENDATIONS: FundStockSearchResult[] = [
  { symbol: 'sh600519', name: '贵州茅台', market: 'cn', pinyin: 'GZMT' },
  { symbol: 'hk00700', name: '腾讯控股', market: 'hk', pinyin: 'TXKG' },
  { symbol: 'AAPL', name: '苹果', market: 'us', pinyin: 'PG' },
  { symbol: 'sh510300', name: '沪深300ETF', market: 'fund', pinyin: 'HS300ETF' },
  { symbol: 'NVDA', name: '英伟达', market: 'us', pinyin: 'YWD' },
  { symbol: 'sz159915', name: '创业板ETF', market: 'fund', pinyin: 'CYBETF' },
]


/** 市场标签及着色 */
function MarketBadge({ market }: { market: MarketCategory }): React.ReactElement {
  switch (market) {
    case 'cn':
      return (
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-red-500/10 text-red-500 dark:text-red-400 font-medium">
          A股
        </span>
      )
    case 'hk':
      return (
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500 dark:text-blue-400 font-medium">
          港股
        </span>
      )
    case 'us':
      return (
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-500 dark:text-indigo-400 font-medium">
          美股
        </span>
      )
    case 'fund':
      return (
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500 dark:text-amber-400 font-medium">
          基金
        </span>
      )
    default:
      return (
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">
          标的
        </span>
      )
  }
}

/** 高亮文本中的匹配部分 */
export function HighlightText({ text, query }: { text: string; query: string }): React.ReactElement {
  if (!query) return <>{text}</>

  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const parts: React.ReactNode[] = []
  let lastIndex = 0

  let idx = lowerText.indexOf(lowerQuery)
  while (idx !== -1) {
    if (idx > lastIndex) {
      parts.push(text.slice(lastIndex, idx))
    }
    parts.push(
      <mark key={idx} className="bg-primary/20 text-foreground rounded-sm px-0.5">
        {text.slice(idx, idx + query.length)}
      </mark>
    )
    lastIndex = idx + query.length
    idx = lowerText.indexOf(lowerQuery, lastIndex)
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return <>{parts}</>
}

export function FundStockSearchDialog({
  open,
  onOpenChange,
  onSelect,
  quotesMap = {},
  openSymbols = [],
}: FundStockSearchDialogProps): React.ReactElement {
  const [query, setQuery] = React.useState('')
  const [committedQuery, setCommittedQuery] = React.useState('')
  const [results, setResults] = React.useState<FundStockSearchResult[]>([])
  const [loading, setLoading] = React.useState(false)
  const [hasSearched, setHasSearched] = React.useState(false)
  const [selectedIndex, setSelectedIndex] = React.useState(0)

  const inputRef = React.useRef<HTMLInputElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const isComposingRef = React.useRef(false)
  const searchTokenRef = React.useRef(0)

  // 打开时重置状态并自动聚焦输入框
  React.useEffect(() => {
    if (open) {
      searchTokenRef.current += 1
      setQuery('')
      setCommittedQuery('')
      setResults([])
      setHasSearched(false)
      setSelectedIndex(0)
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  // 执行搜索
  const runSearch = React.useCallback(
    async (overrideQuery?: string) => {
      const q = (overrideQuery !== undefined ? overrideQuery : query).trim()
      if (!q) return

      const token = ++searchTokenRef.current
      setLoading(true)
      setHasSearched(true)
      setCommittedQuery(q)

      try {
        const res = await window.electronAPI.fundStock.searchSymbols(q)
        if (token === searchTokenRef.current) {
          setResults(res)
          setSelectedIndex(0)
        }
      } catch (err) {
        console.error('[基金股市] 搜索标的异常:', err)
        if (token === searchTokenRef.current) {
          setResults([])
        }
      } finally {
        if (token === searchTokenRef.current) {
          setLoading(false)
        }
      }
    },
    [query]
  )

  // 防抖即时搜索（输入 200ms 后自动请求）
  React.useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      setResults([])
      setHasSearched(false)
      setCommittedQuery('')
      return
    }

    const timer = setTimeout(() => {
      void runSearch(trimmed)
    }, 200)

    return () => clearTimeout(timer)
  }, [query, runSearch])

  // 键盘导航
  const displayedItems = query.trim() ? results : POPULAR_RECOMMENDATIONS

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        if (isComposingRef.current) return
        e.preventDefault()
        if (displayedItems[selectedIndex]) {
          onSelect(displayedItems[selectedIndex]!)
          onOpenChange(false)
        } else {
          void runSearch()
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.min(prev + 1, displayedItems.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.max(prev - 1, 0))
      }
    },
    [displayedItems, selectedIndex, onSelect, onOpenChange, runSearch]
  )

  // 自动滚动选中项到可视区域
  React.useEffect(() => {
    const list = listRef.current
    if (!list) return
    const selected = list.querySelector(`[data-index="${selectedIndex}"]`)
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  const trimmedQuery = query.trim()
  const canSearch = trimmedQuery.length > 0 && !loading

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      {open && (
        <DialogPortal>
          <div
            aria-hidden
            className="fixed inset-0 z-[99] bg-black/40 pointer-events-none animate-in fade-in-0 duration-150 backdrop-blur-xs"
          />
        </DialogPortal>
      )}

      <DialogContent
        hideClose
        className="sm:max-w-[520px] p-0 gap-0 overflow-hidden shadow-2xl border border-border/80 rounded-2xl bg-popover"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">搜索股票与基金</DialogTitle>

        {/* 顶部搜索输入栏（与主菜单 SearchDialog 结构与视觉一致） */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/50 bg-card/60">
          <Search size={16} className="text-foreground/40 flex-shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onCompositionStart={() => {
              isComposingRef.current = true
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false
            }}
            onKeyDown={handleKeyDown}
            placeholder="搜索股票/基金/ETF代码、拼音或名称 (如 600519、AAPL、腾讯)"
            className="flex-1 bg-transparent text-[14px] text-foreground placeholder:text-foreground/40 outline-none"
          />

          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery('')
                setResults([])
                setHasSearched(false)
                setCommittedQuery('')
                inputRef.current?.focus()
              }}
              title="清空"
              className="p-0.5 rounded text-foreground/30 hover:text-foreground/60 transition-colors"
            >
              <X size={14} />
            </button>
          )}

          <button
            type="button"
            onClick={() => void runSearch()}
            disabled={!canSearch}
            className={cn(
              'flex items-center gap-1 px-2.5 py-1 rounded-md text-[12px] font-medium transition-colors select-none',
              canSearch
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'bg-foreground/[0.06] text-foreground/30 cursor-not-allowed'
            )}
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
            <span>搜索</span>
          </button>
        </div>

        {/* 结果列表 */}
        <div className="relative">
          <div ref={listRef} className="max-h-[380px] overflow-y-auto scrollbar-thin divide-y divide-border/30">
            {/* 未输入任何词时展示热门精选推荐 */}
            {!trimmedQuery && (
              <div className="py-2 animate-in fade-in duration-150">
                <div className="flex items-center gap-1.5 px-4 pt-1.5 pb-2 text-[11px] font-semibold text-muted-foreground select-none">
                  <TrendingUp className="w-3.5 h-3.5 text-primary" />
                  <span>热门标的推荐</span>
                </div>
                {POPULAR_RECOMMENDATIONS.map((item, idx) => {
                  const isSelected = selectedIndex === idx
                  const q = quotesMap[item.symbol] || quotesMap[item.symbol.toLowerCase()]
                  const isAlreadyOpen = openSymbols.some((s) => isSameSymbol(s, item.symbol))

                  return (
                    <button
                      key={`pop-${item.symbol}`}
                      type="button"
                      data-index={idx}
                      onClick={() => {
                        onSelect(item)
                        onOpenChange(false)
                      }}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      className={cn(
                        'w-full px-4 py-2.5 text-left transition-colors flex items-center justify-between gap-3 group',
                        isSelected ? 'bg-primary/10' : 'hover:bg-foreground/[0.04]'
                      )}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <MarketBadge market={item.market} />
                        <span className="text-[13px] font-medium text-foreground truncate">
                          {item.name}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">{item.symbol}</span>
                      </div>

                      <div className="flex items-center gap-2 flex-shrink-0">
                        {q && (
                          <div className="text-right font-mono text-xs">
                            <span
                              className={cn(
                                'font-semibold mr-1.5',
                                q.change > 0 && 'text-red-500 dark:text-red-400',
                                q.change < 0 && 'text-emerald-500 dark:text-emerald-400'
                              )}
                            >
                              {q.price.toFixed(item.market === 'fund' ? 3 : 2)}
                            </span>
                            <span
                              className={cn(
                                'text-[11px]',
                                q.change > 0 && 'text-red-500 dark:text-red-400',
                                q.change < 0 && 'text-emerald-500 dark:text-emerald-400'
                              )}
                            >
                              {q.changePercent > 0 ? '+' : ''}
                              {q.changePercent.toFixed(2)}%
                            </span>
                          </div>
                        )}
                        {isAlreadyOpen ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400 px-2 py-0.5 rounded bg-emerald-500/10">
                            <Check className="w-3 h-3" />
                            <span>已打开</span>
                          </span>
                        ) : (
                          <span className="p-1 rounded-md text-primary opacity-0 group-hover:opacity-100 transition-opacity bg-primary/10">
                            <Plus className="w-3 h-3" />
                          </span>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            )}

            {/* 加载状态 */}
            {hasSearched && loading && results.length === 0 && (
              <div className="py-12 flex items-center justify-center gap-2 text-[13px] text-foreground/40">
                <Loader2 size={16} className="animate-spin text-primary" />
                <span>正在匹配全市场标的...</span>
              </div>
            )}

            {/* 无匹配结果 */}
            {hasSearched && !loading && results.length === 0 && (
              <div className="py-10 flex flex-col items-center justify-center gap-2 text-center text-muted-foreground">
                <span className="text-sm font-medium text-foreground/70">未找到相关标的</span>
                <span className="text-xs text-muted-foreground/70 max-w-xs">
                  未匹配到“{committedQuery}”，请尝试输入股票代码（如 600519、00700、AAPL）或拼音首字母缩写。
                </span>
              </div>
            )}

            {/* 搜索结果列表 */}
            {results.length > 0 && (
              <div className="py-1 animate-in fade-in duration-150">
                <div className="px-4 pt-2 pb-1.5 text-[11px] font-medium text-foreground/40 select-none">
                  匹配标的 ({results.length})
                </div>

                {results.map((item, idx) => {
                  const isSelected = selectedIndex === idx
                  const q = quotesMap[item.symbol] || quotesMap[item.symbol.toLowerCase()]
                  const isAlreadyOpen = openSymbols.some((s) => isSameSymbol(s, item.symbol))

                  return (
                    <button
                      key={`res-${item.symbol}-${idx}`}
                      type="button"
                      data-index={idx}
                      onClick={() => {
                        onSelect(item)
                        onOpenChange(false)
                      }}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      className={cn(
                        'w-full px-4 py-2.5 text-left transition-colors flex items-center justify-between gap-3 group',
                        isSelected ? 'bg-primary/10' : 'hover:bg-foreground/[0.04]'
                      )}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <MarketBadge market={item.market} />
                        <span className="text-[13px] font-medium text-foreground truncate">
                          <HighlightText text={item.name} query={committedQuery || query} />
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                          <HighlightText text={item.symbol} query={committedQuery || query} />
                        </span>
                      </div>

                      <div className="flex items-center gap-2 flex-shrink-0">
                        {q && (
                          <div className="text-right font-mono text-xs">
                            <span
                              className={cn(
                                'font-semibold mr-1.5',
                                q.change > 0 && 'text-red-500 dark:text-red-400',
                                q.change < 0 && 'text-emerald-500 dark:text-emerald-400'
                              )}
                            >
                              {q.price.toFixed(item.market === 'fund' ? 3 : 2)}
                            </span>
                            <span
                              className={cn(
                                'text-[11px]',
                                q.change > 0 && 'text-red-500 dark:text-red-400',
                                q.change < 0 && 'text-emerald-500 dark:text-emerald-400'
                              )}
                            >
                              {q.changePercent > 0 ? '+' : ''}
                              {q.changePercent.toFixed(2)}%
                            </span>
                          </div>
                        )}
                        {isAlreadyOpen ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400 px-2 py-0.5 rounded bg-emerald-500/10">
                            <Check className="w-3 h-3" />
                            <span>已打开</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-primary opacity-0 group-hover:opacity-100 transition-opacity px-2 py-0.5 rounded bg-primary/10">
                            <Plus className="w-3 h-3" />
                            <span>打开页签</span>
                          </span>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* 底部快捷键提示（与主菜单 SearchDialog 结构一致） */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border/30 text-[11px] text-foreground/40 bg-muted/20">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="px-1.5 py-0.5 rounded bg-foreground/[0.06] font-mono text-[10px]">↵</kbd>
              <span>打开页签</span>
            </span>
            {displayedItems.length > 0 && (
              <span className="flex items-center gap-1">
                <kbd className="px-1.5 py-0.5 rounded bg-foreground/[0.06] font-mono text-[10px]">↑↓</kbd>
                <span>选择</span>
              </span>
            )}
            <span className="flex items-center gap-1">
              <kbd className="px-1.5 py-0.5 rounded bg-foreground/[0.06] font-mono text-[10px]">Esc</kbd>
              <span>关闭</span>
            </span>
          </div>

          <div className="text-[10px] text-muted-foreground/60 font-medium select-none">
            A股 · 港股 · 美股 · 基金ETF
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
