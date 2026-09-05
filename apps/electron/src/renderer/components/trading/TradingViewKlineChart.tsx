import React, { useEffect, useRef, useState } from 'react'
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
} from 'lightweight-charts'
import type {
  IChartApi,
  ISeriesApi,
  MouseEventParams,
  Time,
  UTCTimestamp,
} from 'lightweight-charts'
import { useAtomValue } from 'jotai'
import { resolvedThemeAtom } from '@/atoms/theme'
import type { KlinePeriod, KlinePoint } from '@copis/shared'
import {
  calculateSMA,
  fmtAxis,
  fmtCompact,
  formatTimestampToText,
  getChartThemeOptions,
  parseKlineTimeToTimestamp,
  MA_SERIES_CONFIG,
} from './trading-chart-utils'

export interface TradingViewKlineChartProps {
  klines: KlinePoint[]
  period: KlinePeriod
  activeSymbol: string
  maVisible?: {
    ma5?: boolean
    ma10?: boolean
    ma20?: boolean
    ma30?: boolean
  }
  onHoverPoint?: (point: KlinePoint | null, index: number | null) => void
  className?: string
}

export function TradingViewKlineChart({
  klines,
  period,
  activeSymbol,
  maVisible = { ma5: true, ma10: true, ma20: true, ma30: false },
  onHoverPoint,
  className = 'w-full h-full',
}: TradingViewKlineChartProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const maSeriesRefs = useRef<{
    ma5?: ISeriesApi<'Line'> | null
    ma10?: ISeriesApi<'Line'> | null
    ma20?: ISeriesApi<'Line'> | null
    ma30?: ISeriesApi<'Line'> | null
  }>({})

  const resolvedTheme = useAtomValue(resolvedThemeAtom)
  const isDark = resolvedTheme === 'dark'

  const intraday = period === '1m' || period === '5m' || period === '15m' || period === '30m' || period === '60m'

  // 保存当前显示/悬停的成交量读数
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  // pane 1 (Volume) 的顶部 Y 坐标，用于精确定位 VOL 悬停徽标（对齐 dsh-trading 做法）
  const [volumePaneTop, setVolumePaneTop] = useState<number>(240)

  // 1. 初始化 Chart 实例
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const themeOpts = getChartThemeOptions(isDark)
    const chart = createChart(container, {
      ...themeOpts,
      localization: {
        timeFormatter: (time: Time): string => {
          return formatTimestampToText(Number(time), intraday)
        },
      },
      timeScale: {
        ...themeOpts.timeScale,
        tickMarkFormatter: (time: Time): string => {
          return fmtAxis(Number(time) * 1000, intraday)
        },
      },
    })
    chartRef.current = chart

    // Pane 0: 主蜡烛图（红涨绿跌）
    const candles = chart.addSeries(
      CandlestickSeries,
      {
        priceScaleId: 'right',
        upColor: '#e64545',
        downColor: '#2ba471',
        borderUpColor: '#e64545',
        borderDownColor: '#2ba471',
        wickUpColor: '#e64545',
        wickDownColor: '#2ba471',
        priceLineVisible: true,
        priceLineWidth: 1,
        priceLineStyle: LineStyle.Dashed,
        lastValueVisible: true,
      },
      0
    )
    candleSeriesRef.current = candles

    // Pane 0: 均线 LineSeries
    const ma5 = chart.addSeries(
      LineSeries,
      {
        priceScaleId: 'right',
        color: MA_SERIES_CONFIG.ma5.color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      },
      0
    )
    const ma10 = chart.addSeries(
      LineSeries,
      {
        priceScaleId: 'right',
        color: MA_SERIES_CONFIG.ma10.color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      },
      0
    )
    const ma20 = chart.addSeries(
      LineSeries,
      {
        priceScaleId: 'right',
        color: MA_SERIES_CONFIG.ma20.color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      },
      0
    )
    const ma30 = chart.addSeries(
      LineSeries,
      {
        priceScaleId: 'right',
        color: MA_SERIES_CONFIG.ma30.color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      },
      0
    )
    maSeriesRefs.current = { ma5, ma10, ma20, ma30 }

    // Pane 1: 成交量副图
    const volume = chart.addSeries(
      HistogramSeries,
      {
        priceFormat: { type: 'volume' },
        priceLineVisible: false,
        lastValueVisible: false,
      },
      1
    )
    volumeSeriesRef.current = volume

    // 比例分配：Pane 0 占约 80%, Pane 1 占约 20%
    const panes = chart.panes()
    if (panes[0]) panes[0].setStretchFactor(4)
    if (panes[1]) panes[1].setStretchFactor(1)

    // 订阅十字光标移动
    const onCrosshairMove = (param: MouseEventParams) => {
      if (param.logical === undefined || param.time === undefined) {
        setHoverIndex(null)
        onHoverPoint?.(null, null)
        return
      }

      const idx = Math.round(Number(param.logical))
      setHoverIndex(idx)
    }
    chart.subscribeCrosshairMove(onCrosshairMove)

    // 测量 Pane 几何尺寸
    const measurePanes = () => {
      const pList = chart.panes()
      if (pList.length > 1 && pList[0]) {
        const topPaneHeight = pList[0].getHeight()
        setVolumePaneTop(topPaneHeight + 4)
      }
    }
    const raf = requestAnimationFrame(measurePanes)
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === container) {
          const { width, height } = entry.contentRect
          chart.applyOptions({ width, height })
          measurePanes()
        }
      }
    })
    resizeObserver.observe(container)
    container.addEventListener('pointerup', measurePanes)

    return () => {
      cancelAnimationFrame(raf)
      resizeObserver.disconnect()
      container.removeEventListener('pointerup', measurePanes)
      chart.unsubscribeCrosshairMove(onCrosshairMove)
      chart.remove()
      chartRef.current = null
      candleSeriesRef.current = null
      volumeSeriesRef.current = null
      maSeriesRefs.current = {}
    }
  }, [intraday])

  // 2. 主题热切换
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const themeOpts = getChartThemeOptions(isDark)
    chart.applyOptions(themeOpts)
  }, [isDark])

  // 3. 悬停通知父级
  useEffect(() => {
    if (hoverIndex === null || hoverIndex < 0 || hoverIndex >= klines.length) {
      onHoverPoint?.(null, null)
    } else {
      const pt = klines[hoverIndex] || null
      onHoverPoint?.(pt, hoverIndex)
    }
  }, [hoverIndex, klines, onHoverPoint])

  // 4. 数据装载与更新
  useEffect(() => {
    const chart = chartRef.current
    const candles = candleSeriesRef.current
    const volumes = volumeSeriesRef.current
    if (!chart || !candles || !volumes || !klines.length) return

    // 对 klines 依据时间升序排序并去重，保证严格单调递增
    const timestampMap = new Map<number, KlinePoint>()
    for (const p of klines) {
      const ts = parseKlineTimeToTimestamp(p.time)
      timestampMap.set(ts, p)
    }
    const sortedTimestamps = Array.from(timestampMap.keys()).sort((a, b) => a - b)
    const sortedKlines = sortedTimestamps.map((ts) => timestampMap.get(ts)!)

    // 转换蜡烛数据
    const candleBars = sortedKlines.map((p, idx) => {
      const ts = sortedTimestamps[idx] as UTCTimestamp
      return {
        time: ts,
        open: p.open,
        high: p.high,
        low: p.low,
        close: p.close,
      }
    })

    // 转换成交量数据
    const volumeBars = sortedKlines.map((p, idx) => {
      const ts = sortedTimestamps[idx] as UTCTimestamp
      const up = p.close >= p.open
      return {
        time: ts,
        value: p.volume,
        color: up ? 'rgba(230, 69, 69, 0.65)' : 'rgba(43, 164, 113, 0.65)',
      }
    })

    candles.setData(candleBars)
    volumes.setData(volumeBars)

    // 均线更新
    const { ma5, ma10, ma20, ma30 } = maSeriesRefs.current
    if (ma5) {
      if (maVisible.ma5) {
        ma5.setData(calculateSMA(sortedKlines, MA_SERIES_CONFIG.ma5.period))
      } else {
        ma5.setData([])
      }
    }
    if (ma10) {
      if (maVisible.ma10) {
        ma10.setData(calculateSMA(sortedKlines, MA_SERIES_CONFIG.ma10.period))
      } else {
        ma10.setData([])
      }
    }
    if (ma20) {
      if (maVisible.ma20) {
        ma20.setData(calculateSMA(sortedKlines, MA_SERIES_CONFIG.ma20.period))
      } else {
        ma20.setData([])
      }
    }
    if (ma30) {
      if (maVisible.ma30) {
        ma30.setData(calculateSMA(sortedKlines, MA_SERIES_CONFIG.ma30.period))
      } else {
        ma30.setData([])
      }
    }

    // 调整到最新视口
    chart.timeScale().resetTimeScale()
    chart.timeScale().scrollToRealTime()
  }, [klines, activeSymbol, period, maVisible])

  // 当前成交量读数：优先悬停，否则取最后一条 K 线
  const currentVolumePoint =
    (hoverIndex !== null && klines[hoverIndex]) ||
    (klines.length > 0 ? klines[klines.length - 1] : null)

  return (
    <div className={`relative trading-scrollbar ${className}`}>
      {/* TradingView Lightweight Charts 容器 */}
      <div ref={containerRef} className="w-full h-full trading-scrollbar" />

      {/* Pane 1: VOL 悬停/最新成交量读数（富途牛牛 / dsh-trading 经典悬浮蓝字标签） */}
      {currentVolumePoint && (
        <div
          className="absolute left-2.5 z-10 pointer-events-none text-[11px] font-mono font-semibold select-none flex items-center gap-1.5"
          style={{ top: Math.max(160, volumePaneTop) }}
        >
          <span className="text-muted-foreground/75">VOL:</span>
          <span className="text-blue-500">{fmtCompact(currentVolumePoint.volume)}</span>
        </div>
      )}
    </div>
  )
}
