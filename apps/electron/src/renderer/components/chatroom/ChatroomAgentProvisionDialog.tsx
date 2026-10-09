import * as React from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import type { ChatRoomAgent, ChatRoomSummary } from '@copis/shared'
import { agentChannelIdAtom, agentModelIdAtom, agentWorkspacesAtom } from '@/atoms/agent-atoms'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ChatRoomProvisionError, provisionChatRoomAgents } from '@/lib/chatroom-api'
import { chatRoomApplyProvisionProgressAtom, chatRoomClearProvisionPlanAtom, chatRoomProvisionPlansAtom, chatRoomSetProvisionPlanAtom, type ChatRoomProvisionPlan, type ChatRoomProvisionProgressPayload } from '@/atoms/chatroom-atoms'
import { workingAuthLifecycleEpochAtom, workingAuthStateAtom } from '@/atoms/working-atoms'
import { getChatRoomAccountKey } from './ChatroomSseInitializer'

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
  const plans = useAtomValue(chatRoomProvisionPlansAtom)
  const setPlan = useSetAtom(chatRoomSetProvisionPlanAtom)
  const clearPlan = useSetAtom(chatRoomClearProvisionPlanAtom)
  const applyPlanProgress = useSetAtom(chatRoomApplyProvisionProgressAtom)
  const authState = useAtomValue(workingAuthStateAtom)
  const authEpoch = useAtomValue(workingAuthLifecycleEpochAtom)
  const accountKey = getChatRoomAccountKey(authState)
  const roomPlan = plans.get(room.roomId)
  const plan = roomPlan?.accountKey === accountKey && roomPlan.authEpoch === authEpoch ? roomPlan : undefined
  const store = useStore()
  const previousAuthRef = React.useRef({ accountKey, authEpoch })
  const previousRoomIdRef = React.useRef(room.roomId)
  const currentRoomIdRef = React.useRef(room.roomId)
  currentRoomIdRef.current = room.roomId
  const operationGenerationRef = React.useRef(0)
  const isCurrentOperation = (generation: number, startedAccountKey: string, startedAuthEpoch: number, startedRoomId: string): boolean => operationGenerationRef.current === generation
    && currentRoomIdRef.current === startedRoomId
    && getChatRoomAccountKey(store.get(workingAuthStateAtom)) === startedAccountKey
    && store.get(workingAuthLifecycleEpochAtom) === startedAuthEpoch
  const applyDurableProgress = (operationPlan: ChatRoomProvisionPlan, update: ChatRoomProvisionProgressPayload): void => {
    if (getChatRoomAccountKey(store.get(workingAuthStateAtom)) !== operationPlan.accountKey) return
    if (store.get(workingAuthLifecycleEpochAtom) !== operationPlan.authEpoch) return
    const current = store.get(chatRoomProvisionPlansAtom).get(operationPlan.room.roomId)
    if (current?.authEpoch !== operationPlan.authEpoch || current.operationId !== operationPlan.operationId || current.attemptId !== operationPlan.attemptId) return
    applyPlanProgress({ ...update, roomId: operationPlan.room.roomId, accountKey: operationPlan.accountKey, authEpoch: operationPlan.authEpoch, operationId: operationPlan.operationId, attemptId: operationPlan.attemptId })
  }
  const [selected, setSelected] = React.useState<string[]>([])
  const [sharing, setSharing] = React.useState<Record<string, { memory: boolean; skills: boolean }>>({})
  const [completed, setCompleted] = React.useState(0)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  React.useEffect(() => {
    if (open && plan) { setSelected(plan.agents.map((agent) => agent.sourceWorkspaceId)); setCompleted(plan.completed); setError(plan.error ?? '') }
    if (!open && !busy) { setSelected([]); setCompleted(0); setError('') }
  }, [open, room.roomId])
  React.useEffect(() => {
    const previous = previousAuthRef.current
    if (previous.accountKey === accountKey && previous.authEpoch === authEpoch) return
    previousAuthRef.current = { accountKey, authEpoch }
    operationGenerationRef.current += 1
    if (roomPlan?.accountKey === previous.accountKey && roomPlan.authEpoch === previous.authEpoch) clearPlan(room.roomId)
    setBusy(false); setSelected([]); setCompleted(0); setError('')
    onOpenChange(false)
  }, [accountKey, authEpoch, clearPlan, onOpenChange, roomPlan, room.roomId])
  React.useEffect(() => {
    if (previousRoomIdRef.current === room.roomId) return
    previousRoomIdRef.current = room.roomId
    operationGenerationRef.current += 1
    const storedPlan = store.get(chatRoomProvisionPlansAtom).get(room.roomId)
    const nextPlan = storedPlan?.accountKey === accountKey && storedPlan.authEpoch === authEpoch ? storedPlan : undefined
    setBusy(false)
    setSelected(nextPlan?.agents.map((agent) => agent.sourceWorkspaceId) ?? [])
    setCompleted(nextPlan?.completed ?? 0)
    setError(nextPlan?.error ?? '')
  }, [accountKey, authEpoch, room.roomId, store])
  React.useEffect(() => () => { operationGenerationRef.current += 1 }, [])
  const available = workspaces.filter((workspace) => !agents.some((agent) => agent.displayName.toLowerCase() === workspace.name.toLowerCase()))
  const maxNewAgents = Math.max(0, 3 - agents.length)
  const agentRows = plan
    ? plan.agents.map((agent) => ({ id: agent.sourceWorkspaceId, name: agent.displayName, frozenAgent: agent }))
    : available.map((workspace) => ({ id: workspace.id, name: workspace.name, frozenAgent: undefined }))

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (busy || !selected.length) return
    const existingPlan = store.get(chatRoomProvisionPlansAtom).get(room.roomId)
    if (existingPlan && (existingPlan.accountKey !== accountKey || existingPlan.authEpoch !== authEpoch)) { setError('此房间的配置计划属于其他账号或认证生命周期，不能继续操作'); return }
    if (!existingPlan && !channelId) { setError('请先配置 Agent 渠道'); return }
    setBusy(true); setError('')
    const snapshot = existingPlan?.agents ?? selected.map((id) => ({
      sourceWorkspaceId: id,
      displayName: workspaces.find((workspace) => workspace.id === id)?.name ?? 'Agent',
      channelId: channelId ?? '',
      ...(modelId ? { modelId } : {}),
      contextMessageCount: 50,
      memorySharingEnabled: sharing[id]?.memory ?? false,
      skillSharingEnabled: sharing[id]?.skills ?? false,
    }))
    const before = existingPlan?.completed ?? 0
    const generation = ++operationGenerationRef.current
    const startedAccountKey = accountKey
    const startedAuthEpoch = authEpoch
    const startedRoomId = room.roomId
    let operationPlan: ChatRoomProvisionPlan = existingPlan ?? {
      room,
      agents: snapshot.map((agent) => ({ ...agent })),
      completed: before,
      accountKey: startedAccountKey,
      authEpoch: startedAuthEpoch,
      operationId: crypto.randomUUID(),
      attemptId: '',
    }
    if (operationPlan.inFlightIndex !== undefined) {
      setError(`正在确认 Agent「${operationPlan.inFlightAgentName ?? ''}」的配置结果`)
      setBusy(false)
      return
    }
    operationPlan = { ...operationPlan, attemptId: crypto.randomUUID(), inFlightIndex: before, inFlightAgentName: operationPlan.agents[before]?.displayName }
    setPlan(operationPlan)
    try {
      await provisionChatRoomAgents(room, operationPlan.agents.slice(before), { operation: 'add', onProvisionStart: ({ completed: count, agentName }) => {
        applyDurableProgress(operationPlan, { phase: 'started', index: before + count, agentName })
      }, onProvisionProgress: ({ completed: count }) => {
        if (count === 0) return
        const completedCount = before + count
        applyDurableProgress(operationPlan, { phase: 'progress', completed: completedCount })
        if (isCurrentOperation(generation, startedAccountKey, startedAuthEpoch, startedRoomId)) setCompleted(completedCount)
      } })
      applyDurableProgress(operationPlan, { phase: 'finished' })
      if (!isCurrentOperation(generation, startedAccountKey, startedAuthEpoch, startedRoomId)) return
      onProvisioned(); onOpenChange(false)
    } catch (cause) {
      if (getChatRoomAccountKey(store.get(workingAuthStateAtom)) !== startedAccountKey || store.get(workingAuthLifecycleEpochAtom) !== startedAuthEpoch) return
      if (cause instanceof ChatRoomProvisionError) {
        const completedCount = store.get(chatRoomProvisionPlansAtom).get(room.roomId)?.completed ?? before + cause.succeededCount
        applyDurableProgress(operationPlan, { phase: 'failed', completed: completedCount, error: cause.message })
        if (cause.succeededCount && isCurrentOperation(generation, startedAccountKey, startedAuthEpoch, startedRoomId)) onProvisioned()
      }
      if (isCurrentOperation(generation, startedAccountKey, startedAuthEpoch, startedRoomId)) setError(cause instanceof Error ? cause.message : '添加 Agent 失败')
    } finally { if (isCurrentOperation(generation, startedAccountKey, startedAuthEpoch, startedRoomId)) setBusy(false) }
  }

  const progressCount = plan?.completed ?? completed
  const planInFlight = plan?.inFlightIndex !== undefined

  return <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}><DialogContent>
    <DialogHeader><DialogTitle>{plan ? '继续配置 Agent' : '添加 Agent'}</DialogTitle><DialogDescription>为「{room.name}」配置本地工作区 Agent，最多 3 个；配置完成后仍需建立连接</DialogDescription></DialogHeader>
    <form onSubmit={(event) => void submit(event)} className="space-y-3">
      {agentRows.length === 0 && <p className="text-sm text-muted-foreground">暂无可添加的工作区 Agent</p>}
      {agentRows.map((workspace) => {
        const frozenAgent = workspace.frozenAgent
        const options = frozenAgent ? { memory: frozenAgent.memorySharingEnabled ?? false, skills: frozenAgent.skillSharingEnabled ?? false } : sharing[workspace.id] ?? { memory: false, skills: false }
        return <div key={workspace.id} className="rounded-lg bg-muted/40 px-3 py-2 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={selected.includes(workspace.id)} disabled={busy || plan !== undefined || completed > 0 || (!selected.includes(workspace.id) && selected.length >= maxNewAgents)} onChange={() => setSelected((current) => current.includes(workspace.id) ? current.filter((id) => id !== workspace.id) : [...current, workspace.id])} />{workspace.name}</label>
          {selected.includes(workspace.id) && <div className="ml-6 mt-2 flex gap-4 text-xs text-muted-foreground"><label><input type="checkbox" checked={options.memory} disabled={plan !== undefined || busy} onChange={(event) => setSharing((current) => ({ ...current, [workspace.id]: { ...options, memory: event.target.checked } }))} /> 共享记忆</label><label><input type="checkbox" checked={options.skills} disabled={plan !== undefined || busy} onChange={(event) => setSharing((current) => ({ ...current, [workspace.id]: { ...options, skills: event.target.checked } }))} /> 共享 Skill</label></div>}
        </div>
      })}
      {selected.length > 0 && <p role="status" className="text-xs text-muted-foreground">{planInFlight ? `正在确认 Agent「${plan?.inFlightAgentName ?? ''}」配置结果` : `Agent 配置 ${progressCount}/${selected.length}（准备连接，不代表 Agent 在线）`}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <DialogFooter><Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={busy || planInFlight || !selected.length || progressCount === selected.length}>{plan ? '重试配置' : '添加 Agent'}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>
}
