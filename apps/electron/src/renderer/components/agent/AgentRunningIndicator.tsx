import * as React from 'react'
import { Spinner } from '@/components/ui/spinner'
import './AgentView.css'

/** Agent 和聊天室共用的运行指示器：方块动效、文字扫光及运行时间。 */
export function AgentRunningIndicator({ startedAt, label = '正在思考' }: { startedAt?: number; label?: string }): React.ReactElement {
  const [fallbackStart] = React.useState(() => Date.now())
  const start = startedAt ?? fallbackStart
  const [elapsed, setElapsed] = React.useState(() => Math.max(0, (Date.now() - start) / 1000))
  React.useEffect(() => {
    const update = (): void => setElapsed(Math.max(0, (Date.now() - start) / 1000))
    update()
    const timer = setInterval(update, 100)
    return () => clearInterval(timer)
  }, [start])
  const time = elapsed < 60 ? `${elapsed.toFixed(1)}s` : `${Math.floor(elapsed / 60)}m ${(elapsed % 60).toFixed(1)}s`
  return <div className="flex items-center gap-2 min-h-[28px]">
    <Spinner size="sm" className="text-primary/75" />
    <span className="agent-thinking-marquee text-[13px] font-light tabular-nums">{label} {time}</span>
  </div>
}
