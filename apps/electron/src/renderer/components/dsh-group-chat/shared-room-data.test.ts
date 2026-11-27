import { expect, test } from 'bun:test'
import {
  readSharedRoom,
  readSharedMessage,
  readSharedEvents,
  mergeSharedMessages,
  newShareCode,
} from './shared-room-data'

const wire = {
  roomId: 'room1',
  messageId: 'm1',
  seq: 7,
  senderType: 'user',
  senderUserId: 22,
  content: '你好',
  createdAt: '2026-11-26T08:00:00Z',
}
test('按当前账号显示分享码，不接受其他群的消息', () => {
  const room = {
    roomId: 'room1',
    name: '设计组',
    hostUserId: 11,
    shareCode: 'A2B3',
    shareCodeEnabled: true,
    status: 'active',
  }
  expect(readSharedRoom(room, '11').shareCode).toBe('A2B3')
  expect(readSharedRoom({ ...room, shareCodeEnabled: false }, '11').role).toBe('host')
  expect(readSharedRoom(room, '22').role).toBe('member')
  expect(readSharedRoom({ ...room, hostUserId: null }, '22').role).toBeNull()
  expect(readSharedRoom(room, '22').shareCode).toBeUndefined()
  expect(() => readSharedMessage(wire, 'elsewhere')).toThrow()
  expect(readSharedMessage(wire, 'room1').authorUserId).toBe('22')
  expect(newShareCode()).toMatch(/^[A-Z0-9]{4}$/)
})
test('HTTP 回执和事件补拉只显示一条消息，其他事件推进自己的游标', () => {
  const m = readSharedMessage(wire, 'room1')
  const events = readSharedEvents(
    [
      { roomId: 'room1', seq: 7, eventType: 'message.created', payload: wire },
      { roomId: 'room1', seq: 8, eventType: 'member.removed', payload: { userId: 33 } },
    ],
    'room1',
    6,
  )
  expect(events.cursor).toBe(8)
  expect(mergeSharedMessages([m], events.messages)).toEqual([m])
})

test('设备可用性只采用服务端对本群群主智能体的判定，不把普通在线标志当成可调用', async () => {
  const { readHostAgents } = await import('./shared-room-data')
  const raw = {
    room: { roomId: 'r', hostUserId: 11, roomKind: 'dsh_shared' },
    agents: [
      {
        roomId: 'r',
        roomAgentId: 'a',
        ownerUserId: 11,
        displayName: '资料助手',
        status: 'online',
        availability: 'offline',
      },
      { roomId: 'r', roomAgentId: 'b', ownerUserId: 11, displayName: '审阅', status: 'online' },
      { roomId: 'r', roomAgentId: 'c', ownerUserId: 22, displayName: '别人的', availability: 'online' },
    ],
  }
  expect(readHostAgents(raw, 'r').map((a) => a.state)).toEqual(['离线', '未知'])
  const online = (availability: string, queuedCount?: number) => readHostAgents({ ...raw, agents:[{ ...raw.agents[0], availability, queuedCount }] }, 'r')[0]!
  expect(online('online', 0)).toMatchObject({ state:'空闲', queuedCount:0, callable:true })
  expect(online('busy', 2)).toMatchObject({ state:'思考中', queuedCount:2, callable:true })
  expect(online('offline', 0).callable).toBe(false)
  expect(online('busy', -2)).toMatchObject({ queuedCount:null, callable:false })
  expect(online('online')).toMatchObject({ queuedCount:null, callable:false })
  expect(() => readHostAgents(raw, 'other')).toThrow()
})

test('其他成员发出的附件在历史消息、实时事件中保持同一 ID，不拼接本地路径或下载地址', () => {
  const payload = { ...wire, attachmentIds: ['photo-1', '../bad', 'report_2'] }
  const history = readSharedMessage(payload, 'room1')
  const event = readSharedEvents([{roomId:'room1', seq:7, eventType:'message.created', payload}], 'room1', 6)
  expect(history.attachmentIds).toEqual(['photo-1', 'report_2'])
  expect(event.messages[0]?.attachmentIds).toEqual(history.attachmentIds)
})
