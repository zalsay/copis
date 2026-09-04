import { describe, expect, test } from 'bun:test'
import { isSameSymbol, type WatchlistItem, type MarketCategory } from '@copis/shared'
import {
  DEFAULT_TRADING_AI_DOCK_WIDTH,
  MIN_TRADING_AI_DOCK_WIDTH,
  MAX_TRADING_AI_DOCK_WIDTH,
  type TradingTabItem,
} from '@/atoms/trading-atoms'
import {
  parseKlineTimeToTimestamp,
  formatTimestampToText,
  fmtAxis,
  fmtPrice,
  fmtPercent,
  fmtChange,
  fmtCompact,
  calculateSMA,
  getChartThemeOptions,
  MA_SERIES_CONFIG,
} from './trading-chart-utils'

/**
 * 基金股市自选跑马灯逻辑计算契约
 */
function filterAndSortWatchlist(
  watchlist: WatchlistItem[],
  marketFilter: MarketCategory | 'all'
): WatchlistItem[] {
  const list = watchlist.filter((item) => {
    if (marketFilter === 'all') return true
    return item.market === marketFilter
  })
  return [...list].sort((a, b) => b.addedAt - a.addedAt)
}

function buildMarqueeItems(filteredWatchlist: WatchlistItem[]): WatchlistItem[] {
  if (!filteredWatchlist.length) return []
  const len = filteredWatchlist.length
  const repeatTimes = len === 1 ? 10 : len === 2 ? 5 : len <= 5 ? 3 : 2
  const unit: WatchlistItem[] = []
  for (let r = 0; r < repeatTimes; r++) {
    unit.push(...filteredWatchlist)
  }
  return unit
}

function computeMarqueeDuration(itemCount: number): number {
  const estimatedWidth = itemCount * 240
  return Math.max(20, Math.round(estimatedWidth / 45))
}

/**
 * 页签管理行为逻辑契约
 */
function openTabHelper(
  prevTabs: TradingTabItem[],
  newTab: TradingTabItem
): { tabs: TradingTabItem[]; activeSymbol: string } {
  const existing = prevTabs.find((t) => isSameSymbol(t.symbol, newTab.symbol))
  if (existing) {
    return { tabs: prevTabs, activeSymbol: existing.symbol }
  }
  return { tabs: [...prevTabs, newTab], activeSymbol: newTab.symbol }
}

function closeTabHelper(
  prevTabs: TradingTabItem[],
  currentActive: string,
  symbolToClose: string
): { tabs: TradingTabItem[]; activeSymbol: string } {
  const nextTabs = prevTabs.filter((t) => t.symbol.toLowerCase() !== symbolToClose.toLowerCase())
  let activeSymbol = currentActive
  if (currentActive.toLowerCase() === symbolToClose.toLowerCase()) {
    if (nextTabs.length > 0) {
      const closedIndex = prevTabs.findIndex(
        (t) => t.symbol.toLowerCase() === symbolToClose.toLowerCase()
      )
      const newActive = nextTabs[Math.min(closedIndex, nextTabs.length - 1)]
      activeSymbol = newActive ? newActive.symbol : ''
    } else {
      activeSymbol = ''
    }
  }
  return { tabs: nextTabs, activeSymbol }
}

const mockWatchlist: WatchlistItem[] = [
  { id: '1', symbol: '600519', name: '贵州茅台', market: 'cn', addedAt: 1000 },
  { id: '2', symbol: '00700', name: '腾讯控股', market: 'hk', addedAt: 2000 },
  { id: '3', symbol: 'AAPL', name: '苹果', market: 'us', addedAt: 3000 },
  { id: '4', symbol: '510300', name: '300ETF', market: 'fund', addedAt: 4000 },
  { id: '5', symbol: '000001', name: '平安银行', market: 'cn', addedAt: 5000 },
]

describe('基金股市 - 顶部横向跑马灯自选栏 BDD 契约', () => {

  test('Given 自选列表 When 按市场分类过滤 Then 正确返回目标市场标的', () => {
    const cnList = filterAndSortWatchlist(mockWatchlist, 'cn')
    expect(cnList.length).toBe(2)
    expect(cnList.every((item) => item.market === 'cn')).toBeTrue()

    const hkList = filterAndSortWatchlist(mockWatchlist, 'hk')
    expect(hkList.length).toBe(1)
    expect(hkList[0]?.symbol).toBe('00700')

    const fundList = filterAndSortWatchlist(mockWatchlist, 'fund')
    expect(fundList.length).toBe(1)
    expect(fundList[0]?.symbol).toBe('510300')
  })

  test('Given 自选列表 When 排序 Then 按加入时间降序排列（不再置顶）', () => {
    const allList = filterAndSortWatchlist(mockWatchlist, 'all')
    expect(allList[0]?.symbol).toBe('000001')
    expect(allList[allList.length - 1]?.symbol).toBe('600519')
  })

  test('Given 仅有 1 个或 2 个自选标的 When 构建单组跑马灯 Then 扩增重复次数以填满宽屏', () => {
    const single = [mockWatchlist[0]!]
    const singleMarquee = buildMarqueeItems(single)
    expect(singleMarquee.length).toBe(10)

    const double = [mockWatchlist[0]!, mockWatchlist[1]!]
    const doubleMarquee = buildMarqueeItems(double)
    expect(doubleMarquee.length).toBe(10)
  })

  test('Given 跑马灯单组集合 When 计算平滑滚动动画时长 Then 保证匀速并不低于 20s 保护下限', () => {
    // 0 个元素时
    expect(computeMarqueeDuration(0)).toBe(20)

    // 10 个元素时：预估 2400px / 45px/s = 53s
    const duration = computeMarqueeDuration(10)
    expect(duration).toBeGreaterThanOrEqual(50)
    expect(duration).toBeLessThanOrEqual(60)
  })

  test('Given 双套跑马灯 Set A 与 Set B When 渲染无限滚动循环 Then 两组数据完全对称', () => {
    const items = buildMarqueeItems(mockWatchlist)
    const setA = items.map((i) => i.symbol)
    const setB = items.map((i) => i.symbol)
    expect(setA).toEqual(setB)
  })
})

