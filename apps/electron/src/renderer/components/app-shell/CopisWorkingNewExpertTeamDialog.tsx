/**
 * 新专家团工作区选择弹窗
 *
 * 由左侧「新专家团」入口打开：选择已有工作区或先创建工作区，
 * 随后由主理人 Agent 先询问用户需求，再组建并启动专家团队。
 */

import * as React from 'react'
import { ChevronRight, CircleAlert, FolderOpen, Loader2, UsersRound } from 'lucide-react'
import type { AgentWorkspace } from '@copis/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface CopisWorkingNewExpertTeamDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaces: AgentWorkspace[]
  busy: boolean
  error: string | null
  onSelectWorkspace: (workspace: AgentWorkspace) => void
  onCreateWorkspace: () => void
}

export function CopisWorkingNewExpertTeamDialog({
  open,
  onOpenChange,
  workspaces,
  busy,
  error,
  onSelectWorkspace,
  onCreateWorkspace,
}: CopisWorkingNewExpertTeamDialogProps): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="border-border/60 bg-card text-card-foreground shadow-xl sm:max-w-md" hideClose={busy}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-foreground">
            <UsersRound className="size-4 text-[var(--ui-primary)]" />
            新专家团
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            选择工作区后，主理人将先与你沟通具体需求，再为你量身组建并启动专属专家团队。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section aria-label="已有工作区">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--ui-primary)]">选择工作区</div>
            {workspaces.length === 0
              ? <p className="rounded-xl border border-border/60 bg-content-area px-3 py-3 text-xs text-muted-foreground">暂无可用的项目工作区，请先创建工作区。</p>
              : (
                <div className="max-h-48 space-y-1.5 overflow-y-auto pr-1">
                  {workspaces.map((workspace) => (
                    <Button
                      key={workspace.id}
                      type="button"
                      variant="ghost"
                      className="h-auto min-h-11 w-full justify-between rounded-xl border border-border/40 bg-content-area px-3 py-2 text-left text-foreground/90 transition-colors hover:bg-[var(--ui-primary-background)] hover:text-[var(--ui-primary)] hover:border-[var(--ui-primary)]/40"
                      onClick={() => onSelectWorkspace(workspace)}
                      disabled={busy}
                    >
                      <span className="min-w-0">
                        <span className="flex items-center gap-2">
                          <span className="block truncate text-sm font-medium">{workspace.name}</span>
                          {workspace.projectRootPath && <span className="shrink-0 rounded-full bg-secondary px-1.5 py-0 text-[10px] font-medium text-muted-foreground">本地</span>}
                        </span>
                        <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                          {workspace.projectRootPath || 'Copis 托管工作区'}
                        </span>
                      </span>
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                    </Button>
                  ))}
                </div>
              )}
          </section>

          <section className="border-t border-border/60 pt-4" aria-label="创建工作区">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--ui-primary)]">没有合适的工作区？</div>
            <p className="text-xs leading-5 text-muted-foreground">创建一个新项目工作区，主理人将在其中为你规划并组建专家团队。</p>
            <div className="mt-3">
              <Button
                type="button"
                size="sm"
                className="rounded-lg shadow-xs"
                onClick={onCreateWorkspace}
                disabled={busy}
              >
                <FolderOpen className="size-3.5" />
                创建工作区
              </Button>
            </div>
          </section>

          {busy && (
            <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/60 px-3 py-2 text-xs text-[var(--ui-primary)]" role="status">
              <Loader2 className="size-3.5 animate-spin" />
              正在为你准备主理人会话...
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              {error}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
