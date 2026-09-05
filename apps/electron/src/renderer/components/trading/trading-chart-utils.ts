import { ColorType, CrosshairMode, LineStyle } from 'lightweight-charts'
import type { ChartOptions, DeepPartial, UTCTimestamp } from 'lightweight-charts'
import type { KlinePoint } from '@copis/shared'

/**
 * 将字符串或毫秒时间转换为轻量图表使用的 UTC 秒级时间戳。
 * 使用基于各时间分量的 Date.UTC 转换，杜绝本地时区差异导致跨交易日错位。
 */
export function parseKlineTimeToTimestamp(timeStr: string): UTCTimestamp {
  if (!timeStr) {
    return Math.floor(Date.now() / 1000) as UTCTimestamp
  }

  const trimmed = timeStr.trim()
  // 若本身是纯数字时间戳（毫秒或秒）
  if (/^\d{10,13}$/.test(trimmed)) {
    const num = Number(trimmed)
    return (num > 1e11 ? Math.floor(num / 1000) : num) as UTCTimestamp
  }

  // 格式兼容：YYYY-MM-DD 或 YYYY/MM/DD [HH:mm[:ss]]
  const parts = trimmed.split(/[\sT]+/)
  const dateParts = parts[0]?.split(/[-/]/).map(Number) || []
  const timeParts = parts[1] ? parts[1].split(':').map(Number) : [0, 0, 0]

  const year = dateParts[0] || 1970
  const month = (dateParts[1] || 1) - 1
  const day = dateParts[2] || 1
  const hour = timeParts[0] || 0
  const minute = timeParts[1] || 0
  const second = timeParts[2] || 0

  return Math.floor(Date.UTC(year, month, day, hour, minute, second) / 1000) as UTCTimestamp
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * 格式化时间戳为显示文本：
 * 日/周/月 K：YYYY-MM-DD
 * 分时/分钟 K：YYYY-MM-DD HH:mm
 */
export function formatTimestampToText(ts: number, intraday: boolean): string {
  const d = new Date(ts * 1000)
  const y = d.getUTCFullYear()
  const m = pad2(d.getUTCMonth() + 1)
  const day = pad2(d.getUTCDate())
  if (intraday) {
    const hh = pad2(d.getUTCHours())
    const mm = pad2(d.getUTCMinutes())
    return `${y}-${m}-${day} ${hh}:${mm}`
  }
  return `${y}-${m}-${day}`
}

/**
 * 时间轴刻度标记格式化：
 * 日/周/月 K：MM-DD
 * 分时/分钟 K：HH:mm
 */
export function fmtAxis(ms: number, intraday: boolean): string {
  const d = new Date(ms)
  if (intraday) {
    return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
  }
  return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

/**
 * 价格格式化（默认保留两位小数，若小于 1 则展示更多有效位数）
 */
export function fmtPrice(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '--'
  const abs = Math.abs(value)
  if (abs >= 1000) return value.toFixed(2)
  if (abs >= 1) return value.toFixed(2)
  if (abs >= 0.01) return value.toFixed(4)
  return value.toFixed(6)
}

/**
 * 带正负号的百分比变动：+1.25% / -0.83%
 */
export function fmtPercent(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '--'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

/**
 * 带正负号的绝对变动金额：+0.35 / -1.20
 */
export function fmtChange(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '--'
  const sign = value > 0 ? '+' : ''
  return `${sign}${fmtPrice(value)}`
}

/**
 * 中文习惯的紧凑数字（万 / 亿）
 */
export function fmtCompact(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '--'
  const abs = Math.abs(value)
  if (abs >= 1e8) {
    return `${(value / 1e8).toFixed(2).replace(/\.?0+$/, '')}亿`
  }
  if (abs >= 1e4) {
    return `${(value / 1e4).toFixed(2).replace(/\.?0+$/, '')}万`
  }
  if (abs >= 1000) {
    return `${(value / 1000).toFixed(2).replace(/\.?0+$/, '')}K`
  }
  return value.toFixed(0)
}

/**
 * 计算 Simple Moving Average (SMA) 均线
 * 返回符合 Lightweight Charts LineSeries 格式的数据数组
 */
export function calculateSMA(
  klines: KlinePoint[],
  period: number
): Array<{ time: UTCTimestamp; value: number }> {
  if (!klines.length || period <= 0) return []
  const data: Array<{ time: UTCTimestamp; value: number }> = []

  let windowSum = 0
  for (let i = 0; i < klines.length; i++) {
    const p = klines[i]
    if (!p) continue
    windowSum += p.close

    if (i >= period) {
      const prev = klines[i - period]
      if (prev) windowSum -= prev.close
    }

    if (i >= period - 1) {
      const avg = windowSum / period
      data.push({
        time: parseKlineTimeToTimestamp(p.time),
        value: Number(avg.toFixed(3)),
      })
    }
  }

  return data
}

/**
 * 均线标准调色板（对齐 dsh-trading / 富途牛牛配色）
 */
export const MA_SERIES_CONFIG = {
  ma5: { key: 'MA5', label: 'MA5', color: '#e6b800', period: 5 },
  ma10: { key: 'MA10', label: 'MA10', color: '#4a90e2', period: 10 },
  ma20: { key: 'MA20', label: 'MA20', color: '#c05fd8', period: 20 },
  ma30: { key: 'MA30', label: 'MA30', color: '#2ba471', period: 30 },
} as const

/**
 * 获取符合当前主题（Dark / Light）的 Lightweight Charts 完整样式配置
 */
export function getChartThemeOptions(isDark: boolean): DeepPartial<ChartOptions> {
  const monoFont = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

  if (isDark) {
    return {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#0e121b' },
        textColor: '#8e9aa8',
        fontSize: 11,
        fontFamily: monoFont,
        panes: {
          separatorColor: '#1e2638',
          separatorHoverColor: '#2b364e',
          enableResize: true,
        },
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.04)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.04)' },
      },
      leftPriceScale: {
        visible: false,
      },
      rightPriceScale: {
        visible: true,
        borderColor: '#1e2638',
        scaleMargins: { top: 0.08, bottom: 0.08 },
        entireTextOnly: true,
      },
      timeScale: {
        visible: true,
        borderColor: '#1e2638',
        rightOffset: 6,
        barSpacing: 8,
        minBarSpacing: 0.5,
        fixLeftEdge: true,
        fixRightEdge: true,
        shiftVisibleRangeOnNewBar: true,
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: '#526077',
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: '#1a2233',
        },
        horzLine: {
          color: '#526077',
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: '#1a2233',
        },
      },
    }
  }

  return {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: 'transparent' },
      textColor: '#5f6b7c',
      fontSize: 11,
      fontFamily: monoFont,
      panes: {
        separatorColor: '#e2e8f0',
        separatorHoverColor: '#cbd5e1',
        enableResize: true,
      },
    },
    grid: {
      vertLines: { color: 'rgba(0, 0, 0, 0.04)' },
      horzLines: { color: 'rgba(0, 0, 0, 0.04)' },
    },
    leftPriceScale: {
      visible: false,
    },
    rightPriceScale: {
      visible: true,
      borderColor: '#e2e8f0',
      scaleMargins: { top: 0.08, bottom: 0.08 },
      entireTextOnly: true,
    },
    timeScale: {
      visible: true,
      borderColor: '#e2e8f0',
      rightOffset: 6,
      barSpacing: 8,
      minBarSpacing: 0.5,
      fixLeftEdge: true,
      fixRightEdge: true,
      shiftVisibleRangeOnNewBar: true,
      timeVisible: true,
      secondsVisible: false,
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: {
        color: '#94a3b8',
        width: 1,
        style: LineStyle.Dashed,
        labelBackgroundColor: '#0f172a',
      },
      horzLine: {
        color: '#94a3b8',
        width: 1,
        style: LineStyle.Dashed,
        labelBackgroundColor: '#0f172a',
      },
    },
  }
}