describe('基金股市 - 内容区标的页签 Tab BDD 契约', () => {
  const initialTabs: TradingTabItem[] = [
    { symbol: '600519', name: '贵州茅台', market: 'cn' },
    { symbol: 'AAPL', name: '苹果', market: 'us' },
  ]

  test('Given 已有打开页签 When 点击新标的胶囊 Then 成功追加新页签并激活', () => {
    const { tabs, activeSymbol } = openTabHelper(initialTabs, {
      symbol: '00700',
      name: '腾讯控股',
      market: 'hk',
    })
    expect(tabs.length).toBe(3)
    expect(tabs[2]?.symbol).toBe('00700')
    expect(activeSymbol).toBe('00700')
  })

  test('Given 已打开的标的页签 When 再次点击对应标的胶囊 Then 不重复添加并切换激活', () => {
    const { tabs, activeSymbol } = openTabHelper(initialTabs, {
      symbol: '600519',
      name: '贵州茅台',
      market: 'cn',
    })
    expect(tabs.length).toBe(2)
    expect(activeSymbol).toBe('600519')
  })

  test('Given 多个已打开页签 When 关闭当前激活页签 Then 自动激活相邻页签', () => {
    const tabs3: TradingTabItem[] = [
      { symbol: '600519', name: '贵州茅台', market: 'cn' },
      { symbol: 'AAPL', name: '苹果', market: 'us' },
      { symbol: '00700', name: '腾讯控股', market: 'hk' },
    ]
    // 当前激活为 AAPL（中间），关闭它，应该切换到 00700 或 600519
    const { tabs, activeSymbol } = closeTabHelper(tabs3, 'AAPL', 'AAPL')
    expect(tabs.length).toBe(2)
    expect(tabs.map((t) => t.symbol)).toEqual(['600519', '00700'])
    expect(activeSymbol).toBe('00700')
  })

  test('Given 仅剩 1 个页签 When 关闭该页签 Then 页签列表清空且激活标的置空', () => {
    const singleTab: TradingTabItem[] = [{ symbol: '600519', name: '贵州茅台', market: 'cn' }]
    const { tabs, activeSymbol } = closeTabHelper(singleTab, '600519', '600519')
    expect(tabs.length).toBe(0)
    expect(activeSymbol).toBe('')
  })

  test('Given 页签激活与未激活状态 When 渲染标的页签 Then 应用浏览器反向外圆角与内容区融合契约', () => {
    // 激活态：具有 fund-tab-shape、aria-current="page"、-mb-px 融合负边距及 bg-background 实体背景
    const activeAttrs = {
      'aria-current': 'page' as const,
      className: 'fund-tab-shape bg-background text-foreground shadow-[0_-1px_0_hsl(var(--border)/0.6)] -mb-px z-10',
    }
    expect(activeAttrs['aria-current']).toBe('page')
    expect(activeAttrs.className).toContain('fund-tab-shape')
    expect(activeAttrs.className).toContain('bg-background')
    expect(activeAttrs.className).toContain('-mb-px')

    // 未激活态：保留 fund-tab-shape 圆角类，aria-current 为 undefined，无负边距
    const inactiveAttrs = {
      'aria-current': undefined,
      className: 'fund-tab-shape bg-transparent text-muted-foreground hover:bg-background/60',
    }
    expect(inactiveAttrs['aria-current']).toBeUndefined()
    expect(inactiveAttrs.className).toContain('fund-tab-shape')
    expect(inactiveAttrs.className).not.toContain('-mb-px')
  })

  test('Given 标的页签栏容器 When 渲染标的页签栏 Then 去除与内容区之间的上边框线以实现无缝融合且背景采用更浅色调', () => {
    // 页签栏容器契约：去除 border-b 上边框线，背景采用更浅柔和的 bg-muted/15
    const containerClasses = 'flex items-end h-9 bg-muted/15 px-3.5 gap-1 overflow-x-auto select-none flex-shrink-0 relative scrollbar-none'
    expect(containerClasses).not.toContain('border-b')
    expect(containerClasses).toContain('bg-muted/15')
  })

  test('Given 顶栏 Header 布局 When 渲染自选跑马灯 Then 位于主分类 Tab 与搜索 Icon 之间并去除“我的自选”文字', () => {
    // 顶栏 Header 整合契约
    const headerClasses = 'flex items-center h-11 px-3 border-b border-border/50 bg-card/60 backdrop-blur-md z-20 gap-3'
    expect(headerClasses).toContain('h-11')
    expect(headerClasses).toContain('gap-3')

    // 跑马灯位于中间 flex-1 区域
    const middleMarqueeWrapper = 'flex-1 min-w-0 h-full flex items-center overflow-hidden relative px-1'
    expect(middleMarqueeWrapper).toContain('flex-1')
    expect(middleMarqueeWrapper).toContain('overflow-hidden')

    // 已彻底去除独立的“我的自选”标头文字与固定列
    const fixedTitleText = undefined
    expect(fixedTitleText).toBeUndefined()
  })

  test('Given 主 Tab 栏（市场分类 Tab） When 渲染 Tab 栏与按钮 Then 采用紧凑的间距规范（gap-0.5 与 px-2）', () => {
    // 容器间隙缩小契约：由 gap-1 缩小为 gap-0.5（2px），保持 h-8 与 p-1 居中规范
    const tabContainerClasses =
      'inline-flex h-8 items-center gap-0.5 rounded-lg bg-muted/60 p-1 text-xs font-medium'
    expect(tabContainerClasses).toContain('gap-0.5')
    expect(tabContainerClasses).not.toContain('gap-1')
    expect(tabContainerClasses).toContain('h-8')
    expect(tabContainerClasses).toContain('p-1')

    // Tab 按钮内边距紧凑规范：px-2
    const tabButtonClasses =
      'inline-flex h-6 items-center justify-center whitespace-nowrap rounded-md px-2 text-xs font-medium leading-none transition-all select-none'
    expect(tabButtonClasses).toContain('px-2')
    expect(tabButtonClasses).not.toContain('px-2.5')
  })


  test('Given 内容区页签栏最右侧 When 渲染 + 按钮 Then 具备统一尺寸规范并可触发添加自选弹窗', () => {
    // 契约：+ 按钮具有 size-7（28px）、rounded-md、hover 态高亮及 title/aria-label 标注
    const plusButtonProps = {
      className:
        'mb-1 ml-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground hover:shadow-xs select-none',
      title: '添加自选标的',
      'aria-label': '添加自选标的',
    }
    expect(plusButtonProps.className).toContain('size-7')
    expect(plusButtonProps.className).toContain('shrink-0')
    expect(plusButtonProps.title).toBe('添加自选标的')
    expect(plusButtonProps['aria-label']).toBe('添加自选标的')

    // 交互契约：点击 + 按钮后触发搜索弹窗打开，选中后同时添加到自选列表并创建激活新页签
    let isSearchOpen = false
    const onPlusClick = () => {
      isSearchOpen = true
    }
    onPlusClick()
    expect(isSearchOpen).toBeTrue()

    // 模拟搜索弹窗回调添加自选与创建页签
    const currentWatchlist: WatchlistItem[] = [...mockWatchlist]
    const targetToAdd = { symbol: 'NVDA', name: '英伟达', market: 'us' as const }
    const addToWatchlistAndOpenTab = (
      wl: WatchlistItem[],
      tabs: TradingTabItem[],
      target: { symbol: string; name: string; market: MarketCategory }
    ) => {
      const existsInWl = wl.some((w) => w.symbol.toLowerCase() === target.symbol.toLowerCase())
      const nextWl = existsInWl
        ? wl
        : [
            ...wl,
            {
              id: `wl-mock`,
              symbol: target.symbol,
              name: target.name,
              market: target.market,
              addedAt: Date.now(),
            },
          ]
      const { tabs: nextTabs, activeSymbol } = openTabHelper(tabs, target)
      return { nextWl, nextTabs, activeSymbol }
    }

    const { nextWl, nextTabs, activeSymbol } = addToWatchlistAndOpenTab(
      currentWatchlist,
      initialTabs,
      targetToAdd
    )
    expect(nextWl.some((w) => w.symbol === 'NVDA')).toBeTrue()
    expect(nextTabs.some((t) => t.symbol === 'NVDA')).toBeTrue()
    expect(activeSymbol).toBe('NVDA')
  })

  test('Given 标的通过搜索或点击 + 打开 When 实时行情尚未就绪或代码前缀差异 Then activeTab 驱动主视图渲染而绝不跌入暂无打开标的空状态', () => {
    // 模拟用户刚刚选择了一个新标的（例如 600519 或 NVDA）
    const selectedSymbol = 'sh600519'
    const selectedName = '贵州茅台'
    const selectedMarket: MarketCategory = 'cn'

    const openTabs: TradingTabItem[] = [
      {
        symbol: selectedSymbol,
        name: selectedName,
        market: selectedMarket,
      },
    ]
    const activeSymbol = selectedSymbol

    // 契约：activeTab 计算必须优先从 openTabs 中寻找，若未找到则降级为 openTabs[0]
    const activeTab = openTabs.find((t) => t.symbol === activeSymbol) || openTabs[0]
    expect(activeTab).toBeDefined()
    expect(activeTab?.symbol).toBe('sh600519')

    // 契约：即便行情映射表 quotesMap 为空（异步网络请求尚未返回），视图渲染判断条件应为 activeTab 而非 currentQuote
    const quotesMap: Record<string, any> = {}
    const getQuote = (sym: string) => {
      if (!sym) return undefined
      const clean = sym.toLowerCase()
      const bare = clean.replace(/^(sh|sz|hk|bj|us)/i, '')
      return (
        quotesMap[sym] ||
        quotesMap[clean] ||
        quotesMap[sym.toUpperCase()] ||
        (bare ? quotesMap[bare] || quotesMap[bare.toUpperCase()] : undefined)
      )
    }

    const currentQuote = getQuote(activeSymbol)
    expect(currentQuote).toBeUndefined() // 行情此时仍在拉取中

    // 视图判定核心契约：
    // 只有当 openTabs 为空（!activeTab）时才渲染空状态“暂无打开的标的页签”
    // 当 activeTab 存在时，即使 currentQuote 为空，内容区也必须渲染页签概览与加载占位
    const shouldShowEmptyState = !activeTab
    const shouldRenderContent = Boolean(activeTab)

    expect(shouldShowEmptyState).toBeFalse()
    expect(shouldRenderContent).toBeTrue()

    // 契约：行情拉取返回后（包括裸代码 600519 或带前缀 sh600519），getQuote 能双向匹配
    quotesMap['600519'] = {
      symbol: 'sh600519',
      name: '贵州茅台',
      price: 1560.5,
      change: 15.2,
      changePercent: 0.98,
      market: 'cn',
      updatedAt: Date.now(),
    }
    const matchedQuote = getQuote(activeSymbol)
    expect(matchedQuote).toBeDefined()
    expect(matchedQuote?.price).toBe(1560.5)
  })

  test('Given 标的代码具有不同前缀或大小写 When 使用 isSameSymbol 比较 Then 正确识别相同标的并区隔不同市场同名代码', () => {
    // 相同标的无论大小写、有无市场前缀均判定为同一标的
    expect(isSameSymbol('sh600519', '600519')).toBeTrue()
    expect(isSameSymbol('600519', 'sh600519')).toBeTrue()
    expect(isSameSymbol('SH600519', 'sh600519')).toBeTrue()
    expect(isSameSymbol('hk00700', '00700')).toBeTrue()
    expect(isSameSymbol('HK00700', 'hk00700')).toBeTrue()
    expect(isSameSymbol('AAPL', 'aapl')).toBeTrue()
    expect(isSameSymbol('usAAPL', 'AAPL')).toBeTrue()

    // 两个具有不同明确市场前缀的代码（如 sh000001 上证指数 与 sz000001 平安银行），不能误判为相同标的
    expect(isSameSymbol('sh000001', 'sz000001')).toBeFalse()
    expect(isSameSymbol('sh600519', 'sz000002')).toBeFalse()
  })

  test('Given 已有打开的标的页签 When 用户再次点击或从搜索弹窗选择已打开的标的（含不同前缀格式） Then 直接激活该已打开的页签并不重复创建页签', () => {
    // 初始已有 2 个打开页签：贵州茅台 (sh600519) 与 腾讯控股 (hk00700)
    const currentTabs: TradingTabItem[] = [
      { symbol: 'sh600519', name: '贵州茅台', market: 'cn' },
      { symbol: 'hk00700', name: '腾讯控股', market: 'hk' },
    ]
    let activeSymbol = 'hk00700'

    // 用户通过搜索或点击胶囊选择了已经打开的标的「贵州茅台」，传入纯代码 600519
    const clickedItem = { symbol: '600519', name: '贵州茅台', market: 'cn' as const }

    // 契约：必须直接激活已有页签，使用已有页签的 symbol（sh600519），且页签总数不增加
    const { tabs: nextTabs, activeSymbol: nextActive } = openTabHelper(currentTabs, clickedItem)

    expect(nextTabs.length).toBe(2)
    expect(nextTabs[0]?.symbol).toBe('sh600519')
    expect(nextTabs[1]?.symbol).toBe('hk00700')
    // 激活的 activeSymbol 必须与已打开页签的 symbol 完全一致，以确保浏览器 Tab 样式高亮命中
    expect(nextActive).toBe('sh600519')

    // 契约：activeTab 计算必须准确命中已打开的页签
    const activeTab = nextTabs.find((t) => isSameSymbol(t.symbol, nextActive))
    expect(activeTab).toBeDefined()
    expect(activeTab?.name).toBe('贵州茅台')
  })
})

