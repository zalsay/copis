import React, { useCallback, useEffect } from 'react'
import { Provider, useAtomValue, useSetAtom, useStore } from 'jotai'
import { SharedRoomForm } from './SharedRoomForm'
import { RoomManagement } from './RoomManagement'
import { ManagedRoomDialog } from './ManagedRoomDialog'
import { DshGroupChatWorkspace } from './DshGroupChatWorkspace'
import { type SharedRoom } from './shared-room-data'
import { useSharedRoomFeed, type RoomRequest } from './useSharedRoomFeed'

import { roomDirectoryAtom, roomDirectoryAction } from './shared-room-directory'

function SharedConversation({
  room,
  userId,
  request,
  managing,
  directoryStore,
  disabled,
}: {
  room: SharedRoom
  userId: string
  request: RoomRequest
  managing: boolean
  directoryStore: ReturnType<typeof useStore>
  disabled: boolean
}) {
  const act = useSetAtom(roomDirectoryAction, { store: directoryStore })
  const feed = useSharedRoomFeed(request, room.id, userId)
  const [agent] = feed.agents
  const single = feed.ready && feed.agents.length === 1 ? agent : undefined
  const summary = !feed.ready ? '正在同步…' : !agent ? '未共享智能体' : `${feed.agents.length} 个历史智能体 · 待群主选定`
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <DshGroupChatWorkspace
        headerAction={<RoomManagement room={room} shareCode={feed.shareCode}
          ready={feed.ready} disabled={disabled} onChoose={action => void act({kind:'manage', id:room.id, action})} />}
        shared={{
          agent: single,
          status: <span role="status" className="flex min-w-0 items-center gap-1.5 text-xs dsh-room-secondary">
            {single ? <>
              <span className="min-w-0 truncate dsh-room-text" title={single.name}>{single.name}</span>
              <span className={single.state === '思考中' ? 'shrink-0 dsh-room-thinking' : 'shrink-0'}>{single.state}</span>
              {single.queuedCount !== null && <span className="shrink-0 tabular-nums">排队 {single.queuedCount}</span>}
            </> : <span className="truncate" title={summary}>{summary}</span>}
            {feed.error && <span className="truncate text-destructive" title={feed.error}>{feed.error}</span>}
          </span>,
          historyAction: feed.hasOlder && <button className="mx-auto block px-2 py-1 text-xs dsh-room-secondary" onClick={() => void feed.older()} disabled={feed.loadingOlder}>更早的消息</button>,
          roomId: room.id,
          name: room.name,
          userId,
          messages: feed.messages.map((m) =>
            m.kind === 'agent'
              ? { ...m, agentName: feed.agents.find((a) => a.id === m.agentId)?.name ?? m.agentName }
              : m,
          ),
          canSend: feed.ready,
          send: feed.send, download: feed.download, retryAttachment: feed.retry,
        }}
      />
      {managing && <Provider store={directoryStore}><ManagedRoomDialog refreshAgents={feed.refreshAgents} /></Provider>}
    </main>
  )
}

export function DshSharedRooms({ userId }: { userId: string | null }) {
  const { rooms, selected, form, management, loading, busy, error } = useAtomValue(roomDirectoryAtom)
  const act = useSetAtom(roomDirectoryAction)
  const directoryStore = useStore()
  const room = rooms.find((r) => r.id === selected)
  const request: RoomRequest = useCallback(
    (command) =>
      userId
        ? window.electronAPI.dshGroupChat.sharedRoomCommand(userId, command)
        : Promise.reject(new Error('请先登录 Copis')),
    [userId],
  )
  useEffect(() => {
    void act({ kind: 'ensure' })
  }, [userId, act])
  if (!userId)
    return <p className="m-auto text-sm dsh-room-secondary">登录 Copis 后即可创建或加入共享群。</p>
  return (
    <>
      {room && (
        <div className="flex min-w-0 flex-1 flex-col">
          {error && !form && !management && <p role="alert" className="px-4 py-2 text-sm text-destructive">{error}</p>}
          <div className="flex min-h-0 flex-1">
            <Provider key={room.id}>
              <SharedConversation
                room={room}
                userId={userId}
                request={request}
                disabled={busy || loading || !!form || !!management}
                managing={management?.id === room.id}
                directoryStore={directoryStore}
              />
            </Provider>
          </div>
        </div>
      )}
      {management && management.id !== selected && <ManagedRoomDialog />}
      {form && <SharedRoomForm key={form} form={form} userId={userId} />}
      {!room && (
          <p role="status" className="m-auto text-sm dsh-room-secondary">
            {loading ? '正在读取共享群…' : (!form && error) || '请在左侧「群聊协作」创建、加入或选择一个群。'}
          </p>
      )}
    </>
  )
}
