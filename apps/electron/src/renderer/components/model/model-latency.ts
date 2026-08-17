export type ModelLatencyLevel = 'low' | 'medium' | 'high' | 'unknown'

const LOW_LATENCY_MS = 8_000
const MEDIUM_LATENCY_MS = 12_000

export function classifyModelLatency(averageMs?: number): ModelLatencyLevel {
  if (averageMs === undefined || !Number.isFinite(averageMs)) return 'unknown'
  if (averageMs < LOW_LATENCY_MS) return 'low'
  if (averageMs < MEDIUM_LATENCY_MS) return 'medium'
  return 'high'
}

export function getModelLatencyLabel(level: ModelLatencyLevel): string {
  switch (level) {
    case 'low':
      return '低延迟'
    case 'medium':
      return '中等延迟'
    case 'high':
      return '高延迟'
    default:
      return '暂无延迟数据'
  }
}