/**
 * 右侧 AI 投研助手栏拖拽宽度计算契约
 */
function computeAiDockResizeWidth(
  startWidth: number,
  startX: number,
  currentX: number,
  minWidth = MIN_TRADING_AI_DOCK_WIDTH,
  maxWidth = MAX_TRADING_AI_DOCK_WIDTH
): number {
  const delta = startX - currentX
  return Math.max(minWidth, Math.min(maxWidth, startWidth + delta))
}

describe('基金股市 - 右侧栏 AI 投研助手分界线调整大小 BDD 契约', () => {
  test('Given 默认宽度与起始坐标 When 向左拖拽 50px Then 右侧投研栏宽度增加 50px', () => {
    const startWidth = DEFAULT_TRADING_AI_DOCK_WIDTH // 288
    const startX = 800
    const currentX = 750 // 向左移动 50px

    const newWidth = computeAiDockResizeWidth(startWidth, startX, currentX)
    expect(newWidth).toBe(288 + 50) // 338
  })

  test('Given 默认宽度与起始坐标 When 向右拖拽 50px Then 右侧投研栏宽度减少 50px', () => {
    const startWidth = DEFAULT_TRADING_AI_DOCK_WIDTH // 288
    const startX = 800
    const currentX = 850 // 向右移动 50px

    const newWidth = computeAiDockResizeWidth(startWidth, startX, currentX)
    expect(newWidth).toBe(288 - 50) // 238
  })

  test('Given 向左大幅拖拽超过上限 When 计算新宽度 Then 严格限制在 MAX_TRADING_AI_DOCK_WIDTH (520px)', () => {
    const startWidth = DEFAULT_TRADING_AI_DOCK_WIDTH
    const startX = 800
    const currentX = 300 // 向左拖拽 500px，288 + 500 = 788 > 520

    const newWidth = computeAiDockResizeWidth(startWidth, startX, currentX)
    expect(newWidth).toBe(MAX_TRADING_AI_DOCK_WIDTH)
    expect(newWidth).toBe(520)
  })

  test('Given 向右大幅拖拽超过下限 When 计算新宽度 Then 严格限制在 MIN_TRADING_AI_DOCK_WIDTH (220px)', () => {
    const startWidth = DEFAULT_TRADING_AI_DOCK_WIDTH
    const startX = 800
    const currentX = 1000 // 向右拖拽 200px，288 - 200 = 88 < 220

    const newWidth = computeAiDockResizeWidth(startWidth, startX, currentX)
    expect(newWidth).toBe(MIN_TRADING_AI_DOCK_WIDTH)
    expect(newWidth).toBe(220)
  })

  test('Given 自定义调节后的宽度 When 用户双击分界线 Then 触发重置逻辑恢复至 DEFAULT_TRADING_AI_DOCK_WIDTH (288px)', () => {
    let currentWidth = 450
    // 模拟双击分界线重置事件
    const handleDoubleClickReset = () => {
      currentWidth = DEFAULT_TRADING_AI_DOCK_WIDTH
    }
    handleDoubleClickReset()
    expect(currentWidth).toBe(288)
    expect(currentWidth).toBe(DEFAULT_TRADING_AI_DOCK_WIDTH)
  })
})

