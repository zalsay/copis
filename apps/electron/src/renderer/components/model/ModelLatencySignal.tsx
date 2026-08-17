import * as React from 'react'
import { cn } from '@/lib/utils'
import { classifyModelLatency, getModelLatencyLabel, type ModelLatencyLevel } from './model-latency'

interface ModelLatencySignalProps {
  averageMs?: number
  className?: string
}

const SIGNAL_HEIGHTS = [6, 9, 12] as const

function signalColor(level: ModelLatencyLevel): string {
  if (level === 'low') return 'bg-green-500'
  if (level === 'medium') return 'bg-yellow-500'
  if (level === 'high') return 'bg-red-500'
  return 'bg-muted-foreground/25'
}

export function ModelLatencySignal({
  averageMs,
  className,
}: ModelLatencySignalProps): React.ReactElement {
  const level = classifyModelLatency(averageMs)
  const activeCount = level === 'low' ? 3 : level === 'medium' ? 2 : level === 'high' ? 1 : 0
  const colorClass = signalColor(level)

  return (
    <span
      className={cn('inline-flex items-end gap-[2px]', className)}
      role="img"
      aria-label={getModelLatencyLabel(level)}
      title={`${getModelLatencyLabel(level)}${averageMs === undefined ? '' : ` · ${Math.round(averageMs)}ms`}`}
    >
      {SIGNAL_HEIGHTS.map((height, index) => (
        <i
          key={index}
          className={cn('w-[3px] rounded-full', index < activeCount ? colorClass : 'bg-muted-foreground/25')}
          style={{ height }}
        />
      ))}
    </span>
  )
}
