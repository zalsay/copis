import * as React from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import type { ChatRoomAgent, ChatRoomMember, ChatRoomRole } from '@copis/shared'
import { chatRoomApi } from '@/lib/chatroom-api'
import { chatRoomLocalRoomRevisionsAtom, chatRoomLocalRoomsAtom, chatRoomUpdateLocalAgentAtom } from '@/atoms/chatroom-atoms'
import { workingAuthLifecycleEpochAtom, workingAuthStateAtom } from '@/atoms/working-atoms'
import { getChatRoomAccountKey } from './ChatroomSseInitializer'

export interface ChatroomMembersPanelProps { roomId: string; role: ChatRoomRole; members: ChatRoomMember[]; agents: ChatRoomAgent[]; onChanged?: () => void }
type MemberAction = 'remove-agent' | 'remove-member' | 'share' | 'sync'

export function ChatroomMembersPanel({ roomId, role, members, agents, onChanged }: ChatroomMembersPanelProps): React.ReactElement {
  const [busy, setBusy] = React.useState<string | null>(null)
  const [errors, setErrors] = React.useState<Record<string, { action: MemberAction; message: string }>>({})
  const localRoom = useAtomValue(chatRoomLocalRoomsAtom).get(roomId)
  const updateLocalAgent = useSetAtom(chatRoomUpdateLocalAgentAtom)
  const authState = useAtomValue(workingAuthStateAtom)
  const authEpoch = useAtomValue(workingAuthLifecycleEpochAtom)
  const accountKey = getChatRoomAccountKey(authState)
  const store = useStore()
  const operationGenerationRef = React.useRef(0)
  const identityRef = React.useRef({ roomId, accountKey, authEpoch })
  identityRef.current = { roomId, accountKey, authEpoch }
  const previousIdentityRef = React.useRef({ roomId, accountKey, authEpoch })

  React.useEffect(() => {
    const previous = previousIdentityRef.current
    if (previous.roomId === roomId && previous.accountKey === accountKey && previous.authEpoch === authEpoch) return
    previousIdentityRef.current = { roomId, accountKey, authEpoch }
    operationGenerationRef.current += 1
    setBusy(null)
    setErrors({})
  }, [accountKey, authEpoch, roomId])
  React.useEffect(() => () => { operationGenerationRef.current += 1 }, [])

  const run = async (id: string, action: MemberAction, operation: (isCurrent: () => boolean) => Promise<void>): Promise<void> => {
    if (busy) return
    const requestRoomId = roomId
    const requestAccountKey = accountKey
    const requestAuthEpoch = authEpoch
    const generation = ++operationGenerationRef.current
    const isCurrent = (): boolean => generation === operationGenerationRef.current
      && identityRef.current.roomId === requestRoomId
      && identityRef.current.accountKey === requestAccountKey
      && identityRef.current.authEpoch === requestAuthEpoch
      && getChatRoomAccountKey(store.get(workingAuthStateAtom)) === requestAccountKey
      && store.get(workingAuthLifecycleEpochAtom) === requestAuthEpoch
    setBusy(id)
    setErrors((current) => { const next = { ...current }; delete next[id]; return next })
    try { await operation(isCurrent); if (isCurrent()) onChanged?.() }
    catch (error) { if (isCurrent()) setErrors((current) => ({ ...current, [id]: { action, message: error instanceof Error ? error.message : '操作失败' } })) }
    finally { if (isCurrent()) setBusy(null) }
  }

  const updateSharing = (agent: ChatRoomAgent, field: 'memorySharingEnabled' | 'skillSharingEnabled'): Promise<void> => {
    if (role !== 'host') return Promise.resolve()
    const localAgent = localRoom?.agents.find((item) => item.roomAgentId === agent.agentId)
    if (!localAgent) return Promise.resolve()
    const enabled = !localAgent[field]
    const localRevision = store.get(chatRoomLocalRoomRevisionsAtom).get(roomId) ?? 0
    return run(agent.agentId, 'share', async (isCurrent) => {
      const updated = await window.electronAPI.chatrooms.updateAgent({ roomId, roomAgentId: agent.agentId, [field]: enabled })
      if (!isCurrent() || (store.get(chatRoomLocalRoomRevisionsAtom).get(roomId) ?? 0) !== localRevision) return
      updateLocalAgent({ roomId, agent: updated, expectedRevision: localRevision })
    })
  }
  const syncSkills = (agentId: string): Promise<void> => role === 'host'
    ? run(agentId, 'sync', async () => { await window.electronAPI.chatrooms.syncAgentSkills({ roomId, roomAgentId: agentId }) })
    : Promise.resolve()
  const removeAgent = (agentId: string): Promise<void> => run(agentId, 'remove-agent', async () => { await window.electronAPI.chatrooms.removeAgent({ roomId, roomAgentId: agentId }) })
  const removeMember = (memberId: string): Promise<void> => run(memberId, 'remove-member', async () => { await chatRoomApi.removeMember(roomId, memberId) })

  return <aside aria-label="聊天室成员" className="w-64 shrink-0 border-l border-border/50 p-3 overflow-y-auto space-y-4">
    <section>
      <h2 className="mb-2 text-xs font-semibold text-muted-foreground">成员 · {members.length}</h2>
      <div className="space-y-1">{members.map((member) => {
        const failure = errors[member.userId]
        return <div key={member.userId} className="rounded-lg bg-muted/30 px-2 py-1.5 text-xs">
          <div className="flex items-center justify-between"><span>{member.displayName}{member.role === 'host' && <span className="ml-1 text-primary">主理人</span>}</span><span className="flex items-center gap-1"><span className={member.presence === 'offline' ? 'text-muted-foreground' : 'text-emerald-500'}>{member.presence === 'offline' ? '离线' : member.presence === 'busy' ? '忙碌' : '在线'}</span>{role === 'host' && member.role !== 'host' && <button type="button" disabled={busy !== null} onClick={() => void removeMember(member.userId)} className="text-destructive">{failure?.action === 'remove-member' ? '重试移除' : '移除'}</button>}</span></div>
          {failure && <p role="alert" className="mt-1 text-destructive">移除失败，可重试：{failure.message}</p>}
        </div>
      })}</div>
    </section>
    <section>
      <h2 className="mb-2 text-xs font-semibold text-muted-foreground">Agent · {agents.length}/3</h2>
      <div className="space-y-1">{agents.map((agent) => {
        const localAgent = localRoom?.agents.find((item) => item.roomAgentId === agent.agentId)
        const failure = errors[agent.agentId]
        const unavailableReason = localAgent ? undefined : '本机没有该 Agent 的已确认配置，不能修改共享设置'
        return <div key={agent.agentId} className="rounded-lg bg-muted/30 px-2 py-1.5 text-xs">
          <div className="flex items-center justify-between"><span>@{agent.displayName}</span><span className={agent.availability === 'online' ? 'text-emerald-500' : 'text-muted-foreground'}>{agent.availability === 'preparing' ? '宿主尚未就绪' : agent.availability === 'online' ? '在线' : agent.availability === 'busy' ? '忙碌' : agent.availability === 'offline' ? '宿主离线' : agent.availability === 'disabled' ? '已禁用' : agent.availability === 'configuration_error' ? '配置异常' : '状态未知'}</span></div>
          {localAgent?.localAvailability && <p className="mt-1 text-[10px] text-muted-foreground">本机状态：{localAgent.localAvailability === 'preparing' ? '尚未就绪' : localAgent.localAvailability === 'configuration_error' ? '配置异常' : localAgent.localAvailability === 'online' ? '可用' : localAgent.localAvailability === 'busy' ? '忙碌' : localAgent.localAvailability === 'disabled' ? '已禁用' : '离线'}</p>}
          {role === 'host' && <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
            <label title={unavailableReason}><input type="checkbox" checked={localAgent?.memorySharingEnabled ?? false} disabled={busy !== null || !localAgent} onChange={() => void updateSharing(agent, 'memorySharingEnabled')} /> 记忆</label>
            <label title={unavailableReason}><input type="checkbox" checked={localAgent?.skillSharingEnabled ?? false} disabled={busy !== null || !localAgent} onChange={() => void updateSharing(agent, 'skillSharingEnabled')} /> Skill</label>
            <button type="button" disabled={busy !== null} onClick={() => void syncSkills(agent.agentId)}>{failure?.action === 'sync' ? '重试同步' : '同步 Skill'}</button>
            <button type="button" disabled={busy !== null} onClick={() => void removeAgent(agent.agentId)} className="text-destructive">{failure?.action === 'remove-agent' ? '重试移除' : '移除'}</button>
          </div>}
          {unavailableReason && role === 'host' && <p className="mt-1 text-[10px] text-muted-foreground">{unavailableReason}</p>}
          {failure && <p role="alert" className="mt-1 text-destructive">{failure.action === 'remove-agent' ? 'Agent 移除失败，可重试' : failure.action === 'share' ? '共享设置更新失败，可重试' : 'Skill 同步失败，可重试'}：{failure.message}</p>}
        </div>
      })}</div>
    </section>
    {role === 'host' && <div className="border-t border-border/40 pt-3 text-[10px] text-muted-foreground">主理人权限：共享设置以本机已验证配置为准</div>}
  </aside>
}