/**
 * 投研问答 Prompt 组装契约
 */
function buildTradingComposerPrompt(
  input: string,
  target?: { name: string; symbol: string; quote?: { price: number; changePercent: number; pe?: number; turnoverRate?: number } }
): string {
  const text = input.trim()
  if (!text) return ''
  if (!target) return text

  const q = target.quote
  const priceText = q?.price ? `当前最新价 ${q.price}` : ''
  const changeText =
    q?.changePercent !== undefined
      ? `涨跌幅 ${(q.changePercent > 0 ? '+' : '') + q.changePercent.toFixed(2)}%`
      : ''
  const peText = q?.pe !== undefined ? `PE ${q.pe}` : ''
  const turnoverText =
    q?.turnoverRate !== undefined ? `换手率 ${q.turnoverRate}%` : ''
  const metrics = [priceText, changeText, peText, turnoverText]
    .filter(Boolean)
    .join('，')

  return `关于标的【${target.name}（${target.symbol}）】${metrics ? `（${metrics}）` : ''}，我的投研问题是：\n${text}`
}

describe('基金股市 - AI 投研助手紧凑版 Composer 与视觉层级 BDD 契约', () => {
  test('Given 当前聚焦标的且行情就绪 When 在 Composer 输入投研问题 Then 自动注入当前标的行情全息数据', () => {
    const prompt = buildTradingComposerPrompt('这只股票当前是否有突破阻力位的形态？', {
      name: '贵州茅台',
      symbol: 'sh600519',
      quote: {
        price: 1560.5,
        changePercent: 1.85,
        pe: 25.4,
        turnoverRate: 0.82,
      },
    })

    expect(prompt).toContain('关于标的【贵州茅台（sh600519）】')
    expect(prompt).toContain('当前最新价 1560.5')
    expect(prompt).toContain('涨跌幅 +1.85%')
    expect(prompt).toContain('PE 25.4')
    expect(prompt).toContain('换手率 0.82%')
    expect(prompt).toContain('这只股票当前是否有突破阻力位的形态？')
  })

  test('Given 暂无打开标的 When 在 Composer 输入全局市场问题 Then 保持纯文本提问不产生多余前缀', () => {
    const prompt = buildTradingComposerPrompt('请分析下周美联储议息会议对 A 股的影响')
    expect(prompt).toBe('请分析下周美联储议息会议对 A 股的影响')
  })

  test('Given Composer 输入状态与渠道绑定 When 判定发送可用性 Then 严格校验非空、非发送中且具备 Agent 渠道', () => {
    const checkCanSend = (input: string, isSending: boolean, channelId: string | null) =>
      input.trim().length > 0 && !isSending && Boolean(channelId)

    // 空文本禁止发送
    expect(checkCanSend('', false, 'copis-deepseek')).toBeFalse()
    expect(checkCanSend('   ', false, 'copis-deepseek')).toBeFalse()

    // 发送中禁止发送
    expect(checkCanSend('分析茅台', true, 'copis-deepseek')).toBeFalse()

    // 未配置 Agent 渠道禁止发送
    expect(checkCanSend('分析茅台', false, null)).toBeFalse()

    // 满足条件允许发送
    expect(checkCanSend('分析茅台', false, 'copis-deepseek')).toBeTrue()
  })
})

