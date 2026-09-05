/**
 * 基金股市（美股、A 股、港股、基金与 ETF）全功能三栏交互工作台。
 *
 * 遵循 AGENTS.md 规范：
 * - 状态管理全部采用 Jotai；
 * - 纯数据展示与 AI 投研对话，不包含任何交易指令；
 * - 现代卡片与阴影设计，适配深浅色主题；
 * - 中文注释与专业术语。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  BarChart3,
  Bookmark,
  Check,
  ChevronRight,
  CornerDownLeft,
  Flame,
  Loader2,
  Maximize2,
  Menu,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
  TrendingDown,
  TrendingUp,
  X,
} from 'lucide-react'
import {
  COPIS_WORKING_CHANNEL_IDS,
  isSameSymbol,
  workingModelCatalogToOptions,
  type FundStockSearchResult,
  type KlinePeriod,
  type KlinePoint,
  type MarketCategory,
  type MarketQuote,
  type WatchlistItem,
} from '@copis/shared'
import { activeViewAtom } from '@/atoms/active-view'
import {
  DEFAULT_TRADING_AI_DOCK_WIDTH,
  MAX_TRADING_AI_DOCK_WIDTH,
  MIN_TRADING_AI_DOCK_WIDTH,
  activeKlinePeriodAtom,
  activeKlinesAtom,
  activeMarketFilterAtom,
  activeSymbolAtom,
  klinesLoadingAtom,
  tradingAiDockWidthAtom,
  tradingAiSessionIdAtom,
  tradingOpenTabsAtom,
  tradingQuotesMapAtom,
  tradingWatchlistAtom,
} from '@/atoms/trading-atoms'
import {
  agentChannelIdAtom,
  agentModelIdAtom,
  agentSessionsAtom,
  agentWorkspacesAtom,
} from '@/atoms/agent-atoms'
import { draftSessionIdsAtom } from '@/atoms/draft-session-atoms'
import { composerInputHistoryAtom, appendHistoryEntry } from '@/atoms/composer-history'
import { workingModelCatalogAtom } from '@/atoms/working-model-catalog-atoms'
import { AgentConversationSurface } from '@/components/agent/AgentConversationSurface'
import { ModelSelector } from '@/components/model/ModelSelector'
import { RichTextInput } from '@/components/ai-elements/rich-text-input'
import { SpeechButton } from '@/components/ai-elements/speech-button'
import { InputToolbarOverflow, type ToolbarItem } from '@/components/ai-elements/InputToolbarOverflow'
import {
  inputToolbarButtonClass,
  inputToolbarDisabledButtonClass,
  inputToolbarSendButtonClass,
} from '@/components/ai-elements/input-toolbar-styles'
import { useOpenSession } from '@/hooks/useOpenSession'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { FundStockSearchDialog } from './FundStockSearchDialog'
import { FundStockWatchlistDrawer } from './FundStockWatchlistDrawer'
import { TradingViewKlineChart } from './TradingViewKlineChart'
import { FundStockOrderbookPane } from './FundStockOrderbookPane'
import {
  fmtChange,
  fmtCompact,
  fmtPercent,
  fmtPrice,
} from './trading-chart-utils'

export function FundStockTerminalView(): React.ReactElement {
  const [watchlist, setWatchlist] = useAtom(tradingWatchlistAtom)
  const [activeSymbol, setActiveSymbol] = useAtom(activeSymbolAtom)
  const [openTabs, setOpenTabs] = useAtom(tradingOpenTabsAtom)
  const [marketFilter, setMarketFilter] = useAtom(activeMarketFilterAtom)
  const [quotesMap, setQuotesMap] = useAtom(tradingQuotesMapAtom)
  const [period, setPeriod] = useAtom(activeKlinePeriodAtom)
  const [klines, setKlines] = useAtom(activeKlinesAtom)
  const [klinesLoading, setKlinesLoading] = useAtom(klinesLoadingAtom)

  const [searchOpen, setSearchOpen] = useState(false)
  const [watchlistDrawerOpen, setWatchlistDrawerOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [hoverKlineIndex, setHoverKlineIndex] = useState<number | null>(null)
  const [hoveredKlinePoint, setHoveredKlinePoint] = useState<KlinePoint | null>(null)
  const [maVisible, setMaVisible] = useState({ ma5: true, ma10: true, ma20: true, ma30: true })
  const [aiDockWidth, setAiDockWidth] = useAtom(tradingAiDockWidthAtom)

  const tabListRef = useRef<HTMLDivElement>(null)
  const isResizingRef = useRef(false)
  const hasInitializedRef = useRef(false)

  const setActiveView = useSetAtom(activeViewAtom)
  const openSession = useOpenSession()
  const agentChannelId = useAtomValue(agentChannelIdAtom)
  const agentModelId = useAtomValue(agentModelIdAtom)
  const agentSessions = useAtomValue(agentSessionsAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const agentWorkspaces = useAtomValue(agentWorkspacesAtom)
  const setDraftSessionIds = useSetAtom(draftSessionIdsAtom)
  const [tradingSessionId, setTradingSessionId] = useAtom(tradingAiSessionIdAtom)
  const [composerInput, setComposerInput] = useState('')
  const [isSendingPrompt, setIsSendingPrompt] = useState(false)
  const [composerHistory, setComposerHistory] = useAtom(composerInputHistoryAtom)
  const workingModelCatalog = useAtomValue(workingModelCatalogAtom)
  const setAgentChannelId = useSetAtom(agentChannelIdAtom)
  const setAgentModelId = useSetAtom(agentModelIdAtom)

  const customModelOptions = useMemo(
    () => workingModelCatalogToOptions(workingModelCatalog),
    [workingModelCatalog]
  )

  const investmentWorkspace = useMemo(() => {
    return agentWorkspaces.find((w) => w.slug === 'investment' || w.name === '我的投资')
  }, [agentWorkspaces])
  const investmentWorkspaceId = investmentWorkspace?.id

  // 动态获取或缓存「我的投资」固定工作区 ID
  const resolveInvestmentWorkspaceId = useCallback(async (): Promise<string | undefined> => {
    if (investmentWorkspaceId) return investmentWorkspaceId
    try {
      const remoteWorkspaces = await window.electronAPI.listAgentWorkspaces()
      const found = remoteWorkspaces.find((w) => w.slug === 'investment' || w.name === '我的投资')
      if (found) return found.id
    } catch {
      // fail-soft
    }
    return undefined
  }, [investmentWorkspaceId])

  // 确保右侧栏拥有一个有效的 AI 投研助手专属会话（固定在「我的投资」工作区）
  const ensureTradingSession = useCallback(async (): Promise<string | undefined> => {
    const targetWorkspaceId = await resolveInvestmentWorkspaceId()

    if (tradingSessionId) {
      const existing = agentSessions.find((s) => s.id === tradingSessionId)
      // 若该会话存在，且若已获得固定工作区 ID 时要求其属于「我的投资」工作区
      if (existing && (!targetWorkspaceId || existing.workspaceId === targetWorkspaceId)) {
        return existing.id
      }
      if (!existing) {
        try {
          const remoteSessions = await window.electronAPI.listAgentSessions()
          const remoteFound = remoteSessions.find((s) => s.id === tradingSessionId)
          if (remoteFound) {
            setAgentSessions(remoteSessions)
            if (!targetWorkspaceId || remoteFound.workspaceId === targetWorkspaceId) {
              return tradingSessionId
            }
          }
        } catch {
          // fail-soft
        }
      }
    }

    // 优先复用属于「我的投资」工作区且标题为「AI 投研助手」的最近会话
    if (targetWorkspaceId) {
      const existingInvestmentSession = agentSessions.find(
        (s) => s.workspaceId === targetWorkspaceId && s.title === 'AI 投研助手'
      )
      if (existingInvestmentSession) {
        setTradingSessionId(existingInvestmentSession.id)
        return existingInvestmentSession.id
      }
    }

    try {
      const session = await window.electronAPI.createAgentSession(
        'AI 投研助手',
        agentChannelId ?? undefined,
        targetWorkspaceId ?? undefined,
        agentModelId ?? undefined
      )
      setAgentSessions((prev) => [session, ...prev])
      setDraftSessionIds((prev) => {
        const next = new Set(prev)
        next.add(session.id)
        return next
      })
      setTradingSessionId(session.id)
      return session.id
    } catch (err) {
      console.error('[我的投资] 创建投研助手专属会话失败:', err)
      return undefined
    }
  }, [
    agentChannelId,
    agentModelId,
    agentSessions,
    resolveInvestmentWorkspaceId,
    setAgentSessions,
    setDraftSessionIds,
    setTradingSessionId,
    tradingSessionId,
  ])

  useEffect(() => {
    void ensureTradingSession()
  }, [ensureTradingSession])

  // 开启新投研助手会话（固定在「我的投资」工作区）
  const handleStartNewTradingSession = useCallback(async () => {
    const targetWorkspaceId = await resolveInvestmentWorkspaceId()

    try {
      const session = await window.electronAPI.createAgentSession(
        'AI 投研助手',
        agentChannelId ?? undefined,
        targetWorkspaceId ?? undefined,
        agentModelId ?? undefined
      )
      setAgentSessions((prev) => [session, ...prev])
      setDraftSessionIds((prev) => {
        const next = new Set(prev)
        next.add(session.id)
        return next
      })
      setTradingSessionId(session.id)
    } catch (err) {
      console.error('[我的投资] 开启新投研会话失败:', err)
    }
  }, [
    agentChannelId,
    agentModelId,
    resolveInvestmentWorkspaceId,
    setAgentSessions,
    setDraftSessionIds,
    setTradingSessionId,
  ])

  // 拖拽调整右侧 AI 投研助手栏宽度
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      isResizingRef.current = true

      const startX = e.clientX
      const startWidth = aiDockWidth
      let rafId = 0

      const originalUserSelect = document.body.style.userSelect
      const originalCursor = document.body.style.cursor
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'

      const onMouseMove = (ev: MouseEvent) => {
        if (!isResizingRef.current) return
        if (rafId) return
        rafId = requestAnimationFrame(() => {
          rafId = 0
          // 向左拖动 (ev.clientX < startX) 时宽度增加，向右拖动时宽度减少
          const delta = startX - ev.clientX
          const clamped = Math.max(
            MIN_TRADING_AI_DOCK_WIDTH,
            Math.min(MAX_TRADING_AI_DOCK_WIDTH, startWidth + delta)
          )
          setAiDockWidth(clamped)
        })
      }

      const onMouseUp = () => {
        isResizingRef.current = false
        if (rafId) cancelAnimationFrame(rafId)
        document.body.style.userSelect = originalUserSelect
        document.body.style.cursor = originalCursor
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', onMouseUp)
      }

      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
    },
    [aiDockWidth, setAiDockWidth]
  )

  useEffect(() => {
    return () => {
      isResizingRef.current = false
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [])

  // 当激活标的切换时，平滑滚动将当前激活页签滚动至可视区域
  useEffect(() => {
    if (!activeSymbol || !tabListRef.current) return
    const activeTabEl = tabListRef.current.querySelector(`[data-symbol="${activeSymbol}"]`)
    if (activeTabEl) {
      activeTabEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
    }
  }, [activeSymbol])

  // 1. 初始化加载自选列表与默认页签（仅在挂载时初始化一次，避免关闭最后一个页签时被重复自动恢复打开）
  useEffect(() => {
    if (hasInitializedRef.current) return
    hasInitializedRef.current = true

    void (async () => {
      try {
        const items = await window.electronAPI.fundStock.getWatchlist()
        setWatchlist(items)
        if (items.length > 0 && !activeSymbol && items[0]) {
          const sorted = [...items].sort((a, b) => {
            const aPin = a.pinned ? 1 : 0
            const bPin = b.pinned ? 1 : 0
            return bPin - aPin
          })
          const initial = sorted[0] || items[0]
          setActiveSymbol(initial.symbol)
          setOpenTabs((prev) => {
            if (prev.length > 0) return prev
            return [{ symbol: initial.symbol, name: initial.name, market: initial.market }]
          })
        } else if (activeSymbol) {
          setOpenTabs((prev) => {
            if (prev.length > 0) return prev
            const target = items.find((i) => i.symbol.toLowerCase() === activeSymbol.toLowerCase())
            return [
              {
                symbol: activeSymbol,
                name: target?.name || activeSymbol,
                market: target?.market || 'cn',
              },
            ]
          })
        }
      } catch (err) {
        console.error('[基金股市] 读取自选失败:', err)
      }
    })()
  }, [activeSymbol, setActiveSymbol, setOpenTabs, setWatchlist])

  // 2. 批量刷新自选行情
  const refreshQuotes = useCallback(async () => {
    if (!watchlist.length && !activeSymbol) return
    setRefreshing(true)
    try {
      const symbolsToFetch = Array.from(
        new Set([...watchlist.map((w) => w.symbol), activeSymbol].filter(Boolean))
      )
      const quotes = await window.electronAPI.fundStock.getQuote(symbolsToFetch)
      const map: Record<string, MarketQuote> = {}
      for (const q of quotes) {
        map[q.symbol] = q
        map[q.symbol.toLowerCase()] = q
        map[q.symbol.toUpperCase()] = q
        const bare = q.symbol.replace(/^(sh|sz|hk|bj|us)/i, '')
        if (bare) {
          map[bare] = q
          map[bare.toLowerCase()] = q
          map[bare.toUpperCase()] = q
        }
      }
      setQuotesMap((prev) => ({ ...prev, ...map }))
    } catch (err) {
      console.error('[基金股市] 刷新行情失败:', err)
    } finally {
      setRefreshing(false)
    }
  }, [activeSymbol, setQuotesMap, watchlist])

  // 实时行情检索辅助（支持多种 symbol 大小写与市场前缀双向容错）
  const getQuote = useCallback(
    (sym?: string): MarketQuote | undefined => {
      if (!sym) return undefined
      const clean = sym.trim()
      const lower = clean.toLowerCase()
      const upper = clean.toUpperCase()
      const bare = clean.replace(/^(sh|sz|hk|bj|us)/i, '')
      return (
        quotesMap[clean] ||
        quotesMap[lower] ||
        quotesMap[upper] ||
        (bare
          ? quotesMap[bare] ||
            quotesMap[`sh${bare}`] ||
            quotesMap[`sz${bare}`] ||
            quotesMap[`hk${bare}`] ||
            quotesMap[`us${bare}`] ||
            quotesMap[`sh${bare.toLowerCase()}`] ||
            quotesMap[`sz${bare.toLowerCase()}`] ||
            quotesMap[`hk${bare.toLowerCase()}`]
          : undefined)
      )
    },
    [quotesMap]
  )

  useEffect(() => {
    void refreshQuotes()
    const timer = setInterval(() => {
      void refreshQuotes()
    }, 10000)
    return () => clearInterval(timer)
  }, [refreshQuotes])

  // 3. 加载当前标的 K 线历史数据
  useEffect(() => {
    if (!activeSymbol) return
    let active = true
    setKlinesLoading(true)
    void (async () => {
      try {
        const points = await window.electronAPI.fundStock.getKlines(activeSymbol, period, 100)
        if (active) {
          setKlines(points)
        }
      } catch (err) {
        console.error('[基金股市] 加载 K 线失败:', err)
      } finally {
        if (active) setKlinesLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [activeSymbol, period, setKlines, setKlinesLoading])

  // 当前处于激活状态的内容区标的页签项
  const activeTab = useMemo(() => {
    if (!openTabs.length) return null
    return (
      openTabs.find((t) => isSameSymbol(t.symbol, activeSymbol)) ||
      openTabs[0] ||
      null
    )
  }, [openTabs, activeSymbol])

  // 当前选中标的的实时行情
  const currentQuote: MarketQuote | undefined = useMemo(() => {
    return getQuote(activeSymbol) || (activeTab ? getQuote(activeTab.symbol) : undefined)
  }, [activeSymbol, activeTab, getQuote])

  // 当激活标的切换且本地行情尚未就绪时，立即主动发起实时行情请求
  useEffect(() => {
    if (!activeSymbol) return
    const existing = getQuote(activeSymbol)
    if (existing) return

    let cancelled = false
    void (async () => {
      try {
        const quotes = await window.electronAPI.fundStock.getQuote([activeSymbol])
        if (!cancelled && quotes.length) {
          const map: Record<string, MarketQuote> = {}
          for (const q of quotes) {
            map[q.symbol] = q
            map[q.symbol.toLowerCase()] = q
            map[q.symbol.toUpperCase()] = q
            const bare = q.symbol.replace(/^(sh|sz|hk|bj|us)/i, '')
            if (bare) {
              map[bare] = q
              map[bare.toLowerCase()] = q
              map[bare.toUpperCase()] = q
            }
          }
          setQuotesMap((prev) => ({ ...prev, ...map }))
        }
      } catch (err) {
        console.error('[基金股市] 立即获取标的行情失败:', err)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [activeSymbol, getQuote, setQuotesMap])

  // 顶部跑马灯轮播标的严格按照「我的自选」排序：置顶项优先，其余严格保持自选列表中的排列次序
  const filteredWatchlist = useMemo(() => {
    const list = watchlist.filter((item) => {
      if (marketFilter === 'all') return true
      return item.market === marketFilter
    })
    return [...list].sort((a, b) => {
      const aPin = a.pinned ? 1 : 0
      const bPin = b.pinned ? 1 : 0
      return bPin - aPin
    })
  }, [marketFilter, watchlist])

  // 当前激活标的是否已在自选中
  const currentWatchlistItem = useMemo(() => {
    const sym = currentQuote?.symbol || activeTab?.symbol || activeSymbol
    if (!sym) return null
    return watchlist.find((w) => isSameSymbol(w.symbol, sym))
  }, [watchlist, currentQuote, activeTab, activeSymbol])

  // 打开或激活标的页签（若点击的是已打开的标的，直接激活该打开的页签）
  const handleOpenSymbolTab = useCallback(
    (symbol: string, name?: string, market?: MarketCategory) => {
      // 1. 如果标的已在打开的页签中，直接激活该打开的页签并结束
      const existingTab = openTabs.find((t) => isSameSymbol(t.symbol, symbol))
      if (existingTab) {
        setActiveSymbol(existingTab.symbol)
        return
      }

      // 2. 否则追加新页签并激活
      setActiveSymbol(symbol)
      setOpenTabs((prev) => {
        const found = prev.find((t) => isSameSymbol(t.symbol, symbol))
        if (found) {
          return prev
        }
        const q = getQuote(symbol)
        const watchItem = watchlist.find((w) => isSameSymbol(w.symbol, symbol))
        return [
          ...prev,
          {
            symbol,
            name: name || q?.name || watchItem?.name || symbol,
            market: market || q?.market || watchItem?.market || 'cn',
          },
        ]
      })

      // 立即触发单标的行情快速抓取
      void window.electronAPI.fundStock.getQuote([symbol]).then((quotes) => {
        if (quotes && quotes.length) {
          const map: Record<string, MarketQuote> = {}
          for (const q of quotes) {
            map[q.symbol] = q
            map[q.symbol.toLowerCase()] = q
            map[q.symbol.toUpperCase()] = q
            const bare = q.symbol.replace(/^(sh|sz|hk|bj|us)/i, '')
            if (bare) {
              map[bare] = q
              map[bare.toLowerCase()] = q
              map[bare.toUpperCase()] = q
            }
          }
          setQuotesMap((prev) => ({ ...prev, ...map }))
        }
      }).catch((err) => console.error('[基金股市] 打开页签获取行情失败:', err))
    },
    [getQuote, openTabs, setActiveSymbol, setOpenTabs, setQuotesMap, watchlist]
  )


  // 关闭标的页签
  const handleCloseTab = useCallback(
    (symbolToClose: string, e: React.MouseEvent) => {
      e.stopPropagation()
      setOpenTabs((prev) => {
        const nextTabs = prev.filter((t) => !isSameSymbol(t.symbol, symbolToClose))
        if (isSameSymbol(activeSymbol, symbolToClose)) {
          if (nextTabs.length > 0) {
            const closedIndex = prev.findIndex((t) => isSameSymbol(t.symbol, symbolToClose))
            const newActive = nextTabs[Math.min(closedIndex, nextTabs.length - 1)]
            if (newActive) {
              setActiveSymbol(newActive.symbol)
            }
          } else {
            setActiveSymbol('')
          }
        }
        return nextTabs
      })
    },
    [activeSymbol, setActiveSymbol, setOpenTabs]
  )

  // 跑马灯循环列表构建：单套集合最小重复倍数以确保在宽屏下填满视口并无缝循环
  const marqueeItems = useMemo(() => {
    if (!filteredWatchlist.length) return []
    const len = filteredWatchlist.length
    const repeatTimes = len === 1 ? 10 : len === 2 ? 5 : len <= 5 ? 3 : 2
    const unit: WatchlistItem[] = []
    for (let r = 0; r < repeatTimes; r++) {
      unit.push(...filteredWatchlist)
    }
    return unit
  }, [filteredWatchlist])

  // 动态跑马灯动画时长（保持每秒约 45px 恒定平滑移动速度）
  const marqueeDuration = useMemo(() => {
    const estimatedWidth = marqueeItems.length * 240
    return Math.max(20, Math.round(estimatedWidth / 45))
  }, [marqueeItems.length])

  // 渲染单个跑马灯标的胶囊
  const renderMarqueePill = (item: WatchlistItem, key: string) => {
    const quote = quotesMap[item.symbol] || quotesMap[item.symbol.toLowerCase()]
    const isSelected = isSameSymbol(activeSymbol, item.symbol)
    const isPositive = quote ? quote.change > 0 : false
    const isNegative = quote ? quote.change < 0 : false

    const marketBadge =
      item.market === 'cn'
        ? 'A股'
        : item.market === 'hk'
        ? '港股'
        : item.market === 'us'
        ? '美股'
        : '基金'

    return (
      <div
        key={key}
        onClick={() => handleOpenSymbolTab(item.symbol, item.name, item.market)}
        className={cn(
          'inline-flex items-center gap-2 h-7 px-2.5 rounded-lg border text-xs cursor-pointer transition-all flex-shrink-0 group/pill relative select-none',
          isSelected
            ? 'bg-primary/15 border-primary/60 text-foreground ring-1 ring-primary/40 font-semibold shadow-xs'
            : 'bg-card/70 border-border/60 hover:bg-accent/60 hover:border-border text-muted-foreground hover:text-foreground shadow-xs'
        )}
      >
        <span className="text-[10px] px-1 py-0.2 rounded bg-muted/90 text-muted-foreground font-mono flex-shrink-0">
          {marketBadge}
        </span>
        <span className="font-medium text-foreground truncate max-w-[84px] flex-shrink-0">
          {item.name}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground flex-shrink-0">
          {item.symbol}
        </span>

        {quote ? (
          <div className="inline-flex items-center gap-1.5 flex-shrink-0">
            <span
              className={cn(
                'font-mono font-semibold text-xs',
                isPositive && 'text-red-500 dark:text-red-400',
                isNegative && 'text-emerald-500 dark:text-emerald-400',
                !isPositive && !isNegative && 'text-muted-foreground'
              )}
            >
              {quote.price.toFixed(item.market === 'fund' ? 3 : 2)}
            </span>
            <span
              className={cn(
                'font-mono text-[10px] font-medium px-1 rounded',
                isPositive && 'bg-red-500/10 text-red-500 dark:text-red-400',
                isNegative && 'bg-emerald-500/10 text-emerald-500 dark:text-emerald-400',
                !isPositive && !isNegative && 'bg-muted text-muted-foreground'
              )}
            >
              {isPositive ? '+' : ''}
              {quote.changePercent.toFixed(2)}%
            </span>
          </div>
        ) : (
          <span className="font-mono text-[10px] text-muted-foreground">--</span>
        )}

        {/* 悬停快捷移出自选按钮 */}
        <div className="hidden group-hover/pill:inline-flex items-center ml-0.5 transition-all">
          <button
            type="button"
            onClick={(e) => handleRemoveFromWatchlist(item.symbol, e)}
            className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-red-500 transition-colors"
            title="移出自选"
          >
            <Trash2 className="w-2.5 h-2.5" />
          </button>
        </div>
      </div>
    )
  }

  // 添加标的到自选并打开页签
  const handleAddToWatchlist = (item: { symbol: string; name: string; market: MarketCategory }) => {
    const exists = watchlist.some((w) => isSameSymbol(w.symbol, item.symbol))
    if (!exists) {
      const newItem: WatchlistItem = {
        id: `wl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        symbol: item.symbol,
        name: item.name,
        market: item.market,
        addedAt: Date.now(),
      }
      const updated = [newItem, ...watchlist]
      setWatchlist(updated)
      void window.electronAPI.fundStock.saveWatchlist(updated)
    }
    handleOpenSymbolTab(item.symbol, item.name, item.market)
    setSearchOpen(false)
  }

  // 移除自选
  const handleRemoveFromWatchlist = (symbol: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    const updated = watchlist.filter((w) => !isSameSymbol(w.symbol, symbol))
    setWatchlist(updated)
    void window.electronAPI.fundStock.saveWatchlist(updated)
  }

  // 切换自选标的置顶
  const handleTogglePinWatchlist = useCallback(
    (symbol: string) => {
      const updated = watchlist.map((item) =>
        isSameSymbol(item.symbol, symbol) ? { ...item, pinned: !item.pinned } : item
      )
      setWatchlist(updated)
      void window.electronAPI.fundStock.saveWatchlist(updated)
    },
    [setWatchlist, watchlist]
  )

  // 调整自选标的排序（上移/下移）
  const handleMoveWatchlistItem = useCallback(
    (symbol: string, direction: 'up' | 'down', targetSymbol?: string) => {
      const idx = watchlist.findIndex((item) => isSameSymbol(item.symbol, symbol))
      if (idx === -1) return

      let targetIdx = -1
      if (targetSymbol) {
        targetIdx = watchlist.findIndex((item) => isSameSymbol(item.symbol, targetSymbol))
      } else {
        targetIdx = direction === 'up' ? idx - 1 : idx + 1
      }

      if (targetIdx < 0 || targetIdx >= watchlist.length) return
      const next = [...watchlist]
      const currentItem = next[idx]
      const targetItem = next[targetIdx]
      if (currentItem && targetItem) {
        if (Boolean(currentItem.pinned) !== Boolean(targetItem.pinned)) {
          const tempPin = currentItem.pinned
          currentItem.pinned = targetItem.pinned
          targetItem.pinned = tempPin
        }
        next[idx] = targetItem
        next[targetIdx] = currentItem
        setWatchlist(next)
        void window.electronAPI.fundStock.saveWatchlist(next)
      }
    },
    [setWatchlist, watchlist]
  )

  // 清空全部自选
  const handleClearWatchlist = useCallback(() => {
    setWatchlist([])
    void window.electronAPI.fundStock.saveWatchlist([])
  }, [setWatchlist])

  // 发给 Agent 分析对话（默认就在右栏显示，不跳转到主界面）
  const handleSendToAgent = useCallback(
    async (intent: 'diagnose' | 'risk' | 'tech' | 'financial') => {
      if (!activeTab && !currentQuote) return

      const quote = currentQuote
      const name = quote?.name || activeTab?.name || activeSymbol
      const symbol = quote?.symbol || activeTab?.symbol || activeSymbol

      let intentPrompt = ''
      switch (intent) {
        case 'diagnose':
          intentPrompt = `请对标的【${name}（${symbol}）】进行全维度投研诊断：
- 结合当前最新价 ${quote ? quote.price : '更新中'}（涨跌幅 ${quote ? (quote.changePercent > 0 ? '+' : '') + quote.changePercent.toFixed(2) + '%' : '--'}）、PE估值 ${quote?.pe ?? '未公布'}、换手率 ${quote?.turnoverRate ?? '0'}%；
- 研判当前所处技术形态与估值分位数；
- 输出关键支撑位、压力位与投资研判要点。`
          break
        case 'risk':
          intentPrompt = `请调用对应的风控核查清单（如 A 股 T+1与涨跌停、美股财报与熔断、港股老千股与流动性、基金折溢价），对标的【${name}（${symbol}）】进行严格的风控排查，指出当前参与的主要风险点与合规红线。`
          break
        case 'tech':
          intentPrompt = `请对【${name}（${symbol}）】近期 K 线结构进行深度技术面解析：
- 观察 MA5/MA10/MA20 均线排列与量价配合情况；
- 诊断是否存在顶底背离、突破有效性与超买超卖信号。`
          break
        case 'financial':
          intentPrompt = `请剖析【${name}（${symbol}）】的基本面与商业壁垒：
- 分析其主营业务护城河与上下游议价能力；
- 体检其资产负债稳健性、盈利质量与自由现金流含金量。`
          break
      }

      try {
        const activeSessionId = await ensureTradingSession()
        if (!activeSessionId || !agentChannelId) return

        // 直接发给右栏专属投研会话，绝不跳转页面！
        await window.electronAPI.sendAgentMessage({
          sessionId: activeSessionId,
          userMessage: intentPrompt,
          channelId: agentChannelId,
          modelId: agentModelId || undefined,
        })
      } catch (err) {
        console.error('[基金股市] 发送投研指令失败:', err)
      }
    },
    [
      activeSymbol,
      activeTab,
      agentChannelId,
      agentModelId,
      currentQuote,
      ensureTradingSession,
    ]
  )

  // 发送自定义投研提问到右栏 Agent 会话（默认在右栏显示，不跳转页面）
  const handleSendCustomPrompt = useCallback(async () => {
    const text = composerInput.trim()
    if (!text || isSendingPrompt) return

    const quote = currentQuote
    const name = quote?.name || activeTab?.name || activeSymbol
    const symbol = quote?.symbol || activeTab?.symbol || activeSymbol

    let userMessage = text
    if (symbol) {
      const priceText = quote?.price ? `当前最新价 ${quote.price}` : ''
      const changeText =
        quote?.changePercent !== undefined
          ? `涨跌幅 ${(quote.changePercent > 0 ? '+' : '') + quote.changePercent.toFixed(2)}%`
          : ''
      const peText = quote?.pe !== undefined ? `PE ${quote.pe}` : ''
      const turnoverText =
        quote?.turnoverRate !== undefined ? `换手率 ${quote.turnoverRate}%` : ''
      const metrics = [priceText, changeText, peText, turnoverText]
        .filter(Boolean)
        .join('，')

      userMessage = `关于标的【${name}（${symbol}）】${metrics ? `（${metrics}）` : ''}，我的投研问题是：\n${text}`
    }

    setIsSendingPrompt(true)
    try {
      const activeSessionId = await ensureTradingSession()
      if (activeSessionId && agentChannelId) {
        setComposerInput('')
        setComposerHistory((prev) => appendHistoryEntry(prev, text))
        await window.electronAPI.sendAgentMessage({
          sessionId: activeSessionId,
          userMessage,
          channelId: agentChannelId,
          modelId: agentModelId || undefined,
        })
      }
    } catch (err) {
      console.error('[基金股市] 发送投研问题失败:', err)
    } finally {
      setIsSendingPrompt(false)
    }
  }, [
    activeSymbol,
    activeTab,
    agentChannelId,
    agentModelId,
    composerInput,
    currentQuote,
    ensureTradingSession,
    isSendingPrompt,
    setComposerHistory,
  ])

  const canSendComposer =
    composerInput.trim().length > 0 && !isSendingPrompt && Boolean(agentChannelId)

  const composerToolbarItems = useMemo<ToolbarItem[]>(
    () => [
      {
        key: 'speech',
        node: (
          <SpeechButton
            disabled={isSendingPrompt}
            className={inputToolbarButtonClass}
          />
        ),
      },
    ],
    [isSendingPrompt]
  )

  const composerTrailingNode = (
    <div className="flex items-center gap-1">
      <div className="flex min-w-0 items-center [&_.model-selector-trigger>span]:max-w-[min(6.5rem,20vw)]">
        <ModelSelector
          filterChannelIds={[...COPIS_WORKING_CHANNEL_IDS]}
          externalSelectedModel={
            agentChannelId
              ? { channelId: agentChannelId, modelId: agentModelId || '' }
              : undefined
          }
          onModelSelect={(option) => {
            setAgentChannelId(option.channelId)
            setAgentModelId(option.modelId)
          }}
          showChannelInTrigger
          useCopisLogo
          placement="composer"
          composerMode
          customModelOptions={customModelOptions}
        />
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(
          canSendComposer ? inputToolbarSendButtonClass : inputToolbarDisabledButtonClass
        )}
        onClick={() => void handleSendCustomPrompt()}
        disabled={!canSendComposer}
        aria-label="发送投研问题"
        title="发送投研问题 (Enter)"
      >
        {isSendingPrompt ? (
          <Loader2 className="w-4 h-4 animate-spin text-primary" />
        ) : (
          <CornerDownLeft className="w-4 h-4" />
        )}
      </Button>
    </div>
  )

  // 悬停或最新位置的数据点、涨跌统计与均线读数（富途牛牛 / dsh-trading 同源读数体系）
  const activePoint = hoveredKlinePoint || (klines.length > 0 ? klines[klines.length - 1] : null)
  const activePointIndex = hoverKlineIndex !== null ? hoverKlineIndex : (klines.length > 0 ? klines.length - 1 : -1)

  const pointStats = useMemo(() => {
    if (!activePoint || activePointIndex < 0) {
      return { change: 0, changePct: 0, isUp: true }
    }
    const prevClose = activePointIndex > 0 ? klines[activePointIndex - 1]?.close : activePoint.open
    const change = prevClose ? activePoint.close - prevClose : 0
    const changePct = prevClose ? (change / prevClose) * 100 : 0
    return {
      change,
      changePct,
      isUp: change >= 0,
    }
  }, [activePoint, activePointIndex, klines])

  const maValues = useMemo(() => {
    if (!klines.length || activePointIndex < 0) {
      return { ma5: null, ma10: null, ma20: null, ma30: null }
    }
    const getMa = (p: number) => {
      if (activePointIndex < p - 1) return null
      const slice = klines.slice(activePointIndex - p + 1, activePointIndex + 1)
      const sum = slice.reduce((acc, curr) => acc + curr.close, 0)
      return sum / p
    }
    return {
      ma5: getMa(5),
      ma10: getMa(10),
      ma20: getMa(20),
      ma30: getMa(30),
    }
  }, [klines, activePointIndex])

  return (
    <div className="flex flex-col h-full bg-muted dark:bg-background select-none text-foreground overflow-hidden">
      {/* 顶栏 Header: 主 Tab + 横向自选跑马灯（去文字） + 搜索与刷新工具 */}
      <header className="flex items-center h-11 px-3 border-b border-border/50 bg-card/60 backdrop-blur-md z-20 gap-3">
        {/* 左侧：市场分类主 Tab */}
        <div className="flex items-center flex-shrink-0">
          <div className="inline-flex h-8 items-center gap-0.5 rounded-lg bg-muted/60 p-1 text-xs font-medium">
            {[
              { id: 'all', label: '全部' },
              { id: 'cn', label: 'A 股' },
              { id: 'hk', label: '港股' },
              { id: 'us', label: '美股' },
              { id: 'fund', label: '基金/ETF' },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setMarketFilter(tab.id as any)}
                className={cn(
                  'inline-flex h-6 items-center justify-center whitespace-nowrap rounded-md px-2 text-xs font-medium leading-none transition-all select-none',
                  marketFilter === tab.id
                    ? 'bg-[var(--ui-primary-background)] text-[var(--ui-primary)] shadow-xs font-semibold'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* 中间：自选跑马灯（位于主 tab 与搜索 icon 之间，去除“我的自选”文字） */}
        <div className="flex-1 min-w-0 h-full flex items-center overflow-hidden relative px-1">
          {filteredWatchlist.length === 0 ? (
            <div className="flex items-center text-xs text-muted-foreground/60 truncate pl-1">
              <span>暂无自选标的，点击右侧搜索图标添加 A 股 / 港股 / 美股 / 基金</span>
            </div>
          ) : (
            <div className="flex-1 overflow-hidden relative group/marquee h-full flex items-center">
              {/* 左右两侧平滑渐变遮罩 */}
              <div className="absolute left-0 top-0 bottom-0 w-6 bg-gradient-to-r from-card/90 to-transparent pointer-events-none z-10" />
              <div className="absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-card/90 to-transparent pointer-events-none z-10" />

              {/* 循环滚动容器 */}
              <div
                className="flex items-center gap-2.5 animate-marquee-scroll whitespace-nowrap will-change-transform py-1"
                style={{ animationDuration: `${marqueeDuration}s` }}
              >
                {/* Set 1 */}
                {marqueeItems.map((item, idx) => renderMarqueePill(item, `m1-${item.symbol}-${idx}`))}
                {/* Set 2 (用于无缝平滑衔接) */}
                {marqueeItems.map((item, idx) => renderMarqueePill(item, `m2-${item.symbol}-${idx}`))}
              </div>
            </div>
          )}
        </div>

        {/* 右侧：搜索与工具 */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="搜索标的 (A股 / 港股 / 美股 / 基金)"
            aria-label="搜索标的"
          >
            <Search className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => void refreshQuotes()}
            disabled={refreshing}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="刷新行情"
            aria-label="刷新行情"
          >
            <RefreshCw className={cn('w-4 h-4', refreshing && 'animate-spin text-primary')} />
          </button>

          <button
            type="button"
            onClick={() => setWatchlistDrawerOpen(true)}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="我的自选"
            aria-label="我的自选"
          >
            <Menu className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* 主体两栏容器 */}
      <div className="flex flex-1 min-h-0 overflow-hidden relative">
        {/* 中栏：C 位图表与盘口五档 (flex-1) */}
        <main className="flex-1 flex flex-col min-w-0 bg-muted dark:bg-background overflow-hidden">
          {/* 内容区标的页签栏 (浏览器页签 Tab 风格，底部两侧外弧圆角与下方内容区无缝融合，去除上边框线) */}
          <div
            ref={tabListRef}
            className="flex items-end h-9 bg-card/60 backdrop-blur-md px-3.5 gap-1 overflow-x-auto select-none flex-shrink-0 relative scrollbar-none"
          >
            {openTabs.map((tab) => {
              const isActive = isSameSymbol(activeSymbol, tab.symbol)
              const q = quotesMap[tab.symbol] || quotesMap[tab.symbol.toLowerCase()]
              const isPos = q ? q.change > 0 : false
              const isNeg = q ? q.change < 0 : false

              return (
                <div
                  key={tab.symbol}
                  data-symbol={tab.symbol}
                  onClick={() => setActiveSymbol(tab.symbol)}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'fund-tab-shape group/tab inline-flex items-center gap-1.5 h-8 px-3 text-xs cursor-pointer transition-colors flex-shrink-0 relative select-none',
                    isActive
                      ? 'bg-muted dark:bg-background text-[var(--ui-primary)] dark:text-foreground -mb-px z-10 font-semibold'
                      : 'bg-transparent text-muted-foreground hover:bg-muted/70 dark:hover:bg-background/60 hover:text-foreground mb-0.5'
                  )}
                >
                  <span
                    className={cn(
                      'text-[9px] px-1 py-0.2 rounded font-mono font-normal',
                      isActive
                        ? 'bg-[var(--ui-primary)]/15 text-[var(--ui-primary)] dark:bg-muted/90 dark:text-muted-foreground'
                        : 'bg-muted/90 text-muted-foreground'
                    )}
                  >
                    {tab.market === 'cn'
                      ? 'A股'
                      : tab.market === 'hk'
                      ? '港股'
                      : tab.market === 'us'
                      ? '美股'
                      : '基金'}
                  </span>
                  <span className="truncate max-w-[84px]">{tab.name}</span>

                  {q && (
                    <span
                      className={cn(
                        'font-mono text-[11px]',
                        isPos && 'text-red-500 dark:text-red-400',
                        isNeg && 'text-emerald-500 dark:text-emerald-400',
                        !isPos &&
                          !isNeg &&
                          (isActive
                            ? 'text-[var(--ui-primary)]/80 dark:text-muted-foreground'
                            : 'text-muted-foreground')
                      )}
                    >
                      {q.price.toFixed(tab.market === 'fund' ? 3 : 2)}
                    </span>
                  )}

                  {/* 页签 tab hover 时右侧出现打叉关闭 */}
                  <button
                    type="button"
                    onClick={(e) => handleCloseTab(tab.symbol, e)}
                    className={cn(
                      'p-0.5 rounded-sm hover:bg-muted opacity-0 group-hover/tab:opacity-100 transition-opacity ml-0.5',
                      isActive
                        ? 'text-[var(--ui-primary)] hover:text-[var(--ui-primary)] dark:text-muted-foreground dark:hover:text-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                    title="关闭页签"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )
            })}

            {/* 内容区页签最右侧 + icon，点击添加我的自选标的 */}
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="mb-1 ml-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted dark:hover:bg-background hover:text-foreground hover:shadow-xs select-none"
              title="添加自选标的"
              aria-label="添加自选标的"
            >
              <Plus className="size-4" />
            </button>

            {openTabs.length === 0 && (
              <span className="text-xs text-muted-foreground/60 px-2 pb-2 flex-shrink-0">
                暂未打开标的页签，点击上方胶囊或 + 号添加自选
              </span>
            )}
          </div>

          {activeTab ? (
            <>
              {/* 标的概览大卡片（与上方激活的浏览器 Tab 无缝融合） */}
              <div className="p-4 border-b border-border/40 bg-muted dark:bg-background">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="text-xl font-bold tracking-tight text-foreground">
                          {currentQuote?.name || activeTab.name}
                        </h2>
                        <span className="font-mono text-sm px-2 py-0.5 rounded bg-background/80 dark:bg-muted text-muted-foreground font-semibold">
                          {currentQuote?.symbol || activeTab.symbol}
                        </span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
                          {(currentQuote?.market || activeTab.market) === 'cn'
                            ? 'A 股'
                            : (currentQuote?.market || activeTab.market) === 'hk'
                            ? '港股'
                            : (currentQuote?.market || activeTab.market) === 'us'
                            ? '美股'
                            : '场内基金/ETF'}
                        </span>

                        {currentWatchlistItem ? (
                          <button
                            type="button"
                            onClick={(e) =>
                              handleRemoveFromWatchlist(
                                currentQuote?.symbol || activeTab.symbol,
                                e
                              )
                            }
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs border border-border/60 bg-muted/30 hover:bg-muted text-muted-foreground hover:text-red-500 transition-colors ml-1"
                            title="从自选移除"
                          >
                            <Bookmark className="w-3 h-3 fill-primary text-primary" />
                            <span>已自选</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() =>
                              handleAddToWatchlist({
                                symbol: currentQuote?.symbol || activeTab.symbol,
                                name: currentQuote?.name || activeTab.name,
                                market: currentQuote?.market || activeTab.market,
                              })
                            }
                            className="ui-primary-button inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium transition-colors ml-1 cursor-pointer"
                            title="添加至自选"
                          >
                            <Plus className="w-3 h-3" />
                            <span>加自选</span>
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="flex items-baseline gap-3 pl-4 border-l border-border/50">
                      {currentQuote ? (
                        <>
                          <span
                            className={cn(
                              'text-3xl font-bold font-mono tracking-tight',
                              currentQuote.change > 0 && 'text-red-500 dark:text-red-400',
                              currentQuote.change < 0 && 'text-emerald-500 dark:text-emerald-400',
                              currentQuote.change === 0 && 'text-muted-foreground'
                            )}
                          >
                            {currentQuote.price.toFixed(
                              (currentQuote.market || activeTab.market) === 'fund' ? 3 : 2
                            )}
                          </span>

                          <div className="flex flex-col">
                            <span
                              className={cn(
                                'text-xs font-bold font-mono',
                                currentQuote.change > 0 && 'text-red-500',
                                currentQuote.change < 0 && 'text-emerald-500',
                                currentQuote.change === 0 && 'text-muted-foreground'
                              )}
                            >
                              {currentQuote.change > 0 ? '+' : ''}
                              {currentQuote.change.toFixed(
                                (currentQuote.market || activeTab.market) === 'fund' ? 3 : 2
                              )}
                            </span>
                            <span
                              className={cn(
                                'text-xs font-bold font-mono',
                                currentQuote.changePercent > 0 && 'text-red-500',
                                currentQuote.changePercent < 0 && 'text-emerald-500',
                                currentQuote.changePercent === 0 && 'text-muted-foreground'
                              )}
                            >
                              {currentQuote.changePercent > 0 ? '+' : ''}
                              {currentQuote.changePercent.toFixed(2)}%
                            </span>
                          </div>
                        </>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="text-3xl font-bold font-mono tracking-tight text-muted-foreground animate-pulse">
                            --.--
                          </span>
                          <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                            <span>获取实时行情中...</span>
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 核心指标微网格 */}
                  <div className="grid grid-cols-5 gap-x-6 gap-y-1 text-xs">
                    <div>
                      <span className="text-muted-foreground text-[11px]">今开：</span>
                      <span className="font-mono font-medium">
                        {currentQuote ? currentQuote.open.toFixed(2) : '--'}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground text-[11px]">昨收：</span>
                      <span className="font-mono font-medium">
                        {currentQuote ? currentQuote.prevClose.toFixed(2) : '--'}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground text-[11px]">最高：</span>
                      <span className="font-mono font-medium text-red-500/90">
                        {currentQuote ? currentQuote.high.toFixed(2) : '--'}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground text-[11px]">最低：</span>
                      <span className="font-mono font-medium text-emerald-500/90">
                        {currentQuote ? currentQuote.low.toFixed(2) : '--'}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground text-[11px]">市盈率(TTM)：</span>
                      <span className="font-mono font-medium">
                        {currentQuote?.pe ? currentQuote.pe.toFixed(1) : '--'}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground text-[11px]">成交量：</span>
                      <span className="font-mono font-medium">
                        {currentQuote?.volume ? `${(currentQuote.volume / 10000).toFixed(1)}万` : '--'}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground text-[11px]">成交额：</span>
                      <span className="font-mono font-medium">
                        {currentQuote?.amount ? `${(currentQuote.amount / 10000).toFixed(1)}万` : '--'}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground text-[11px]">换手率：</span>
                      <span className="font-mono font-medium">
                        {currentQuote?.turnoverRate ? `${currentQuote.turnoverRate.toFixed(2)}%` : '--'}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground text-[11px]">市净率(PB)：</span>
                      <span className="font-mono font-medium">
                        {currentQuote?.pb ? currentQuote.pb.toFixed(2) : '--'}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground text-[11px]">总市值：</span>
                      <span className="font-mono font-medium">
                        {currentQuote?.marketCap ? `${currentQuote.marketCap.toFixed(0)}亿` : '--'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>


              {/* 图表与盘口布局 */}
              <div className="flex-1 flex min-h-0 overflow-hidden">
                {/* 交互式 K 线区域 */}
                <div className="flex-1 flex flex-col p-4 overflow-hidden border-r border-border/40 trading-scrollbar">
                  {/* 周期切换与指标提示 */}
                  <div className="flex items-center justify-between pb-2.5">
                    <div className="inline-flex h-8 items-center gap-0.5 rounded-lg bg-muted/60 p-1 text-xs font-medium">
                      {[
                        { id: '1m', label: '分时' },
                        { id: '5m', label: '5分' },
                        { id: '15m', label: '15分' },
                        { id: '30m', label: '30分' },
                        { id: '60m', label: '60分' },
                        { id: 'day', label: '日 K' },
                        { id: 'week', label: '周 K' },
                        { id: 'month', label: '月 K' },
                      ].map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => setPeriod(item.id as KlinePeriod)}
                          className={cn(
                            'inline-flex h-6 items-center justify-center whitespace-nowrap rounded-md px-2.5 text-xs font-medium leading-none transition-all select-none',
                            period === item.id
                              ? 'bg-[var(--ui-primary-background)] text-[var(--ui-primary)] shadow-xs font-semibold'
                              : 'text-muted-foreground hover:text-foreground'
                          )}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>

                    {/* 指标图例与切换按钮 */}
                    <div className="flex items-center gap-1.5 text-xs font-mono select-none">
                      <button
                        type="button"
                        onClick={() => setMaVisible((v) => ({ ...v, ma5: !v.ma5 }))}
                        className={cn(
                          'px-2 py-0.5 rounded text-[11px] font-semibold transition-opacity',
                          maVisible.ma5
                            ? 'text-[#e6b800] bg-[#e6b800]/15 hover:opacity-80'
                            : 'text-muted-foreground/40 hover:text-muted-foreground line-through'
                        )}
                        title="切换 MA5 均线"
                      >
                        MA5
                      </button>
                      <button
                        type="button"
                        onClick={() => setMaVisible((v) => ({ ...v, ma10: !v.ma10 }))}
                        className={cn(
                          'px-2 py-0.5 rounded text-[11px] font-semibold transition-opacity',
                          maVisible.ma10
                            ? 'text-[#4a90e2] bg-[#4a90e2]/15 hover:opacity-80'
                            : 'text-muted-foreground/40 hover:text-muted-foreground line-through'
                        )}
                        title="切换 MA10 均线"
                      >
                        MA10
                      </button>
                      <button
                        type="button"
                        onClick={() => setMaVisible((v) => ({ ...v, ma20: !v.ma20 }))}
                        className={cn(
                          'px-2 py-0.5 rounded text-[11px] font-semibold transition-opacity',
                          maVisible.ma20
                            ? 'text-[#c05fd8] bg-[#c05fd8]/15 hover:opacity-80'
                            : 'text-muted-foreground/40 hover:text-muted-foreground line-through'
                        )}
                        title="切换 MA20 均线"
                      >
                        MA20
                      </button>
                      <button
                        type="button"
                        onClick={() => setMaVisible((v) => ({ ...v, ma30: !v.ma30 }))}
                        className={cn(
                          'px-2 py-0.5 rounded text-[11px] font-semibold transition-opacity',
                          maVisible.ma30
                            ? 'text-[#2ba471] bg-[#2ba471]/15 hover:opacity-80'
                            : 'text-muted-foreground/40 hover:text-muted-foreground line-through'
                        )}
                        title="切换 MA30 均线"
                      >
                        MA30
                      </button>
                    </div>
                  </div>

                  {/* 富途牛牛 / dsh-trading 同款实时行情读数行 (OHLCV + MA Readout) */}
                  {activePoint && (
                    <div className="flex items-center gap-3 pb-2 text-[11px] font-mono text-muted-foreground/90 overflow-x-auto select-none border-b border-border/30 mb-2 whitespace-nowrap trading-scrollbar">
                      <span className="text-foreground/80 font-medium">
                        {activePoint.time}
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="text-muted-foreground/60">开:</span>
                        <span className="text-foreground font-semibold">{fmtPrice(activePoint.open)}</span>
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="text-muted-foreground/60">高:</span>
                        <span className="text-red-500 font-semibold">{fmtPrice(activePoint.high)}</span>
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="text-muted-foreground/60">低:</span>
                        <span className="text-emerald-500 font-semibold">{fmtPrice(activePoint.low)}</span>
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="text-muted-foreground/60">收:</span>
                        <span className={cn('font-bold', pointStats.isUp ? 'text-red-500' : 'text-emerald-500')}>
                          {fmtPrice(activePoint.close)}
                        </span>
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="text-muted-foreground/60">涨跌:</span>
                        <span className={cn('font-semibold', pointStats.isUp ? 'text-red-500' : 'text-emerald-500')}>
                          {fmtChange(pointStats.change)} ({fmtPercent(pointStats.changePct)})
                        </span>
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="text-muted-foreground/60">量:</span>
                        <span className="text-foreground font-semibold">{fmtCompact(activePoint.volume)}</span>
                      </span>

                      {/* 均线当前读数 */}
                      {maVisible.ma5 && maValues.ma5 !== null && (
                        <span className="flex items-center gap-1 text-[#e6b800]">
                          <span>MA5:</span>
                          <span className="font-semibold">{fmtPrice(maValues.ma5)}</span>
                        </span>
                      )}
                      {maVisible.ma10 && maValues.ma10 !== null && (
                        <span className="flex items-center gap-1 text-[#4a90e2]">
                          <span>MA10:</span>
                          <span className="font-semibold">{fmtPrice(maValues.ma10)}</span>
                        </span>
                      )}
                      {maVisible.ma20 && maValues.ma20 !== null && (
                        <span className="flex items-center gap-1 text-[#c05fd8]">
                          <span>MA20:</span>
                          <span className="font-semibold">{fmtPrice(maValues.ma20)}</span>
                        </span>
                      )}
                      {maVisible.ma30 && maValues.ma30 !== null && (
                        <span className="flex items-center gap-1 text-[#2ba471]">
                          <span>MA30:</span>
                          <span className="font-semibold">{fmtPrice(maValues.ma30)}</span>
                        </span>
                      )}
                    </div>
                  )}

                  {/* K 线图表视口 */}
                  <div className="flex-1 min-h-0 relative rounded-xl border border-border/60 bg-card/40 overflow-hidden flex flex-col shadow-inner trading-scrollbar">
                    {klinesLoading ? (
                      <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs gap-2">
                        <RefreshCw className="w-4 h-4 animate-spin text-primary" />
                        <span>K 线数据加载中...</span>
                      </div>
                    ) : !klines.length ? (
                      <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs">
                        <span>暂无该周期 K 线历史数据</span>
                      </div>
                    ) : (
                      <TradingViewKlineChart
                        klines={klines}
                        period={period}
                        activeSymbol={activeSymbol}
                        maVisible={maVisible}
                        onHoverPoint={(point, idx) => {
                          setHoveredKlinePoint(point)
                          setHoverKlineIndex(idx)
                        }}
                        className="w-full h-full"
                      />
                    )}
                  </div>
                </div>

                {/* 盘口买卖五档与买卖力道比（对齐 dsh-trading / 富途牛牛风格） */}
                <FundStockOrderbookPane currentQuote={currentQuote} activeSymbol={activeSymbol} />
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-muted-foreground">
              <BarChart3 className="w-12 h-12 stroke-1 opacity-40 mb-3" />
              <h3 className="font-semibold text-base text-foreground">暂无打开的标的页签</h3>
              <p className="text-xs text-muted-foreground mt-1 max-w-sm">
                请点击上方自选跑马灯中的胶囊，或通过右上角搜索框打开任意标的页签。
              </p>
            </div>
          )}
        </main>

        {/* 拖拽调整大小分界线 */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整右侧投研助手栏宽度"
          onMouseDown={handleResizeStart}
          onDoubleClick={() => setAiDockWidth(DEFAULT_TRADING_AI_DOCK_WIDTH)}
          className="relative w-2 -mx-1 cursor-col-resize flex-shrink-0 z-30 select-none group flex items-center justify-center"
          title="左右拖拽调整投研助手栏宽度，双击恢复默认"
        >
          <div className="w-px h-full bg-border/50 group-hover:bg-primary group-active:bg-primary transition-colors" />
        </div>

        {/* 右栏：AI 投研助手 Dock (默认 288px，支持拖拽调节) */}
        {/* 右栏：AI 投研助手 Dock (默认 288px，支持拖拽调节，默认在右栏显示不跳转主界面) */}
        <aside
          style={{ width: `${aiDockWidth}px` }}
          className="flex-shrink-0 flex flex-col bg-background/50 border-l border-border/50 overflow-hidden"
        >
          {/* 顶栏 Header */}
          <header className="flex items-center justify-between h-9 px-3 border-b border-border/50 bg-muted/20 shrink-0 select-none">
            <div className="flex items-center gap-1.5 min-w-0">
              <div className="w-5 h-5 rounded bg-primary/10 text-primary flex items-center justify-center shrink-0">
                <Sparkles className="w-3 h-3" />
              </div>
              <span className="font-semibold text-xs text-foreground truncate">AI 投研助手</span>
            </div>
            <div className="flex items-center gap-0.5 shrink-0">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-6 text-muted-foreground hover:text-foreground"
                    onClick={() => void handleStartNewTradingSession()}
                    aria-label="开启新投研会话"
                  >
                    <Plus className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">开启新投研会话</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-6 text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      if (tradingSessionId) {
                        openSession('agent', tradingSessionId, 'AI 投研助手')
                        setActiveView('conversations')
                      }
                    }}
                    aria-label="在主对话界面全屏查看"
                  >
                    <Maximize2 className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">在主对话界面全屏查看</TooltipContent>
              </Tooltip>
            </div>
          </header>

          {/* 会话表面：直接在右栏显示，不跳转到主界面 */}
          <div className="min-h-0 flex-1 overflow-hidden flex flex-col">
            {tradingSessionId ? (
              <AgentConversationSurface
                sessionId={tradingSessionId}
                variant="investment"
                hideComposer
              />
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center p-6 text-center text-muted-foreground gap-2">
                <Loader2 className="w-5 h-5 animate-spin text-primary" />
                <span className="text-xs">正在连接 AI 投研助手...</span>
              </div>
            )}
          </div>

          {/* 底部固定 Composer 紧凑版（默认在右栏就地提问） */}
          <div className="flex-shrink-0 p-2.5 border-t border-border/50 bg-background/50 backdrop-blur-sm">
            {/* composer 上的快捷入口（四个快捷指令：两行网格布局） */}
            <div className="grid grid-cols-2 gap-1.5 pb-2">
              <button
                type="button"
                onClick={() => void handleSendToAgent('diagnose')}
                disabled={!activeTab}
                className="flex items-center justify-center gap-1.5 h-6.5 px-2 rounded-md text-[11px] font-medium bg-background/85 border border-border/60 hover:border-primary/50 hover:text-primary transition-colors disabled:opacity-40 disabled:pointer-events-none shadow-2xs select-none"
                title="一键综合诊断当前标的"
              >
                <Flame className="w-3 h-3 text-amber-500 shrink-0" />
                <span className="truncate">综合诊断</span>
              </button>
              <button
                type="button"
                onClick={() => void handleSendToAgent('risk')}
                disabled={!activeTab}
                className="flex items-center justify-center gap-1.5 h-6.5 px-2 rounded-md text-[11px] font-medium bg-background/85 border border-border/60 hover:border-primary/50 hover:text-primary transition-colors disabled:opacity-40 disabled:pointer-events-none shadow-2xs select-none"
                title="盘前风控清单核对"
              >
                <ShieldAlert className="w-3 h-3 text-red-500 shrink-0" />
                <span className="truncate">风控核查</span>
              </button>
              <button
                type="button"
                onClick={() => void handleSendToAgent('tech')}
                disabled={!activeTab}
                className="flex items-center justify-center gap-1.5 h-6.5 px-2 rounded-md text-[11px] font-medium bg-background/85 border border-border/60 hover:border-primary/50 hover:text-primary transition-colors disabled:opacity-40 disabled:pointer-events-none shadow-2xs select-none"
                title="K线形态量价解析"
              >
                <BarChart3 className="w-3 h-3 text-blue-500 shrink-0" />
                <span className="truncate">形态透视</span>
              </button>
              <button
                type="button"
                onClick={() => void handleSendToAgent('financial')}
                disabled={!activeTab}
                className="flex items-center justify-center gap-1.5 h-6.5 px-2 rounded-md text-[11px] font-medium bg-background/85 border border-border/60 hover:border-primary/50 hover:text-primary transition-colors disabled:opacity-40 disabled:pointer-events-none shadow-2xs select-none"
                title="商业壁垒与财务体检"
              >
                <Bookmark className="w-3 h-3 text-purple-500 shrink-0" />
                <span className="truncate">基本面</span>
              </button>
            </div>

            <div className="rounded-xl border border-border/70 bg-background/80 shadow-sm focus-within:border-foreground/25 transition-colors">
              <RichTextInput
                value={composerInput}
                onChange={setComposerInput}
                onSubmit={() => void handleSendCustomPrompt()}
                placeholder={
                  activeTab
                    ? `向 AI 提问【${activeTab.name}】...（Enter 发送）`
                    : '向 AI 投研助手提问...（Enter 发送）'
                }
                collapsible
                disabled={isSendingPrompt}
                inputHistory={composerHistory}
              />
              <InputToolbarOverflow
                items={composerToolbarItems}
                trailing={composerTrailingNode}
                className="px-2 py-1.5"
              />
            </div>
          </div>
        </aside>
      </div>

      {/* 搜索弹窗（UI 风格与主菜单全局搜索弹窗一致） */}
      <FundStockSearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onSelect={handleAddToWatchlist}
        quotesMap={quotesMap}
        openSymbols={openTabs.map((t) => t.symbol)}
      />

      {/* 右侧滑入自选管理抽屉 */}
      <FundStockWatchlistDrawer
        open={watchlistDrawerOpen}
        onOpenChange={setWatchlistDrawerOpen}
        watchlist={watchlist}
        quotesMap={quotesMap}
        activeSymbol={activeSymbol}
        onSelectSymbol={(sym, name, market) => {
          handleOpenSymbolTab(sym, name, market)
          setWatchlistDrawerOpen(false)
        }}
        onRemoveSymbol={(sym) => handleRemoveFromWatchlist(sym)}
        onTogglePin={handleTogglePinWatchlist}
        onMoveItem={handleMoveWatchlistItem}
        onClearWatchlist={handleClearWatchlist}
        onAddSymbolClick={() => setSearchOpen(true)}
      />
    </div>
  )
}
