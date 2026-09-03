import * as React from 'react'
import { TextQuote } from 'lucide-react'

interface SelectionActionPopoverProps {
  x: number
  y: number
  onAddToAgent: () => void
  onOpenAgentQuestion?: () => void | Promise<void>
}

export function SelectionActionPopover({
  x,
  y,
  onAddToAgent,
  onOpenAgentQuestion,
}: SelectionActionPopoverProps): React.ReactElement {
  return (
    <div
      data-selection-action-popover
      className="fixed z-[90] -translate-x-1/2 -translate-y-full rounded-xl bg-popover/95 px-2 py-1.5 text-popover-foreground shadow-xl ring-1 ring-border/40 backdrop-blur"
      style={{ left: x, top: y }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors hover:bg-muted"
          onClick={onAddToAgent}
        >
          <TextQuote className="size-4 text-[var(--ui-primary)] shrink-0" />
          为 Agent 引用
        </button>
        {onOpenAgentQuestion ? (
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors hover:bg-muted"
            onClick={() => {
              void onOpenAgentQuestion()
            }}
          >
            在 Agent 问答中提问
          </button>
        ) : null}
      </div>
    </div>
  )
}
