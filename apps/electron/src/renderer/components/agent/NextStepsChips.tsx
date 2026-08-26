import * as React from 'react'
import { Sparkles, ArrowRight, X, ListChecks, Bot, MessageSquareText } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { NextStepSuggestion } from './next-steps-parser'
import { cn } from '@/lib/utils'

interface NextStepsChipsProps {
  items: NextStepSuggestion[]
  onSelect: (item: NextStepSuggestion) => void
  onDismiss: () => void
}

interface StepMeta {
  icon: React.ComponentType<{ className?: string }>
  iconColorClass: string
  hoverBorderClass: string
}

function getStepMeta(type?: string): StepMeta {
  switch (type) {
    case 'summarize-workflow':
      return {
        icon: ListChecks,
        iconColorClass: 'text-emerald-500/85 group-hover:text-emerald-500',
        hoverBorderClass: 'hover:border-emerald-500/60',
      }
    case 'session-summary':
      return {
        icon: MessageSquareText,
        iconColorClass: 'text-sky-500/85 group-hover:text-sky-500',
        hoverBorderClass: 'hover:border-sky-500/60',
      }
    case 'automation':
      return {
        icon: Bot,
        iconColorClass: 'text-amber-500/85 group-hover:text-amber-500',
        hoverBorderClass: 'hover:border-amber-500/60',
      }
    default:
      return {
        icon: Sparkles,
        iconColorClass: 'text-primary/85 group-hover:text-primary',
        hoverBorderClass: 'hover:border-primary/60',
      }
  }
}

export function NextStepsChips({ items, onSelect, onDismiss }: NextStepsChipsProps): React.ReactElement | null {
  if (!items || items.length === 0) return null

  return (
    <div className="copis-agent-next-steps-chips flex flex-wrap items-center justify-center gap-1.5 px-1 pb-2.5 select-none animate-in fade-in slide-in-from-bottom-1 duration-200">
      <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground/75 mr-0.5 select-none">
        <Sparkles className="size-3 text-primary/80" />
        <span>下步建议</span>
      </div>

      {items.map((item, index) => {
        const stepMeta = getStepMeta(item.type)
        const Icon = stepMeta.icon

        const chip = (
          <button
            key={`${item.type || 'step'}-${index}`}
            type="button"
            onClick={() => onSelect(item)}
            className={cn(
              'group inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-transparent px-2.5 py-1 text-xs font-medium text-foreground/80 transition-all',
              'hover:text-foreground active:scale-95 cursor-pointer',
              stepMeta.hoverBorderClass,
            )}
          >
            <Icon className={cn('size-3.5 shrink-0 transition-transform group-hover:scale-110', stepMeta.iconColorClass)} />
            <span className="truncate max-w-[220px]">{item.title}</span>
            <ArrowRight className="size-3 opacity-35 transition-all group-hover:translate-x-0.5 group-hover:opacity-90 text-muted-foreground group-hover:text-foreground" />
          </button>
        )

        if (!item.description) {
          return chip
        }

        return (
          <Tooltip key={`${item.type || 'step'}-${index}`}>
            <TooltipTrigger asChild>
              {chip}
            </TooltipTrigger>
            <TooltipContent side="top" align="center" className="max-w-xs text-xs space-y-0.5">
              <p className="font-medium text-foreground">{item.title}</p>
              <p className="text-muted-foreground leading-relaxed">{item.description}</p>
            </TooltipContent>
          </Tooltip>
        )
      })}

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onDismiss}
            className="group inline-flex size-6 items-center justify-center rounded-full border border-border/60 text-muted-foreground/50 hover:border-border/90 hover:text-foreground hover:bg-foreground/[0.04] transition-all cursor-pointer ml-0.5"
            aria-label="忽略建议"
          >
            <X className="size-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" align="center" className="text-xs">
          忽略建议
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
