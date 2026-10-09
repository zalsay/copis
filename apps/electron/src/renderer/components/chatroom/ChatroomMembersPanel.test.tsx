import { expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ChatRoomAgent, ChatRoomMember } from '@copis/shared'
import { chatRoomLocalRoomsAtom } from '@/atoms/chatroom-atoms'
import { ChatroomMembersPanel } from './ChatroomMembersPanel'

test('服务端 Agent 未就绪与本机配置诊断分别展示，不把在线 presence 当作 ready', () => {
  const store = createStore()
  const agent: ChatRoomAgent = { agentId: 'a1', displayName: 'Agent A', status: 'online', availability: 'preparing', busy: false, memoryShared: false, skillsShared: false }
  const member: ChatRoomMember = { userId: 'u1', displayName: '主理人', role: 'host', presence: 'online' }
  store.set(chatRoomLocalRoomsAtom, new Map([['r1', { roomId: 'r1', updatedAt: 1, agents: [{ roomAgentId: 'a1', displayName: 'Agent A', sourceWorkspaceId: 'w1', channelId: 'c1', contextMessageCount: 50, memorySharingEnabled: false, skillSharingEnabled: false, archived: false, localAvailability: 'configuration_error' }] }]]))
  const html = renderToStaticMarkup(<Provider store={store}><ChatroomMembersPanel roomId="r1" role="host" members={[member]} agents={[agent]} /></Provider>)
  expect(html).toContain('宿主尚未就绪')
  expect(html).toContain('本机状态：配置异常')
  expect(html).not.toContain('@Agent A</span><span class="text-emerald-500">在线')
})
