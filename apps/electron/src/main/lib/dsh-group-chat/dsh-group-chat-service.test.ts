import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test'
import { rmSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

mock.module('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => tmpdir(),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
  shell: {
    openExternal: async () => undefined,
  },
  BrowserWindow: class {},
}))

import { DshGroupChatStore } from './dsh-group-chat-store'
import { DshGroupChatService } from './dsh-group-chat-service'
import type { DshGroupChatRealtimeEvent } from '@copis/shared'

describe('DshGroupChatService', () => {
  let testDir: string
  let service: DshGroupChatService
  let emittedEvents: DshGroupChatRealtimeEvent[]

  beforeEach(() => {
    testDir = join(tmpdir(), `dsh-group-chat-svc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testDir, { recursive: true })
    const store = new DshGroupChatStore({ baseDir: testDir })
    service = new DshGroupChatService(store)
    emittedEvents = []
    service.addEventListener((event) => {
      emittedEvents.push(event)
    })
  })

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('should list creation workspaces without intersecting with agent mode', () => {
    const workspaces = service.listCreationWorkspaces()
    expect(Array.isArray(workspaces)).toBeTrue()
    expect(workspaces.length).toBeGreaterThan(0)
    expect(workspaces[0]?.id).toBeDefined()
    expect(workspaces[0]?.name).toBeDefined()
  })

  it('should create a group, assign agents, and emit group_updated event', () => {
    const group = service.createGroup({
      name: 'AI 开发团队',
      description: '本地多智能体协作组',
      agents: [
        {
          agentId: 'ws_coder',
          name: '前端工程师',
          responsibility: '编写 Vue/React 组件代码',
          isLeader: false,
        },
      ],
    })

    expect(group.id).toStartWith('grp_')
    expect(group.name).toBe('AI 开发团队')
    expect(group.agents.length).toBe(1)
    expect(group.agents[0]?.name).toBe('前端工程师')
    expect(emittedEvents.some((e) => e.type === 'group_updated' && e.groupId === group.id)).toBeTrue()
  })

  it('should delete a group and emit group_deleted event', () => {
    const group = service.createGroup({ name: '待删除群聊' })
    expect(service.listGroups().some((g) => g.id === group.id)).toBeTrue()

    const success = service.deleteGroup(group.id)
    expect(success).toBeTrue()
    expect(service.listGroups().some((g) => g.id === group.id)).toBeFalse()
    expect(emittedEvents.some((e) => e.type === 'group_deleted' && e.groupId === group.id)).toBeTrue()
  })

  it('should post user message and trigger broadcast', () => {
    const group = service.createGroup({ name: '测试组' })
    const msg = service.postMessage({
      groupId: group.id,
      text: '你好，请帮我分析一下项目进度。',
      mentions: [{ type: 'agent', id: 'ws_coder', name: '前端工程师' }],
    })

    expect(msg.seq).toBe(1)
    expect(msg.text).toContain('分析一下项目进度')
    expect(msg.mentions.length).toBe(1)

    const history = service.getMessages(group.id)
    expect(history.length).toBe(1)
    expect(history[0]?.id).toBe(msg.id)

    expect(emittedEvents.some((e) => e.type === 'message_created' && e.groupId === group.id)).toBeTrue()
  })

  it('should create, update and decompose tasks with atomic revisions', () => {
    const group = service.createGroup({ name: '看板管理组' })

    // 创建单项任务
    const board1 = service.createTask({
      groupId: group.id,
      title: '搭建骨架',
      description: '创建基础 UI',
    })
    expect(board1.tasks.length).toBe(1)
    expect(board1.tasks[0]?.title).toBe('搭建骨架')

    // 更新任务状态
    const taskId = board1.tasks[0]?.id || ''
    const board2 = service.updateTask({
      groupId: group.id,
      taskId,
      status: 'in_progress',
    })
    expect(board2.tasks[0]?.status).toBe('in_progress')

    // 树状原子分解出 2 项子任务
    const board3 = service.decomposeTasks({
      groupId: group.id,
      parentTaskId: taskId,
      tasks: [
        { title: '编写 Header', status: 'todo' },
        { title: '编写 Footer', status: 'todo' },
      ],
    })
    expect(board3.tasks.length).toBe(3)
    expect(board3.tasks.filter((t) => t.parentId === taskId).length).toBe(2)
  })

  it('should dispatch and invoke creation workspace agent via streamFn when mentioned in postMessage', async () => {
    let capturedStreamInput: any = null
    const testService = new DshGroupChatService({
      store: new DshGroupChatStore({ baseDir: testDir }),
      listCreationWorkspaces: () => [
        {
          id: 'ws_coder',
          name: '前端工程师',
          path: '/path/to/coder',
          description: '专注前端研发的创造工作区',
        },
      ],
      streamFn: async (input) => {
        capturedStreamInput = input
        input.onChunk('已经收到需求，正在为您编写前端组件。')
        return '已经收到需求，正在为您编写前端组件。'
      },
    })

    const group = testService.createGroup({
      name: '研发项目组',
      agents: [
        {
          agentId: 'ws_coder',
          name: '前端工程师',
          responsibility: '前端组件编写',
          isLeader: true,
        },
      ],
    })

    testService.postMessage({
      groupId: group.id,
      text: '@前端工程师 请实现登录页面',
      mentions: [{ type: 'agent', id: 'ws_coder', name: '前端工程师' }],
    })

    // 等待异步调用完成
    await new Promise((r) => setTimeout(r, 60))

    expect(capturedStreamInput).not.toBeNull()
    expect(capturedStreamInput.systemPrompt).toContain('前端工程师')
    expect(capturedStreamInput.systemPrompt).toContain('/path/to/coder')
    expect(capturedStreamInput.prompt).toContain('@前端工程师 请实现登录页面')

    const messages = testService.getMessages(group.id)
    expect(messages.length).toBe(2)
    expect(messages[0]?.kind).toBe('user')
    expect(messages[1]?.kind).toBe('agent')
    expect(messages[1]?.agentName).toBe('前端工程师')
    expect(messages[1]?.text).toBe('已经收到需求，正在为您编写前端组件。')
  })

  it('should update agent model and pass model info to streamFn during invocation', async () => {
    let capturedAgent: any = null
    const testService = new DshGroupChatService({
      store: new DshGroupChatStore({ baseDir: testDir }),
      listCreationWorkspaces: () => [
        { id: 'ws_analyst', name: '基金分析师', path: '/path/to/analyst' },
      ],
      streamFn: async (input) => {
        capturedAgent = input.agent
        return '策略报告已生成。'
      },
      getAvailableModels: async () => [
        {
          channelId: 'copis-working-deepseek',
          channelName: 'DeepSeek',
          models: [
            { id: 'deepseek-v4-flash', name: '快速 (v4 Flash)' },
            { id: 'deepseek-v4-pro', name: '专业 (v4 Pro)' },
          ],
        },
      ],
    })

    const group = testService.createGroup({
      name: '投资决策群',
      agents: [
        { agentId: 'ws_analyst', name: '基金分析师', modelId: 'deepseek-v4-flash' },
      ],
    })

    // 1. 获取可用模型
    const available = await testService.getAvailableModels()
    expect(available.length).toBe(1)
    expect(available[0]?.channelId).toBe('copis-working-deepseek')

    // 2. 切换模型为 deepseek-v4-pro
    const updated = testService.updateAgentModel({
      groupId: group.id,
      agentId: 'ws_analyst',
      channelId: 'copis-working-deepseek',
      modelId: 'deepseek-v4-pro',
      modelName: '专业 (v4 Pro)',
    })
    expect(updated?.agents[0]?.modelId).toBe('deepseek-v4-pro')
    expect(updated?.agents[0]?.modelName).toBe('专业 (v4 Pro)')

    // 3. 触发调用，检查 streamFn 接收到的 agent model 配置
    testService.postMessage({
      groupId: group.id,
      text: '@基金分析师 请分析当前半导体ETF',
      mentions: [{ type: 'agent', id: 'ws_analyst', name: '基金分析师' }],
    })

    await new Promise((r) => setTimeout(r, 60))
    expect(capturedAgent).not.toBeNull()
    expect(capturedAgent.modelId).toBe('deepseek-v4-pro')
    expect(capturedAgent.modelName).toBe('专业 (v4 Pro)')
  })

  it('should return available models with fallback guarantee when models are empty', async () => {
    const models = await service.getAvailableModels()
    expect(Array.isArray(models)).toBeTrue()
    expect(models.length).toBeGreaterThan(0)
    expect(models[0]!.models.length).toBeGreaterThan(0)
  })

  it('should use deps.getAvailableModels when provided', async () => {
    const customModels = [
      {
        channelId: 'custom-ch',
        channelName: 'Custom Channel',
        models: [{ id: 'custom-m1', name: 'Custom Model 1' }],
      },
    ]
    const store = new DshGroupChatStore({ baseDir: testDir })
    const customService = new DshGroupChatService(store, {
      getAvailableModels: async () => customModels,
    })
    const models = await customService.getAvailableModels()
    expect(models).toEqual(customModels)
  })
})
