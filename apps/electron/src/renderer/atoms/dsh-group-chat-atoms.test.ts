import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import {
  dshGroupListAtom,
  dshActiveGroupIdAtom,
  dshMessagesMapAtom,
  dshActiveMessagesAtom,
  dshTasksMapAtom,
  dshActiveTaskBoardAtom,
  dshActiveDrawerAtom,
  type DshPendingQuote,
  dshPendingQuoteAtom,
} from './dsh-group-chat-atoms'
import type { DshGroupChatMessage, DshGroupTaskBoard } from '@copis/shared'

describe('dsh-group-chat-atoms', () => {
  it('should manage active messages reactively based on activeGroupId', () => {
    const store = createStore()

    expect(store.get(dshActiveMessagesAtom)).toEqual([])

    const msg: DshGroupChatMessage = {
      id: 'm_1',
      groupId: 'grp_1',
      seq: 1,
      kind: 'user',
      text: '测试消息',
      authorUserId: 'u_1',
      authorName: '张三',
      agentId: null,
      agentName: null,
      mentions: [],
      createdAt: new Date().toISOString(),
    }

    store.set(dshMessagesMapAtom, { grp_1: [msg] })
    expect(store.get(dshActiveMessagesAtom)).toEqual([])

    store.set(dshActiveGroupIdAtom, 'grp_1')
    expect(store.get(dshActiveMessagesAtom)).toEqual([msg])
  })

  it('should derive active task board correctly', () => {
    const store = createStore()
    const board: DshGroupTaskBoard = {
      revision: 3,
      tasks: [
        {
          id: 't_1',
          groupId: 'grp_2',
          number: 1,
          parentId: null,
          title: '看板测试',
          description: '',
          status: 'todo',
          assignee: null,
          revision: 3,
          createdByUserId: null,
          createdByAgentId: null,
          updatedByUserId: null,
          updatedByAgentId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    }

    store.set(dshTasksMapAtom, { grp_2: board })
    store.set(dshActiveGroupIdAtom, 'grp_2')
    expect(store.get(dshActiveTaskBoardAtom)?.revision).toBe(3)
    expect(store.get(dshActiveTaskBoardAtom)?.tasks.length).toBe(1)
  })

  it('should toggle drawers and pending quote state', () => {
    const store = createStore()
    expect(store.get(dshActiveDrawerAtom)).toBe('none')

    store.set(dshActiveDrawerAtom, 'tasks')
    expect(store.get(dshActiveDrawerAtom)).toBe('tasks')

    const quote: DshPendingQuote = {
      messageId: 'm_1',
      authorName: '李四',
      text: '引用内容',
    }
    store.set(dshPendingQuoteAtom, quote)
    expect(store.get(dshPendingQuoteAtom)?.authorName).toBe('李四')
  })
})
