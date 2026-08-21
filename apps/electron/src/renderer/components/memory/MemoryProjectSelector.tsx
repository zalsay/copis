import * as React from 'react'
import type { AgentWorkspace } from '@copis/shared'

interface MemoryProjectSelectorProps {
  workspaces: AgentWorkspace[]
  selectedWorkspaceId: string | null
  onChange: (workspaceId: string | null) => void
}

export function MemoryProjectSelector({ workspaces, selectedWorkspaceId, onChange }: MemoryProjectSelectorProps): React.ReactElement {
  return (
    <label className="flex h-9 min-w-0 items-center gap-2 text-xs leading-none text-foreground/45">
      <span className="shrink-0 leading-none">项目</span>
      <select
        aria-label="当前项目"
        value={selectedWorkspaceId ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
        disabled={workspaces.length === 0}
        className="h-9 min-w-0 max-w-[min(22rem,45vw)] rounded-lg bg-muted/60 px-2.5 text-sm leading-none text-foreground/80 outline-none transition-colors focus:ring-1 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {workspaces.length === 0 ? (
          <option value="">暂无项目，仅用户记忆</option>
        ) : (
          workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
          ))
        )}
      </select>
    </label>
  )
}
