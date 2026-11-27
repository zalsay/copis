import React from 'react'
import { useAtomValue } from 'jotai'
import { workingAuthLifecycleEpochAtom } from '@/atoms/working-atoms'
import { roomAccountAtom } from './shared-room-directory'
import './shared-room-theme.css'
import { DshSharedRooms } from './DshSharedRooms'

/** 群聊协作只进入共享群；账号变更时重建房间列表与消息状态。 */
export function DshGroupChatView(): React.ReactElement {
  const account = useAtomValue(roomAccountAtom)
  const epoch = useAtomValue(workingAuthLifecycleEpochAtom)
  return (
    <div className="flex h-full w-full overflow-hidden dsh-room-pane [anchor-name:--copis-room-pane]">
      <DshSharedRooms key={epoch} userId={account} />
    </div>
  )
}
