import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { chatRoomApi, ChatRoomProvisionError, provisionChatRoomAgents } from '@/lib/chatroom-api'
import type { ChatRoomSummary } from '@copis/shared'
import { openChatRoomTab, tabsAtom, activeTabIdAtom } from '@/atoms/tab-atoms'
import { agentChannelIdAtom, agentModelIdAtom, agentWorkspacesAtom } from '@/atoms/agent-atoms'
import { chatRoomApplyProvisionProgressAtom, chatRoomClearProvisionPlanAtom, chatRoomProvisionPlansAtom, chatRoomRoomsAtom, chatRoomSetProvisionPlanAtom, type ChatRoomProvisionPlan, type ChatRoomProvisionProgressPayload } from '@/atoms/chatroom-atoms'
import { workingAuthLifecycleEpochAtom, workingAuthStateAtom } from '@/atoms/working-atoms'
import { getChatRoomAccountKey } from './ChatroomSseInitializer'

export function ChatroomCreateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }): React.ReactElement {
  const [name, setName] = React.useState('')
  const [code, setCode] = React.useState('')
  const [error, setError] = React.useState('')
  const [createdRoom, setCreatedRoom] = React.useState<ChatRoomSummary | null>(null)
  const createdRoomId = createdRoom?.roomId ?? null
  const [busy, setBusy] = React.useState(false)
  const [selected, setSelected] = React.useState<string[]>([])
  const [sharing, setSharing] = React.useState<Record<string, { memory: boolean; skills: boolean }>>({})
  const [progress, setProgress] = React.useState(0)
  const [provisionTotal, setProvisionTotal] = React.useState(0)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const channelId = useAtomValue(agentChannelIdAtom)
  const modelId = useAtomValue(agentModelIdAtom)
  const [tabs, setTabs] = useAtom(tabsAtom)
  const [, setActive] = useAtom(activeTabIdAtom)
  const setRooms = useSetAtom(chatRoomRoomsAtom)
  const plans = useAtomValue(chatRoomProvisionPlansAtom)
  const setPlan = useSetAtom(chatRoomSetProvisionPlanAtom)
  const clearPlan = useSetAtom(chatRoomClearProvisionPlanAtom)
  const applyPlanProgress = useSetAtom(chatRoomApplyProvisionProgressAtom)
  const authState = useAtomValue(workingAuthStateAtom)
  const authEpoch = useAtomValue(workingAuthLifecycleEpochAtom)
  const accountKey = getChatRoomAccountKey(authState)
  const store = useStore()
  const previousAuthRef = React.useRef({ accountKey, authEpoch })
  const operationGenerationRef = React.useRef(0)
  const observedPlanOperationRef = React.useRef<string>()
  const isCurrentOperation = (generation: number, startedAccountKey: string, startedAuthEpoch: number): boolean => operationGenerationRef.current === generation
    && getChatRoomAccountKey(store.get(workingAuthStateAtom)) === startedAccountKey
    && store.get(workingAuthLifecycleEpochAtom) === startedAuthEpoch
  const applyDurableProgress = (plan: ChatRoomProvisionPlan, update: ChatRoomProvisionProgressPayload): void => {
    if (getChatRoomAccountKey(store.get(workingAuthStateAtom)) !== plan.accountKey) return
    if (store.get(workingAuthLifecycleEpochAtom) !== plan.authEpoch) return
    const current = store.get(chatRoomProvisionPlansAtom).get(plan.room.roomId)
    if (current?.authEpoch !== plan.authEpoch || current.operationId !== plan.operationId || current.attemptId !== plan.attemptId) return
    applyPlanProgress({ ...update, roomId: plan.room.roomId, accountKey: plan.accountKey, authEpoch: plan.authEpoch, operationId: plan.operationId, attemptId: plan.attemptId })
  }

  React.useEffect(() => {
    const previous = previousAuthRef.current
    if (previous.accountKey === accountKey && previous.authEpoch === authEpoch) return
    previousAuthRef.current = { accountKey, authEpoch }
    operationGenerationRef.current += 1
    if (createdRoomId) {
      const previousPlan = store.get(chatRoomProvisionPlansAtom).get(createdRoomId)
      if (previousPlan?.authEpoch === previous.authEpoch) clearPlan(createdRoomId)
    }
    setBusy(false); setName(''); setCode(''); setSelected([]); setCreatedRoom(null); setError(''); setProgress(0); setProvisionTotal(0)
  }, [accountKey, authEpoch, clearPlan, createdRoomId, store])
  React.useEffect(() => () => { operationGenerationRef.current += 1 }, [])

  React.useEffect(() => {
    if (!open) {
      if (!busy) { setName(''); setCode(''); setSelected([]); setCreatedRoom(null); setError(''); setProgress(0); setProvisionTotal(0) }
      return
    }
    if (!createdRoom) {
      const plan = [...plans.values()].find((item) => item.accountKey === accountKey && item.authEpoch === authEpoch && (item.completed < item.agents.length || item.inFlightIndex !== undefined))
      if (plan) {
        setCreatedRoom(plan.room)
        setSelected(plan.agents.map((agent) => agent.sourceWorkspaceId))
        setProgress(plan.completed)
        setProvisionTotal(plan.agents.length)
        setError(plan.error ?? '')
      }
    }
  }, [open, busy, createdRoom, plans, accountKey, authEpoch])
  const candidatePlan = createdRoomId ? plans.get(createdRoomId) : undefined
  const frozenPlan = candidatePlan?.accountKey === accountKey && candidatePlan.authEpoch === authEpoch ? candidatePlan : undefined
  React.useEffect(() => {
    if (frozenPlan) { observedPlanOperationRef.current = frozenPlan.operationId; return }
    if (open && createdRoomId && observedPlanOperationRef.current && !busy) {
      observedPlanOperationRef.current = undefined
      setProgress(provisionTotal)
      onOpenChange(false)
    }
  }, [busy, createdRoomId, frozenPlan, onOpenChange, open, provisionTotal])

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (busy) return
    setError('')
    if (!createdRoom && (!name.trim() || !/^[A-Z0-9]{4}$/.test(code.trim().toUpperCase()))) { setError('请填写名称和4位分享码'); return }
    if (!createdRoom && selected.length > 0 && !channelId) { setError('请先配置 Agent 渠道'); return }
    const agents = selected.map((id) => ({
      sourceWorkspaceId: id,
      displayName: workspaces.find((workspace) => workspace.id === id)?.name ?? 'Agent',
      channelId: channelId ?? '',
      ...(modelId ? { modelId } : {}),
      contextMessageCount: 50,
      memorySharingEnabled: sharing[id]?.memory ?? false,
      skillSharingEnabled: sharing[id]?.skills ?? false,
    }))
    const startedAccountKey = accountKey
    const startedAuthEpoch = store.get(workingAuthLifecycleEpochAtom)
    const generation = ++operationGenerationRef.current
    setBusy(true)
    try {
      const room = createdRoom ?? await chatRoomApi.createRoom({ name: name.trim(), shareCode: code.trim() })
      if (getChatRoomAccountKey(store.get(workingAuthStateAtom)) !== startedAccountKey || store.get(workingAuthLifecycleEpochAtom) !== startedAuthEpoch) return
      if (!createdRoom) {
        setRooms((current) => [...current.filter((item) => item.roomId !== room.roomId), room])
        if (isCurrentOperation(generation, startedAccountKey, startedAuthEpoch)) {
          setCreatedRoom(room)
          const next = openChatRoomTab(tabs, room)
          setTabs(next.tabs)
          setActive(next.activeTabId)
        }
      }
      let plan = store.get(chatRoomProvisionPlansAtom).get(room.roomId)
      if (plan && (plan.accountKey !== startedAccountKey || plan.authEpoch !== startedAuthEpoch)) { if (isCurrentOperation(generation, startedAccountKey, startedAuthEpoch)) setError('此房间的配置计划属于其他账号或认证生命周期，不能继续操作'); return }
      if (!createdRoom && agents.length > 0 && !plan) {
        plan = { room, agents: agents.map((agent) => ({ ...agent })), completed: 0, accountKey: startedAccountKey, authEpoch: startedAuthEpoch, operationId: crypto.randomUUID(), attemptId: '' }
      }
      if (plan && plan.completed < plan.agents.length) {
        if (plan.inFlightIndex !== undefined) {
          if (isCurrentOperation(generation, startedAccountKey, startedAuthEpoch)) setError(`正在确认 Agent「${plan.inFlightAgentName ?? ''}」的配置结果`)
          return
        }
        const attemptPlan: ChatRoomProvisionPlan = { ...plan, attemptId: crypto.randomUUID(), inFlightIndex: plan.completed, inFlightAgentName: plan.agents[plan.completed]?.displayName }
        setPlan(attemptPlan)
        plan = attemptPlan
        if (isCurrentOperation(generation, startedAccountKey, startedAuthEpoch)) setProvisionTotal(plan.agents.length)
        const completedBeforeRetry = plan.completed
        await provisionChatRoomAgents(room, plan.agents.slice(completedBeforeRetry), { onProvisionStart: ({ completed, agentName }) => {
          applyDurableProgress(plan!, { phase: 'started', index: completedBeforeRetry + completed, agentName })
          if (isCurrentOperation(generation, startedAccountKey, startedAuthEpoch)) setError('')
        }, onProvisionProgress: ({ completed }) => {
          if (completed === 0) return
          const completedCount = completedBeforeRetry + completed
          applyDurableProgress(plan!, { phase: 'progress', completed: completedCount })
          if (isCurrentOperation(generation, startedAccountKey, startedAuthEpoch)) setProgress(completedCount)
        } })
      }
      if (plan) applyDurableProgress(plan, { phase: 'finished' })
      if (!isCurrentOperation(generation, startedAccountKey, startedAuthEpoch)) return
      setRooms((current) => [...current.filter((item) => item.roomId !== room.roomId), room])
      const next = openChatRoomTab(tabs, room); setTabs(next.tabs); setActive(next.activeTabId)
      onOpenChange(false); setName(''); setCode(''); setSelected([]); setProgress(0); setProvisionTotal(0)
    } catch (cause) {
      if (getChatRoomAccountKey(store.get(workingAuthStateAtom)) !== startedAccountKey || store.get(workingAuthLifecycleEpochAtom) !== startedAuthEpoch) return
      if (cause instanceof ChatRoomProvisionError) {
        const plan = store.get(chatRoomProvisionPlansAtom).get(cause.room.roomId)
        const completed = plan?.completed ?? cause.succeededCount
        if (plan) applyDurableProgress(plan, { phase: 'failed', completed, error: cause.message })
        if (!isCurrentOperation(generation, startedAccountKey, startedAuthEpoch)) return
        setProgress(completed); setProvisionTotal(plan?.agents.length ?? agents.length)
        setRooms((current) => [...current.filter((item) => item.roomId !== cause.room.roomId), cause.room])
        const next = openChatRoomTab(tabs, cause.room)
        setTabs(next.tabs)
        setActive(next.activeTabId)
        setCreatedRoom(cause.room)
        setError(cause.message)
      } else if (isCurrentOperation(generation, startedAccountKey, startedAuthEpoch)) setError(cause instanceof Error ? cause.message : '创建聊天室失败')
    } finally { if (isCurrentOperation(generation, startedAccountKey, startedAuthEpoch)) setBusy(false) }
  }
  const agentRows = frozenPlan
    ? frozenPlan.agents.map((agent) => ({ id: agent.sourceWorkspaceId, name: agent.displayName, frozenAgent: agent }))
    : workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name, frozenAgent: undefined }))

  return <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{createdRoom ? '继续配置聊天室' : '创建聊天室'}</DialogTitle>
        <DialogDescription>创建后可邀请成员加入，并选择最多3个本地 Agent；配置完成后仍需建立连接</DialogDescription>
      </DialogHeader>
      <form onSubmit={(event) => void submit(event)} className="space-y-3">
        <input aria-label="聊天室名称" value={name} disabled={createdRoomId !== null} onChange={(event) => setName(event.target.value)} placeholder="例如：产品讨论" className="w-full rounded-lg bg-muted px-3 py-2 outline-none" />
        <input aria-label="分享码" maxLength={4} value={code} disabled={createdRoomId !== null} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="4位字母或数字" className="w-full rounded-lg bg-muted px-3 py-2 uppercase tracking-widest outline-none" />
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">选择 Agent（{selected.length}/3）</div>
          {agentRows.map((workspace) => {
            const frozenAgent = workspace.frozenAgent
            const options = frozenAgent ? { memory: frozenAgent.memorySharingEnabled ?? false, skills: frozenAgent.skillSharingEnabled ?? false } : sharing[workspace.id] ?? { memory: false, skills: false }
            return <div key={workspace.id} className="rounded-lg px-2 py-1.5 hover:bg-muted">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={selected.includes(workspace.id)} disabled={busy || createdRoomId !== null || (!selected.includes(workspace.id) && selected.length >= 3)} onChange={() => setSelected((current) => current.includes(workspace.id) ? current.filter((id) => id !== workspace.id) : [...current, workspace.id])} />
                {workspace.name}
              </label>
              {selected.includes(workspace.id) && <div className="ml-6 mt-1 flex gap-3 text-[10px] text-muted-foreground">
                <label><input type="checkbox" checked={options.memory} disabled={busy || createdRoomId !== null} onChange={(event) => setSharing((current) => ({ ...current, [workspace.id]: { ...options, memory: event.target.checked } }))} /> 共享记忆</label>
                <label><input type="checkbox" checked={options.skills} disabled={busy || createdRoomId !== null} onChange={(event) => setSharing((current) => ({ ...current, [workspace.id]: { ...options, skills: event.target.checked } }))} /> 共享 Skill</label>
              </div>}
            </div>
          })}
        </div>
        {provisionTotal > 0 && <div role="status" className="text-xs text-muted-foreground">{frozenPlan?.inFlightIndex !== undefined ? `正在确认 Agent「${frozenPlan.inFlightAgentName ?? ''}」的配置结果` : `Agent 配置 ${frozenPlan?.completed ?? progress}/${provisionTotal}（准备连接，不代表 Agent 在线）`}</div>}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="submit" disabled={busy || frozenPlan?.inFlightIndex !== undefined || (createdRoomId !== null && (frozenPlan?.completed ?? progress) >= selected.length)}>{createdRoom ? '继续配置' : '创建'}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}
