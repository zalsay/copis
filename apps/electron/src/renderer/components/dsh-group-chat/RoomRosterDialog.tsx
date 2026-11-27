import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DshRoomModelSelection } from '@copis/shared'
import { Button } from '@/components/ui/button'
import { RoomDialog } from './RoomDialog'
import { readRoomAgentOptions, RoomAgentPicker, type RoomAgentOption } from './RoomAgentPicker'
import { isRoomModel, RoomModelPicker, sameModel } from './RoomModelPicker'
import type { HostAgent } from './shared-room-data'
import type { RoomRequest } from './useSharedRoomFeed'

interface Roster {
  options: RoomAgentOption[]
  agents: HostAgent[]
  local: Map<string, string> // 工作区 ID → 本群已登记的智能体 ID，不按名称猜测。
  external: number
}
async function readRoster(roomId: string, request: RoomRequest, refreshAgents: () => Promise<HostAgent[]>): Promise<Roster> {
  const [raw, agents] = await Promise.all([request({ action: 'agentOptions', roomId }), refreshAgents()])
  const options = readRoomAgentOptions(raw)
  const serverIds = new Set(agents.map(a => a.id))
  const local = new Map(options.flatMap(o => o.roomAgentId && serverIds.has(o.roomAgentId) ? [[o.id, o.roomAgentId] as const] : []))
  return { options, agents, local, external: agents.length - new Set(local.values()).size }
}

type Change = { operationId: string } & (
  | { action: 'registerAgent'; workspaceId: string }
  | { action: 'removeAgent'; roomAgentId: string }
)

