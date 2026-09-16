import React from 'react'
import { Lightbulb } from 'lucide-react'
import { CopisLogoIcon } from '@/components/ui/copis-logo-icon'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CopisCreationConfirmDialog } from '@/components/creation/CopisCreationConfirmDialog'
import { useCopisModeSwitcher } from '@/hooks/useCopisModeSwitcher'
import { cn } from '@/lib/utils'

export interface CopisModeSwitcherProps {
  isCollapsed?: boolean
  className?: string
}

export function CopisModeSwitcher({
  isCollapsed = false,
  className,
}: CopisModeSwitcherProps): React.ReactElement {
  const {
    currentMode,
    confirmDialogOpen,
    setConfirmDialogOpen,
    handleSwitchMode,
    executeSwitchToCreation,
  } = useCopisModeSwitcher()

  if (isCollapsed) {
    const isCreation = currentMode === 'creation'
    const tooltipText = isCreation
      ? '当前：创造模式（点击切换为 Agent 模式）'
      : '当前：Agent 模式（点击切换为创造模式）'

    return (
      <>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                'copis-working-sidebar-icon-button relative transition-all duration-200',
                isCreation
                  ? 'bg-[var(--creation-ui-primary-background)] text-[var(--creation-ui-primary)] hover:opacity-90'
                  : 'text-[var(--ui-primary)] hover:bg-muted/40',
                className,
              )}
              aria-label={tooltipText}
              onClick={() => handleSwitchMode(isCreation ? 'agent' : 'creation')}
            >
              {isCreation ? (
                <Lightbulb className="w-4 h-4 text-[var(--creation-ui-primary)]" aria-hidden="true" />
              ) : (
                <CopisLogoIcon className="w-4 h-4 text-[var(--ui-primary)]" />
              )}
              <span
                className={cn(
                  'absolute bottom-1 right-1 w-1.5 h-1.5 rounded-full',
                  isCreation ? 'bg-[var(--creation-ui-primary)]' : 'bg-[var(--ui-primary)]',
                )}
              />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            {tooltipText}
          </TooltipContent>
        </Tooltip>
        <CopisCreationConfirmDialog
          open={confirmDialogOpen}
          onOpenChange={setConfirmDialogOpen}
          onConfirm={executeSwitchToCreation}
        />
      </>
    )
  }

  return (
    <>
      <div
        className={cn(
          'flex items-center p-1 rounded-xl bg-muted/60 border border-border/50 shadow-inner select-none transition-all',
          className,
        )}
        role="radiogroup"
        aria-label="模式切换"
      >
        <button
          type="button"
          role="radio"
          aria-checked={currentMode === 'agent'}
          className={cn(
            'flex-1 min-w-0 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-xs font-medium transition-all duration-150 whitespace-nowrap',
            currentMode === 'agent'
              ? 'bg-card text-foreground shadow-sm font-semibold border border-border/40'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/40',
          )}
          onClick={() => handleSwitchMode('agent')}
        >
          <CopisLogoIcon className="w-3.5 h-3.5 text-[var(--ui-primary)] shrink-0" />
          <span className="whitespace-nowrap truncate">Agent 模式</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={currentMode === 'creation'}
          className={cn(
            'flex-1 min-w-0 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-xs font-medium transition-all duration-150 whitespace-nowrap',
            currentMode === 'creation'
              ? 'bg-card text-[var(--creation-ui-primary)] shadow-sm font-semibold border border-border/40'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/40',
          )}
          onClick={() => handleSwitchMode('creation')}
        >
          <Lightbulb className="w-3.5 h-3.5 text-[var(--creation-ui-primary)] shrink-0" aria-hidden="true" />
          <span className="whitespace-nowrap truncate">创造模式</span>
        </button>
      </div>
      <CopisCreationConfirmDialog
        open={confirmDialogOpen}
        onOpenChange={setConfirmDialogOpen}
        onConfirm={executeSwitchToCreation}
      />
    </>
  )
}