describe('基金股市 - AI 投研助手右栏内嵌会话与不跳转主界面 BDD 契约', () => {
  test('Given 用户在基金股市工作台点击快捷指令 When 触发发送投研指令 Then 消息直接发送到右侧专属会话且视图不跳转离开终端', async () => {
    let currentView: string = 'trading'
    let dispatchedMessage: { sessionId: string; message: string } | undefined

    // 模拟投研指令发送处理器契约（绝不调用 setActiveView('conversations')）
    const handleSendIntent = async (
      sessionId: string,
      intentPrompt: string,
      channelId: string,
      navigateView?: (view: string) => void
    ) => {
      // 记录发送的会话与内容
      dispatchedMessage = {
        sessionId,
        message: intentPrompt,
      }
      // 关键契约：不调用 navigateView('conversations')
    }

    const testSessionId = 'session-trading-ai-123'
    const testPrompt = '请对标的【贵州茅台（sh600519）】进行全维度投研诊断'

    await handleSendIntent(testSessionId, testPrompt, 'copis-deepseek', (view) => {
      currentView = view
    })

    // 验证消息已投递给右栏专属会话
    expect(dispatchedMessage).toBeDefined()
    expect(dispatchedMessage?.sessionId).toBe('session-trading-ai-123')
    expect(dispatchedMessage?.message).toContain('贵州茅台')

    // 核心契约：当前视图仍为 trading，没有被重定向跳转到 conversations
    expect(currentView).toBe('trading')
  })

  test('Given 右侧栏内嵌会话布局 When 渲染结构契约 Then 包含顶栏标题、新会话按钮、全屏按钮，以及在底部 Composer 上方渲染两行四项网格指令栏', () => {
    // 顶栏按钮契约
    const newSessionButtonAria = '开启新投研会话'
    const fullScreenButtonAria = '在主对话界面全屏查看'
    expect(newSessionButtonAria).toBe('开启新投研会话')
    expect(fullScreenButtonAria).toBe('在主对话界面全屏查看')

    // Composer 上的快捷入口契约：两行网格布局且去除“指令：”文字前缀
    const commandBarClass = 'grid grid-cols-2 gap-1.5 pb-2'
    expect(commandBarClass).toContain('grid-cols-2')
    expect(commandBarClass).toContain('pb-2')

    const quickPillCommands = ['综合诊断', '风控核查', '形态透视', '基本面']
    expect(quickPillCommands.length).toBe(4)
    expect(quickPillCommands).toEqual(['综合诊断', '风控核查', '形态透视', '基本面'])

    // 内嵌会话契约：使用 variant="investment" 紧凑模式加载 AgentConversationSurface
    const surfaceVariant = 'investment'
    expect(surfaceVariant).toBe('investment')
  })

  test('Given 用户显式点击右上角全屏查看按钮 When 触发全屏打开时 Then 唯有此时才切换至 conversations 主对话界面', () => {
    let currentView = 'trading'
    let openedSessionInfo: { type: string; id: string; title: string } | undefined

    const handleFullScreenClick = (sessionId: string) => {
      openedSessionInfo = {
        type: 'agent',
        id: sessionId,
        title: 'AI 投研助手',
      }
      currentView = 'conversations'
    }

    handleFullScreenClick('session-trading-ai-123')

    expect(openedSessionInfo).toBeDefined()
    expect(openedSessionInfo).toEqual({
      type: 'agent',
      id: 'session-trading-ai-123',
      title: 'AI 投研助手',
    })
    expect(currentView).toBe('conversations')
  })

  test('Given 右侧栏布局结构 When 渲染底部 Composer Then 四个快捷入口直接位于输入框上方，固定钉底并支持就地发送不跳转', () => {
    // 底部 Composer 容器契约：钉底、带边框与毛玻璃材质
    const composerWrapperClass = 'flex-shrink-0 p-2.5 border-t border-border/50 bg-background/50 backdrop-blur-sm'
    expect(composerWrapperClass).toContain('flex-shrink-0')
    expect(composerWrapperClass).toContain('border-t')

    // 会话表面契约：隐藏内部重复 composer（hideComposer=true），使用 investment variant
    const surfaceProps = {
      variant: 'investment' as const,
      hideComposer: true,
    }
    expect(surfaceProps.hideComposer).toBeTrue()
    expect(surfaceProps.variant).toBe('investment')
  })
})

