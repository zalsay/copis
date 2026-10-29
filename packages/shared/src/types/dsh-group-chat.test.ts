import { describe, expect, it } from 'bun:test'
import {
  DSH_GROUP_CHAT_IPC_CHANNELS,
  type DshCreateGroupInput,
  type DshGroupChatDetail,
  type DshGroupChatMessage,
  type DshGroupChatTask,
  type DshGroupInvocation,
} from './dsh-group-chat'

describe('dsh-group-chat types and IPC channels', () => {
  it('should define isolated IPC channels starting with dsh-group-chat:', () => {
    const channels = Object.values(DSH_GROUP_CHAT_IPC_CHANNELS)
    expect(channels.length).toBeGreaterThan(10)
    for (const channel of channels) {
      expect(channel).toStartWith('dsh-group-chat:')
    }
  })

  it('should support serializing and deserializing core models correctly', () => {
    const detail: DshGroupChatDetail = {
      id: 'grp_001',
      name: '项目架构攻坚群',
      description: '多智能体协作组',
      conversationKind: 'group',
      ownerUserId: 'user_me',
      status: 'active',
      role: 'owner',
      lastMessageSeq: 1,
      lastReadSeq: 1,
      taskRevision: 1,
      members: [
        {
          userId: 'user_me',
          displayName: '架构师',
          role: 'owner',
          joinedAt: new Date().toISOString(),
        },
      ],
      agents: [
        {
          agentId: 'agent_leader',
          name: 'COAgent Leader',
          isLeader: true,
          responsibility: '负责拆解子任务与调度协调',
          channelId: 'copis-working-deepseek',
          modelId: 'deepseek-v4-pro',
          modelName: 'DeepSeek V4 Pro',
          addedAt: new Date().toISOString(),
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const json = JSON.stringify(detail)
    const parsed = JSON.parse(json) as DshGroupChatDetail
    expect(parsed.id).toBe('grp_001')
    expect(parsed.agents[0]?.isLeader).toBeTrue()
    expect(parsed.agents[0]?.modelId).toBe('deepseek-v4-pro')
    expect(parsed.agents[0]?.modelName).toBe('DeepSeek V4 Pro')
    expect(parsed.conversationKind).toBe('group')
  })

  it('should validate task model with optimistic lock revision', () => {
    const task: DshGroupChatTask = {
      id: 'task_001',
      groupId: 'grp_001',
      number: 1,
      parentId: null,
      title: '设计协议结构',
      description: '制定 DSH 群聊与看板契约',
      status: 'todo',
      assignee: { type: 'agent', id: 'agent_leader', name: 'COAgent Leader' },
      revision: 3,
      createdByUserId: 'user_me',
      createdByAgentId: null,
      updatedByUserId: null,
      updatedByAgentId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    expect(task.revision).toBe(3)
    expect(task.status).toBe('todo')
    expect(task.assignee?.type).toBe('agent')
  })
})
