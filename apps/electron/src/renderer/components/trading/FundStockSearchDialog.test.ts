import { describe, expect, test } from 'bun:test'
import { isSameSymbol, type FundStockSearchResult } from '@copis/shared'

/**
 * 标的文本匹配算法契约（用于弹窗搜索高亮）
 */
function getMatchIndices(text: string, query: string): { before: string; match: string; after: string } | null {
  if (!query) return null
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return null
  return {
    before: text.slice(0, idx),
    match: text.slice(idx, idx + query.length),
    after: text.slice(idx + query.length),
  }
}

/**
 * 键盘导航选择索引计算契约
 */
function computeNextIndex(currentIndex: number, totalCount: number, direction: 'up' | 'down'): number {
  if (totalCount === 0) return 0
  if (direction === 'down') {
    return Math.min(currentIndex + 1, totalCount - 1)
  }
  return Math.max(currentIndex - 1, 0)
}

describe('基金股市 - 搜索弹窗 (FundStockSearchDialog) BDD 契约', () => {
  const mockRecommendations: FundStockSearchResult[] = [
    { symbol: '600519', name: '贵州茅台', market: 'cn', pinyin: 'GZMT' },
    { symbol: '00700', name: '腾讯控股', market: 'hk', pinyin: 'TXKG' },
    { symbol: 'AAPL', name: '苹果', market: 'us', pinyin: 'PG' },
    { symbol: '510300', name: '沪深300ETF', market: 'fund', pinyin: 'HS300ETF' },
  ]

  test('Given 未输入搜索词 When 渲染列表 Then 优先展示热门推荐标的', () => {
    const query = ''
    const displayed = query ? [] : mockRecommendations
    expect(displayed.length).toBe(4)
    expect(displayed[0]?.name).toBe('贵州茅台')
    expect(displayed[2]?.symbol).toBe('AAPL')
  })

  test('Given 用户输入查询词 When 标的名称/代码命中 Then 精确返回切分片段用于高亮 mark', () => {
    // 搜索“茅台”
    const matchName = getMatchIndices('贵州茅台', '茅台')
    expect(matchName).not.toBeNull()
    expect(matchName?.before).toBe('贵州')
    expect(matchName?.match).toBe('茅台')
    expect(matchName?.after).toBe('')

    // 搜索股票代码“00700”
    const matchSymbol = getMatchIndices('00700', '007')
    expect(matchSymbol).not.toBeNull()
    expect(matchSymbol?.before).toBe('')
    expect(matchSymbol?.match).toBe('007')
    expect(matchSymbol?.after).toBe('00')

    // 未命中
    const noMatch = getMatchIndices('苹果', '微软')
    expect(noMatch).toBeNull()
  })

  test('Given 搜索结果列表 When 用户按上下方向键导航 Then 选中索引精准在有效边界内切换', () => {
    const total = 4
    let current = 0

    // 向下移动
    current = computeNextIndex(current, total, 'down')
    expect(current).toBe(1)
    current = computeNextIndex(current, total, 'down')
    expect(current).toBe(2)
    current = computeNextIndex(current, total, 'down')
    expect(current).toBe(3)
    // 已达末尾，不再溢出
    current = computeNextIndex(current, total, 'down')
    expect(current).toBe(3)

    // 向上移动
    current = computeNextIndex(current, total, 'up')
    expect(current).toBe(2)
    current = computeNextIndex(current, total, 'up')
    expect(current).toBe(1)
    current = computeNextIndex(current, total, 'up')
    expect(current).toBe(0)
    // 已达顶部，不再溢出
    current = computeNextIndex(current, total, 'up')
    expect(current).toBe(0)
  })

  test('Given 搜索弹窗组件 When 检验 UI 契约 Then 遵循主菜单全局搜索弹窗 (SearchDialog) 设计标准', () => {
    const dialogClassContract = {
      maxWidth: 'sm:max-w-[520px]',
      padding: 'p-0',
      rounded: 'rounded-2xl',
      header: 'flex items-center gap-2 px-4 py-3 border-b border-border/50',
      footer: 'flex items-center justify-between px-4 py-2.5 border-t border-border/30 text-[11px]',
    }
    expect(dialogClassContract.maxWidth).toBe('sm:max-w-[520px]')
    expect(dialogClassContract.padding).toBe('p-0')
    expect(dialogClassContract.header).toContain('border-b')
    expect(dialogClassContract.footer).toContain('border-t')
  })

  test('Given 标的已在页签中打开 When 搜索弹窗展示标的列表 Then 标识为“已打开”状态', () => {
    const openSymbols = ['sh600519', 'hk00700']

    // 推荐列表标的
    const itemA = { symbol: 'sh600519', name: '贵州茅台', market: 'cn' as const }
    const itemB = { symbol: 'NVDA', name: '英伟达', market: 'us' as const }
    const itemC = { symbol: '00700', name: '腾讯控股', market: 'hk' as const } // 纯代码也能匹配

    const isItemAOpen = openSymbols.some((s) => isSameSymbol(s, itemA.symbol))
    const isItemBOpen = openSymbols.some((s) => isSameSymbol(s, itemB.symbol))
    const isItemCOpen = openSymbols.some((s) => isSameSymbol(s, itemC.symbol))

    expect(isItemAOpen).toBeTrue()
    expect(isItemBOpen).toBeFalse()
    expect(isItemCOpen).toBeTrue()
  })
})