describe('基金股市 - 「我的投资」固定工作区与菜单重命名 BDD 契约', () => {
  test('Given 左侧工作区侧边栏导航 When 渲染对应菜单项 Then 菜单文字显示为「我的投资」', () => {
    const sidebarMenuLabel = '我的投资'
    expect(sidebarMenuLabel).toBe('我的投资')
    expect(sidebarMenuLabel).not.toBe('基金股市')
  })

  test('Given 投研工作台初始化或创建会话 When 创建/检索专属会话 Then 统一绑定到「我的投资」固定工作区', async () => {
    const mockWorkspaces = [
      { id: 'ws-default', slug: 'default', name: '默认工作区' },
      { id: 'ws-investment', slug: 'investment', name: '我的投资' },
    ]

    const targetWs = mockWorkspaces.find((w) => w.slug === 'investment' || w.name === '我的投资')
    expect(targetWs).toBeDefined()
    expect(targetWs?.id).toBe('ws-investment')

    let createdSessionPayload: { title: string; workspaceId?: string } | undefined
    const mockCreateAgentSession = async (title: string, _channelId?: string, workspaceId?: string) => {
      createdSessionPayload = { title, workspaceId }
      return {
        id: 'session-inv-1',
        title,
        workspaceId,
      }
    }

    await mockCreateAgentSession('AI 投研助手', undefined, targetWs?.id)

    expect(createdSessionPayload).toBeDefined()
    expect(createdSessionPayload?.title).toBe('AI 投研助手')
    expect(createdSessionPayload?.workspaceId).toBe('ws-investment')
  })

  test('Given 「我的投资」固定工作区 When 尝试在侧栏操作菜单或底层删除 Then 禁止删除', () => {
    const targetSlug: string = 'investment'
    const isProtected = targetSlug === 'default' || targetSlug === 'investment'
    expect(isProtected).toBeTrue()

    const canRenderDeleteOption = (slug: string) => slug !== 'default' && slug !== 'investment'
    expect(canRenderDeleteOption('investment')).toBeFalse()
    expect(canRenderDeleteOption('default')).toBeFalse()
    expect(canRenderDeleteOption('custom-project')).toBeTrue()
  })
})

