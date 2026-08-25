import * as React from 'react'
import type { AgentWorkspace } from '@copis/shared'
import { AppSelect } from '@/components/ui/select'

interface MemoryProjectSelectorProps {
  workspaces: AgentWorkspace[]
  selectedWorkspaceId: string | null
  onChange: (workspaceId: string | null) => void
}

export function MemoryProjectSelector({ workspaces, selectedWorkspaceId, onChange }: MemoryProjectSelectorProps): React.ReactElement {
  const effectiveSelectedId = selectedWorkspaceId ?? (workspaces[0]?.id ?? '__none__')
  const options = React.useMemo(() => {
    if (workspaces.length === 0) {
      return [{ value: '__none__', label: '暂无项目，仅用户记忆' }]
    }
    return workspaces.map((workspace) => ({
      value: workspace.id,
      label: workspace.name,
    }))
  }, [workspaces])

  return (
    <div className="flex h-9 min-w-0 items-center gap-2 text-xs leading-none text-foreground/45">
      <span className="shrink-0 leading-none">项目</span>
      <AppSelect
        aria-label="当前项目"
        value={effectiveSelectedId}
        onValueChange={(val) => onChange(val === '__none__' ? null : val)}
        disabled={workspaces.length === 0}
        size="sm"
        triggerClassName="h-9 min-w-36 max-w-[min(22rem,45vw)] bg-muted/60"
        options={options}
      />
    </div>
  )
}
