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
      <DialogContent className="border-[#f0a15a]/25 bg-[#1d1e1f] text-[#f2f3f3]" hideClose={busy}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[#f1f3f2]">
            <UsersRound className="size-4 text-[#f0a15a]" />
            新专家团
          </DialogTitle>
          <DialogDescription className="text-[#9fa3a6]">
            选择工作区后，主理人将先与你沟通具体需求，再为你量身组建并启动专属专家团队。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section aria-label="已有工作区">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#f0a15a]">选择工作区</div>
            {workspaces.length === 0
              ? <p className="rounded-md bg-[#151515] px-3 py-3 text-xs text-[#858b8e]">暂无可用的项目工作区，请先创建工作区。</p>
              : (
                <div className="max-h-48 space-y-1 overflow-y-auto">
                  {workspaces.map((workspace) => (
                    <Button
                      key={workspace.id}
                      type="button"
                      variant="ghost"
                      className="h-auto min-h-11 w-full justify-between rounded-md bg-[#151515] px-3 py-2 text-left text-[#dfe4e1] hover:bg-[#f0a15a]/10 hover:text-[#f5c18e]"
                      onClick={() => onSelectWorkspace(workspace)}
                      disabled={busy}
                    >
                      <span className="min-w-0">
                        <span className="flex items-center gap-2">
                          <span className="block truncate text-sm font-medium">{workspace.name}</span>
                          {workspace.projectRootPath && <span className="ui-primary-badge shrink-0 text-[10px]">本地</span>}
                        </span>
                        <span className="mt-0.5 block truncate text-[10px] text-[#858b8e]">
                          {workspace.projectRootPath || 'Copis 托管工作区'}
                        </span>
                      </span>
                      <ChevronRight className="size-4 shrink-0 text-[#858b8e]" />
                    </Button>
                  ))}
                </div>
              )}
          </section>

          <section className="border-t border-white/10 pt-4" aria-label="创建工作区">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#f0a15a]">没有合适的工作区？</div>
            <p className="text-xs leading-5 text-[#858b8e]">创建一个新项目工作区，主理人将在其中为你规划并组建专家团队。</p>
            <div className="mt-3">
              <Button
                type="button"
                size="sm"
                className="bg-[var(--ui-primary-background)] text-[var(--ui-primary)] hover:bg-[var(--ui-primary-background)] hover:text-[var(--ui-primary)]"
                onClick={onCreateWorkspace}
                disabled={busy}
              >
                <FolderOpen className="size-3.5" />
                创建工作区
              </Button>
            </div>
          </section>

          {busy && (
            <div className="flex items-center gap-2 rounded-md bg-[#151515] px-3 py-2 text-xs text-[#f0a15a]" role="status">
              <Loader2 className="size-3.5 animate-spin" />
              正在为你准备主理人会话...
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-200" role="alert">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              {error}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