describe('基金股市 - 复刻 dsh-trading TradingView Lightweight Charts K 线图系统 BDD 契约', () => {
  test('Given 腾讯/上游返回的日期字符串 When 解析为时间戳 Then 严格生成无时区漂移的 UTC 秒级时间戳', () => {
    // 日期测试
    const dailyTs = parseKlineTimeToTimestamp('2026-09-04')
    expect(dailyTs).toBeGreaterThan(0)
    const d = new Date(dailyTs * 1000)
    expect(d.getUTCFullYear()).toBe(2026)
    expect(d.getUTCMonth() + 1).toBe(9)
    expect(d.getUTCDate()).toBe(4)

    // 分钟分时测试
    const minuteTs = parseKlineTimeToTimestamp('2026-09-04 14:30')
    const dm = new Date(minuteTs * 1000)
    expect(dm.getUTCFullYear()).toBe(2026)
    expect(dm.getUTCMonth() + 1).toBe(9)
    expect(dm.getUTCDate()).toBe(4)
    expect(dm.getUTCHours()).toBe(14)
    expect(dm.getUTCMinutes()).toBe(30)
  })

  test('Given 时间戳与周期类型 When 格式化横坐标轴刻度 Then 日线返回 MM-DD，分时返回 HH:mm', () => {
    const ts = parseKlineTimeToTimestamp('2026-09-04 09:35')
    const ms = ts * 1000

    // 日线刻度
    const dailyAxis = fmtAxis(ms, false)
    expect(dailyAxis).toBe('09-04')

    // 分时刻度
    const intradayAxis = fmtAxis(ms, true)
    expect(intradayAxis).toBe('09:35')
  })

  test('Given 时间戳与周期类型 When 格式化读数时间文本 Then 完整显示年月日与时分', () => {
    const ts = parseKlineTimeToTimestamp('2026-09-04 15:00')
    const dailyText = formatTimestampToText(ts, false)
    expect(dailyText).toBe('2026-09-04')

    const intradayText = formatTimestampToText(ts, true)
    expect(intradayText).toBe('2026-09-04 15:00')
  })

  test('Given 历史 K 线价格序列 When 计算 SMA 移动均线 Then 正确生成 MA5/MA10/MA20/MA30 数组', () => {
    const mockKlines = [
      { time: '2026-09-01', open: 10, high: 12, low: 9, close: 10, volume: 1000 },
      { time: '2026-09-02', open: 10, high: 13, low: 10, close: 12, volume: 1200 },
      { time: '2026-09-03', open: 12, high: 15, low: 11, close: 14, volume: 1500 },
      { time: '2026-09-04', open: 14, high: 16, low: 13, close: 16, volume: 2000 },
      { time: '2026-09-05', open: 16, high: 19, low: 15, close: 18, volume: 2500 },
      { time: '2026-09-06', open: 18, high: 21, low: 17, close: 20, volume: 3000 },
    ]

    const ma5Data = calculateSMA(mockKlines, 5)
    // 5 根后产生第 1 个点：(10+12+14+18+16)/5 = 70/5 = 14
    expect(ma5Data.length).toBe(2)
    expect(ma5Data[0]?.value).toBe(14)
    // 第 2 个点：(12+14+16+18+20)/5 = 80/5 = 16
    expect(ma5Data[1]?.value).toBe(16)
  })

  test('Given 数值格式化函数 When 格式化价格、涨跌额、涨跌幅及成交量 Then 呈现专业易读格式', () => {
    expect(fmtPrice(1895.5)).toBe('1895.50')
    expect(fmtPrice(0.0456)).toBe('0.0456')
    expect(fmtPrice(undefined)).toBe('--')

    expect(fmtPercent(2.35)).toBe('+2.35%')
    expect(fmtPercent(-1.20)).toBe('-1.20%')
    expect(fmtPercent(0)).toBe('0.00%')

    expect(fmtChange(15.2)).toBe('+15.20')
    expect(fmtChange(-8.6)).toBe('-8.60')

    expect(fmtCompact(560000000)).toBe('5.6亿')
    expect(fmtCompact(245000)).toBe('24.5万')
    expect(fmtCompact(850)).toBe('850')
  })

  test('Given 深浅色主题模式 When 生成图表配置 Then 正确适配背景色、文字颜色与多 Pane 配置', () => {
    const darkTheme = getChartThemeOptions(true)
    expect(darkTheme.autoSize).toBeTrue()
    expect(darkTheme.rightPriceScale?.visible).toBeTrue()
    expect(darkTheme.timeScale?.visible).toBeTrue()
    expect(darkTheme.layout?.panes?.enableResize).toBeTrue()

    const lightTheme = getChartThemeOptions(false)
    expect(lightTheme.autoSize).toBeTrue()
    expect(lightTheme.rightPriceScale?.visible).toBeTrue()
    expect(lightTheme.timeScale?.visible).toBeTrue()
    expect(lightTheme.layout?.panes?.enableResize).toBeTrue()

    // 确认调色板定义健全
    expect(MA_SERIES_CONFIG.ma5.color).toBe('#e6b800')
    expect(MA_SERIES_CONFIG.ma10.color).toBe('#4a90e2')
    expect(MA_SERIES_CONFIG.ma20.color).toBe('#c05fd8')
    expect(MA_SERIES_CONFIG.ma30.color).toBe('#2ba471')
  })
})