/** 编辑会话固定所属群、起始名单及意图。部分成功后仅重试未确认的操作。 */
export function RoomRosterDialog({ roomId, roomName, request, refreshAgents, onClose }: {
  roomId: string
  roomName?: string
  request: RoomRequest
  refreshAgents: () => Promise<HostAgent[]>
  onClose: () => void
}) {
  const [roster, setRoster] = useState<Roster>()
  const [selected, setSelected] = useState<string[]>([])
  const [draft, setDraft] = useState<{ roomAgentId: string; model: DshRoomModelSelection }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const alive = useRef(false)
  const lock = useRef(false)
  const pending = useRef<Change[] | null>(null)
  const expected = useRef(new Map<string, boolean>())
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    let active = true
    setError('')
    void readRoster(roomId, request, refreshAgents).then(initial => {
      if (!active) return
      setRoster(initial)
      setSelected([...initial.local.keys()])
    }).catch(e => { if (active) setError(e instanceof Error ? e.message : '读取名单失败') })
    return () => { active = false }
  }, [roomId, request, refreshAgents, reload])
  const changed = roster && (roster.local.size !== selected.length || selected.some(id => !roster.local.has(id)))
  const roomAgentId = roster?.agents.length === 1 && roster.local.size === 1 && selected.length === 1
    ? roster.local.get(selected[0]!) : undefined
  const savingRoster = pending.current !== null || changed
  const model = !savingRoster && draft?.roomAgentId === roomAgentId ? draft?.model : undefined
  const canSave = roster && (savingRoster || model) && roster.external + selected.length <= 1
  async function save() {
    if (!canSave || lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    try {
      if (model && roomAgentId) {
        const { channelId, modelId } = model
        const receipt = await request({ action: 'setRoomModel', roomId, roomAgentId, channelId, modelId })
        if (!isRoomModel(receipt) || !sameModel(receipt, model)) throw new Error('本群回答模型保存回执不匹配')
        if (alive.current) onClose()
        return
      }
      // 编辑期间其他设备可能已占用名额，不能先移除再发现替换不可行。
      const fresh = await readRoster(roomId, request, refreshAgents)
      if (!alive.current) return
      setRoster(fresh)
      if (fresh.external + selected.length > 1) {
        setError('其他设备的共享名单已变化，当前选择超过每群一位的上限。')
        return
      }
      if (!pending.current) {
        if (fresh.local.size !== roster.local.size || [...fresh.local].some(([id, member]) => roster.local.get(id) !== member)) {
          setError('本机共享名单已变化，请确认后再保存。')
          return
        }
        pending.current = [
          ...Array.from(fresh.local).filter(([id]) => !selected.includes(id)).map(([, roomAgentId]) =>
            ({ action: 'removeAgent' as const, roomAgentId, operationId: crypto.randomUUID() })),
          ...selected.filter(id => !fresh.local.has(id)).map(workspaceId =>
            ({ action: 'registerAgent' as const, workspaceId, operationId: crypto.randomUUID() })),
        ]
      }
      while (alive.current && pending.current.length) {
        const command = pending.current[0]!
        const receipt = await request({ ...command, roomId }) as { roomAgentId?: string } | null
        if (!alive.current) return
        if (!receipt?.roomAgentId || (command.action === 'removeAgent' && command.roomAgentId !== receipt.roomAgentId))
          throw new Error('智能体操作回执不匹配')
        expected.current.set(receipt.roomAgentId, command.action === 'registerAgent')
        pending.current.shift()
      }
      if (!alive.current) return
      const latest = await refreshAgents()
      if (!alive.current) return
      if (latest.length > 1 || [...expected.current].some(([id, present]) => latest.some(a => a.id === id) !== present))
        throw new Error('服务端名单已变化，请重新打开确认')
      onClose()
    } catch (e) {
      if (alive.current) {
        if (model) {
          setDraft(undefined)
          setError(e instanceof Error ? e.message : '本群回答模型保存失败')
          return
        }
        setError(`${e instanceof Error ? e.message : '保存失败'}。可重试，已确认的操作不会重复。`)
        // 可能已保存一部分，已共享名单只展示服务端当前状态，不把剩余勾选冒充成功。
        try {
          const latest = await readRoster(roomId, request, refreshAgents)
          if (alive.current) setRoster(latest)
        } catch { /* 保留原错误；重试会重新核实服务端名单。 */ }
      }
    } finally {
      lock.current = false
      if (alive.current) setBusy(false)
    }
  }
  return <RoomDialog size="roster" title={roomName ? `群智能体 · ${roomName}` : '群智能体'} busy={busy} onClose={onClose}>
    {roster ? <div className="grid gap-3">
      <RosterList agents={roster.agents} />
      {roster.agents.length > 1 && <p className="text-sm">此群已共享多位智能体，每群最多一位。{roster.external === 0
        ? '请选择要保留的智能体，保存后才会移除其他成员。'
        : roster.external === 1 ? '保留其他设备的智能体时，须取消全部本机勾选。' : '本机无法将名单减至一位，不能保存。'}</p>}
      {roster.external > 0 && <p className="text-xs text-muted-foreground">{roster.external} 个智能体未绑定本机工作区，请在原共享设备上管理。</p>}
      <RoomAgentPicker options={roster.options} selected={selected} onChange={ids => {
        setSelected(ids)
        setDraft(undefined)
        setError('')
      }} allowSelection={roster.external === 0} disabled={busy || pending.current !== null} />
      <p className="text-xs text-muted-foreground">取消勾选并保存，只会从本群移除智能体；不会删除本机工作区。</p>
      {roomAgentId && <RoomModelPicker key={roomAgentId} roomId={roomId} roomAgentId={roomAgentId} request={request}
        disabled={busy || !!savingRoster} draft={model} onChange={choice => {
          setError('')
          setDraft(choice ? { roomAgentId, model: choice } : undefined)
        }} />}
    </div> : !error && <p role="status">正在读取智能体…</p>}
    {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    <div className="mt-4 flex justify-end gap-2">
      <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>关闭</Button>
      {!roster && error && <Button size="sm" onClick={() => setReload(n => n+1)}>重新加载</Button>}
      {roster && <Button size="sm" aria-label="保存智能体" disabled={busy || !canSave} onClick={() => void save()}>
        {busy ? '正在保存…' : pending.current ? '重试' : '保存'}
      </Button>}
    </div>
  </RoomDialog>
}

export function RosterList({ agents }: { agents: HostAgent[] }) {
  return <div className="text-sm">
    <p className="mb-1 text-muted-foreground">已共享到本群</p>
    {agents.length ? <ul>{agents.map(a => <li className="flex justify-between gap-2 py-1" key={a.id}>
      <span className="truncate">{a.name}</span><span className="shrink-0 text-muted-foreground">{a.state}</span>
    </li>)}</ul> : <p>暂无共享智能体</p>}
  </div>
}
