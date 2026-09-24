import * as React from 'react'
import { useAtomValue } from 'jotai'
import type { ChatRoomAgent, ChatRoomSummary } from '@copis/shared'
import { agentChannelIdAtom, agentModelIdAtom, agentWorkspacesAtom } from '@/atoms/agent-atoms'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ChatRoomProvisionError, provisionChatRoomAgents } from '@/lib/chatroom-api'

export function ChatroomAgentProvisionDialog({ open, room, agents, onOpenChange, onProvisioned }: {
  open: boolean
  room: ChatRoomSummary
  agents: ChatRoomAgent[]
  onOpenChange: (open: boolean) => void
  onProvisioned: () => void
}): React.ReactElement {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const channelId = useAtomValue(agentChannelIdAtom)
  const modelId = useAtomValue(agentModelIdAtom)
  const [selected, setSelected] = React.useState<string[]>([])
  const [sharing, setSharing] = React.useState<Record<string, { memory: boolean; skills: boolean }>>({})
  const [completed, setCompleted] = React.useState(0)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  React.useEffect(() => { if (!open) { setSelected([]); setCompleted(0); setError('') } }, [open])
  const available = workspaces.filter((workspace) => !agents.some((agent) => agent.displayName.toLowerCase() === workspace.name.toLowerCase()))
  const maxNewAgents = Math.max(0, 3 - agents.length)

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (busy || !selected.length) return
    if (!channelId) { setError('请先配置 Agent 渠道'); return }
    setBusy(true); setError('')
    const before = completed
    const pending = selected.slice(before).map((id) => ({
      sourceWorkspaceId: id,
      displayName: workspaces.find((workspace) => workspace.id === id)?.name ?? 'Agent',
      channelId,
      ...(modelId ? { modelId } : {}),
      contextMessageCount: 50,
      memorySharingEnabled: sharing[id]?.memory ?? false,
      skillSharingEnabled: sharing[id]?.skills ?? false,
    }))
    try {
      await provisionChatRoomAgents(room, pending, { operation: 'add', onProvisionProgress: ({ completed: count }) => setCompleted(before + count) })
      onProvisioned()
      onOpenChange(false)
    } catch (cause) {
      if (cause instanceof ChatRoomProvisionError) {
        setCompleted(before + cause.succeededCount)
        if (cause.succeededCount) onProvisioned()
      }
      setError(cause instanceof Error ? cause.message : '添加 Agent 失败')
    } finally { setBusy(false) }
  }

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent>
    <DialogHeader><DialogTitle>添加 Agent</DialogTitle><DialogDescription>为「{room.name}」添加本地工作区 Agent，最多 3 个</DialogDescription></DialogHeader>
    <form onSubmit={(event) => void submit(event)} className="space-y-3">
      {available.length === 0 && <p className="text-sm text-muted-foreground">暂无可添加的工作区 Agent</p>}
      {available.map((workspace) => {
        const options = sharing[workspace.id] ?? { memory: false, skills: false }
        return <div key={workspace.id} className="rounded-lg bg-muted/40 px-3 py-2 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={selected.includes(workspace.id)} disabled={busy || completed > 0 || (!selected.includes(workspace.id) && selected.length >= maxNewAgents)} onChange={() => setSelected((current) => current.includes(workspace.id) ? current.filter((id) => id !== workspace.id) : [...current, workspace.id])} />{workspace.name}</label>
          {selected.includes(workspace.id) && <div className="ml-6 mt-2 flex gap-4 text-xs text-muted-foreground"><label><input type="checkbox" checked={options.memory} onChange={(event) => setSharing((current) => ({ ...current, [workspace.id]: { ...options, memory: event.target.checked } }))} /> 共享记忆</label><label><input type="checkbox" checked={options.skills} onChange={(event) => setSharing((current) => ({ ...current, [workspace.id]: { ...options, skills: event.target.checked } }))} /> 共享 Skill</label></div>}
        </div>
      })}
      {selected.length > 0 && <p role="status" className="text-xs text-muted-foreground">Agent 配置 {completed}/{selected.length}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <DialogFooter><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={busy || !selected.length || completed === selected.length}>添加 Agent</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>
}