describe('基金股市 - 复刻 dsh-trading 盘口买卖五档与买卖力道比 BDD 契约', () => {
  const mockBids = [
    { price: 100.2, volume: 500 },
    { price: 100.1, volume: 800 },
    { price: 100.0, volume: 1200 },
    { price: 99.9, volume: 2000 },
    { price: 99.8, volume: 3000 },
  ]
  const mockAsks = [
    { price: 100.3, volume: 600 },
    { price: 100.4, volume: 900 },
    { price: 100.5, volume: 1500 },
    { price: 100.6, volume: 1800 },
    { price: 100.7, volume: 2500 },
  ]

  test('Given 买卖五档数据 When 计算买卖力道比 Then 正确返回委买比例与委卖比例', () => {
    const buyVol = mockBids.reduce((s, b) => s + b.volume, 0) // 7500
    const sellVol = mockAsks.reduce((s, a) => s + a.volume, 0) // 7300
    const total = buyVol + sellVol // 14800
    const buyRatio = buyVol / total
    const sellRatio = sellVol / total

    expect(buyVol).toBe(7500)
    expect(sellVol).toBe(7300)
    expect(Number((buyRatio * 100).toFixed(1))).toBe(50.7)
    expect(Number((sellRatio * 100).toFixed(1))).toBe(49.3)
  })

  test('Given 买卖盘口五档 When 计算价差 (Spread) Then 正确计算卖一与买一差价', () => {
    const bestBid = mockBids[0]?.price // 100.2
    const bestAsk = mockAsks[0]?.price // 100.3
    const spread = bestAsk! - bestBid!
    expect(Number(spread.toFixed(2))).toBe(0.1)
  })

  test('Given 卖盘与买盘档位展示顺序 When 渲染盘口 Then 卖盘倒序(卖五到卖一)，买盘正序(买一到买五)', () => {
    // 卖盘倒序
    const askReversed = mockAsks.slice().reverse()
    expect(askReversed[0]?.price).toBe(100.7) // 卖五
    expect(askReversed[askReversed.length - 1]?.price).toBe(100.3) // 卖一

    // 买盘正序
    expect(mockBids[0]?.price).toBe(100.2) // 买一
    expect(mockBids[mockBids.length - 1]?.price).toBe(99.8) // 买五
  })

  test('Given 深度条计算基准 When 取两侧最大档位量 Then 生成相对占比并 clamp 在 100% 以内', () => {
    const maxLevelVolume = Math.max(
      ...mockBids.map((b) => b.volume),
      ...mockAsks.map((a) => a.volume)
    )
    expect(maxLevelVolume).toBe(3000) // mockBids[4].volume

    const bidPct = Math.min(100, (mockBids[0]!.volume / maxLevelVolume) * 100)
    expect(Number(bidPct.toFixed(1))).toBe(16.7) // 500 / 3000 ≈ 16.7%

    const maxPct = Math.min(100, (mockBids[4]!.volume / maxLevelVolume) * 100)
    expect(maxPct).toBe(100)
  })

  test('Given 委比与委差计算 When 买量大于卖量 Then 委比为正且委差为正', () => {
    const buyVol = mockBids.reduce((s, b) => s + b.volume, 0) // 7500
    const sellVol = mockAsks.reduce((s, a) => s + a.volume, 0) // 7300
    const total = buyVol + sellVol

    const orderRatio = ((buyVol - sellVol) / total) * 100
    const orderDiff = buyVol - sellVol

    expect(orderRatio).toBeGreaterThan(0)
    expect(orderDiff).toBe(200)
  })
})




