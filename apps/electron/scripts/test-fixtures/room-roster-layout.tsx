import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { DshSharedRoomCommand } from '@copis/shared'
import { RoomDialog } from '../../src/renderer/components/dsh-group-chat/RoomDialog'
import { RoomRosterDialog } from '../../src/renderer/components/dsh-group-chat/RoomRosterDialog'

const current = { channelId: 'c1', modelId: 'm1' }
const writes: DshSharedRoomCommand[] = []
Object.assign(window, { writes })

const request = async (command: DshSharedRoomCommand) => {
  if (command.action === 'agentOptions') return [{ id: 'w', name: '基金与 ETF', roomAgentId: 'a' }]
  if (command.action === 'roomModelOptions') return { current, options: [
    { ...current, name: 'Model' + 'W'.repeat(100) }, { channelId: 'c2', modelId: 'm2', name: '快速模型' },
  ] }
  writes.push(command)
  return command
}
const refreshAgents = async () => [{ id: 'a', name: '基金与 ETF', state: '空闲', queuedCount: 0, callable: true }]
function Fixture() {
  const [compact, setCompact] = useState(false)
  return compact ? <RoomDialog title="紧凑弹窗" onClose={() => {}}>紧凑弹窗</RoomDialog> :
    <RoomRosterDialog roomId="r" roomName="测试群" request={request} refreshAgents={refreshAgents} onClose={() => setCompact(true)} />
}
createRoot(document.getElementById('pane')!).render(<Fixture />)
