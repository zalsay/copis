import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DshGroupChatStore } from './dsh-group-chat-store'
import type { DshGroupChatDetail, DshGroupChatTask } from '@copis/shared'

describe('DshGroupChatStore', () => {
  let testDir: string
  let store: DshGroupChatStore

  beforeEach(() => {
    testDir = join(tmpdir(), `dsh-group-chat-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testDir, { recursive: true })
    store = new DshGroupChatStore({ baseDir: testDir })
  })

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('should create and list groups, sorting pinned groups first', () => {
    const group1: DshGroupChatDetail = {
      id: 'grp_1',
      name: '常规群',
      conversationKind: 'group',
      ownerUserId: 'user_1',
      status: 'active',
      role: 'owner',
      lastMessageSeq: 0,
      lastReadSeq: 0,
      taskRevision: 1,
      members: [{ userId: 'user_1', displayName: 'User', role: 'owner', joinedAt: new Date().toISOString() }],
      agents: [],
      createdAt: '2026-10-20T10:00:00.000Z',
      updatedAt: '2026-10-20T10:00:00.000Z',
      isTopPinned: false,
    }

    const group2: DshGroupChatDetail = {
      id: 'grp_2',
      name: '置顶群',
      conversationKind: 'group',
      ownerUserId: 'user_1',
      status: 'active',
      role: 'owner',
      lastMessageSeq: 0,
      lastReadSeq: 0,
      taskRevision: 1,
      members: [{ userId: 'user_1', displayName: 'User', role: 'owner', joinedAt: new Date().toISOString() }],
      agents: [],
      createdAt: '2026-10-20T09:00:00.000Z',
      updatedAt: '2026-10-20T09:00:00.000Z',
      isTopPinned: true,
    }

    store.saveGroup(group1)
    store.saveGroup(group2)

    const list = store.listGroups()
    expect(list.length).toBe(2)
    // 置顶群排在第一位
    expect(list[0]?.id).toBe('grp_2')
    expect(list[0]?.isTopPinned).toBeTrue()
    expect(list[1]?.id).toBe('grp_1')
  })

  it('should append messages with sequential seq and persist to jsonl', () => {
    const group: DshGroupChatDetail = {
      id: 'grp_msg',
      name: '消息测试群',
      conversationKind: 'group',
      ownerUserId: 'user_1',
      status: 'active',
      role: 'owner',
      lastMessageSeq: 0,
      lastReadSeq: 0,
      taskRevision: 1,
      members: [],
      agents: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    store.saveGroup(group)

    const msg1 = store.appendMessage('grp_msg', {
      id: 'm_1',
      groupId: 'grp_msg',
      kind: 'user',
      text: '第一条消息',
      authorUserId: 'user_1',
      authorName: '张三',
      agentId: null,
      agentName: null,
      mentions: [],
      createdAt: new Date().toISOString(),
    })

    const msg2 = store.appendMessage('grp_msg', {
      id: 'm_2',
      groupId: 'grp_msg',
      kind: 'agent',
      text: '第二条回复',
      authorUserId: null,
      authorName: null,
      agentId: 'ag_1',
      agentName: '专家 Agent',
      mentions: [],
      createdAt: new Date().toISOString(),
    })

    expect(msg1.seq).toBe(1)
    expect(msg2.seq).toBe(2)

    const messages = store.getMessages('grp_msg')
    expect(messages.length).toBe(2)
    expect(messages[0]?.text).toBe('第一条消息')
    expect(messages[1]?.text).toBe('第二条回复')

    // 更新后的 group lastMessageSeq 应该是 2
    const updatedGroup = store.getGroup('grp_msg')
    expect(updatedGroup?.lastMessageSeq).toBe(2)
  })

  it('should enforce optimistic locking revision on task board updates', () => {
    const group: DshGroupChatDetail = {
      id: 'grp_tasks',
      name: '看板测试群',
      conversationKind: 'group',
      ownerUserId: 'user_1',
      status: 'active',
      role: 'owner',
      lastMessageSeq: 0,
      lastReadSeq: 0,
      taskRevision: 1,
      members: [],
      agents: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    store.saveGroup(group)

    const initialBoard = store.getTaskBoard('grp_tasks')
    expect(initialBoard.revision).toBe(1)
    expect(initialBoard.tasks.length).toBe(0)

    const task1: DshGroupChatTask = {
      id: 't_1',
      groupId: 'grp_tasks',
      number: 1,
      parentId: null,
      title: '任务 1',
      description: '描述 1',
      status: 'todo',
      assignee: null,
      revision: 1,
      createdByUserId: 'user_1',
      createdByAgentId: null,
      updatedByUserId: null,
      updatedByAgentId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    // 期望版本匹配 (revision=1)
    const update1 = store.saveTaskBoard('grp_tasks', [task1], 1)
    expect(update1.success).toBeTrue()
    expect(update1.board.revision).toBe(2)
    expect(update1.board.tasks.length).toBe(1)

    // 期望版本不匹配 (传入陈旧的 expectedRevision=1，实际当前已是 2)
    const update2 = store.saveTaskBoard('grp_tasks', [task1], 1)
    expect(update2.success).toBeFalse()
    expect(update2.error).toContain('版本冲突')
    expect(update2.board.revision).toBe(2)
  })
})
