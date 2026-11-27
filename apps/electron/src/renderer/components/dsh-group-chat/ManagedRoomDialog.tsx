import React, { useCallback, useEffect, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Button } from '@/components/ui/button'
import { RoomDialog } from './RoomDialog'
import { RoomRosterDialog, RosterList } from './RoomRosterDialog'
import { readHostAgents, type HostAgent, type SharedRoom } from './shared-room-data'
import { roomAccountAtom, roomDirectoryAction, roomDirectoryAtom } from './shared-room-directory'
import type { RoomRequest } from './useSharedRoomFeed'

/** 操作对象来自目录，而非当前会话。只读取该群详情，不订阅第二个消息流。 */
export function ManagedRoomDialog({ refreshAgents }: { refreshAgents?: () => Promise<HostAgent[]> }) {
  const { rooms, management, busy, error } = useAtomValue(roomDirectoryAtom)
  const user = useAtomValue(roomAccountAtom)
  const act = useSetAtom(roomDirectoryAction)
  const room = rooms.find(r => r.id === management?.id)
  const request: RoomRequest = useCallback(command => window.electronAPI.dshGroupChat.sharedRoomCommand(user!, command), [user])
  const id = room?.id
  const readRoster = useCallback(async () => {
    if (!id) throw new Error('群聊不存在')
    return readHostAgents(await request({ action: 'detail', roomId: id }), id)
  }, [request, id])
  if (!room || !management || !user) return null
  const close = () => { void act({ kind: 'close-management' }) }
  if (management.action === 'roster') return room.role === 'host'
    ? <RoomRosterDialog key={room.id} roomId={room.id} roomName={room.name} request={request} refreshAgents={refreshAgents ?? readRoster} onClose={close} />
    : <ReadonlyRoster key={room.id} room={room} readRoster={readRoster} close={close} />
  const dissolve = management.action === 'dissolve'
  return <RoomDialog title={`${dissolve ? '解散' : '退出'}「${room.name}」？`} busy={busy} onClose={close}>
    <p className="text-sm text-muted-foreground">{dissolve ? '所有成员都将无法再使用此群，此操作不可撤销。' : '其他成员不受影响。'}</p>
    {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    <div className="mt-4 flex justify-end gap-2">
      <Button size="sm" variant="outline" autoFocus disabled={busy} onClick={close}>取消</Button>
      <Button size="sm" variant="destructive" disabled={busy} onClick={() => void act({ kind: dissolve ? 'dissolve' : 'leave', id: room.id })}>{dissolve ? '确认解散' : '确认退出'}</Button>
    </div>
  </RoomDialog>
}

function ReadonlyRoster({room, readRoster, close}: {room: SharedRoom; readRoster: () => Promise<HostAgent[]>; close: () => void}) {
  const [agents, setAgents] = useState<HostAgent[]>()
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void readRoster().then(rows => { if (active) setAgents(rows) }).catch(e => { if (active) setError(e instanceof Error ? e.message : '读取名单失败') })
    return () => { active = false }
  }, [readRoster])
  return <RoomDialog size="roster" title={`群智能体 · ${room.name}`} onClose={close}>
    {agents ? <RosterList agents={agents}/> : <p role="status">{error || '正在读取智能体…'}</p>}
    <Button size="sm" className="mt-4" onClick={close}>关闭</Button>
  </RoomDialog>
}
