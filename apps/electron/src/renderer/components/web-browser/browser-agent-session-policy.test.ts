import { describe, expect, test } from 'bun:test'
import {
  browserAgentUnmountPolicy,
  createAndSwitchBrowserAgentSession,
  resolveBrowserAgentWorkspaceId,
  selectBrowserAgentSession,
} from './browser-agent-session-policy'

describe('AI浏览器会话策略', () => {
  test('Given 持久化会话仍属于当前项目 When WebBrowserSurface 重新挂载 Then 继续选择该会话且卸载不清空 ID', () => {
    const selection = selectBrowserAgentSession({
      persistedSessionId: 'browser-session-1',
      projectId: 'workspace-1',
      availableWorkspaceIds: ['workspace-1'],
      sessions: [{ id: 'browser-session-1', workspaceId: 'workspace-1' }],
    })

    expect(selection).toEqual({ sessionId: 'browser-session-1', shouldCreate: false })
    expect(browserAgentUnmountPolicy).toEqual({
      unbindContext: true,
      preserveSessionId: true,
    })
  })

  test('Given 持久化会话不存在或不属于当前项目 When 选择网页 AI浏览器会话 Then 为当前项目创建新会话', () => {
    expect(selectBrowserAgentSession({
      persistedSessionId: 'deleted-session',
      projectId: 'workspace-1',
      availableWorkspaceIds: ['workspace-1'],
      sessions: [],
    })).toEqual({ sessionId: null, shouldCreate: true })

    expect(selectBrowserAgentSession({
      persistedSessionId: 'other-project-session',
      projectId: 'workspace-1',
      availableWorkspaceIds: ['workspace-1', 'workspace-2'],
      sessions: [{ id: 'other-project-session', workspaceId: 'workspace-2' }],
    })).toEqual({ sessionId: null, shouldCreate: true })

    expect(selectBrowserAgentSession({
      persistedSessionId: 'missing-workspace-session',
      projectId: 'workspace-1',
      availableWorkspaceIds: ['workspace-1'],
      sessions: [{ id: 'missing-workspace-session' }],
    })).toEqual({ sessionId: null, shouldCreate: true })
  })

  test('Given 页面项目关联存在 When 解析当前项目 Then 优先使用有效关联，否则回退现有默认项目', () => {
    const workspaces = [
      { id: 'workspace-default', slug: 'default' },
      { id: 'workspace-current', slug: 'current' },
      { id: 'workspace-associated', slug: 'associated' },
    ]

    expect(resolveBrowserAgentWorkspaceId('workspace-associated', workspaces, 'workspace-current')).toBe('workspace-associated')
    expect(resolveBrowserAgentWorkspaceId('deleted-workspace', workspaces, 'workspace-current')).toBe('workspace-default')
    expect(resolveBrowserAgentWorkspaceId(null, workspaces, 'workspace-current')).toBe('workspace-default')

    expect(resolveBrowserAgentWorkspaceId(null, [
      { id: 'workspace-other', slug: 'other' },
      { id: 'workspace-current', slug: 'current' },
    ], 'workspace-current')).toBe('workspace-current')
  })

  test('Given 当前会话存在 When 点击开启新会话 Then 创建并绑定新会话，再解除旧绑定并切换活动会话', async () => {
    const events: string[] = []
    const result = await createAndSwitchBrowserAgentSession(
      'browser-session-old',
      async () => {
        events.push('create')
        return { id: 'browser-session-new' }
      },
      async (sessionId) => {
        events.push(`bind:${sessionId}`)
      },
      async (sessionId) => {
        events.push(`unbind:${sessionId}`)
      },
    )

    expect(result).toEqual({
      sessionId: 'browser-session-new',
      previousSessionId: 'browser-session-old',
      previousBindingReleased: true,
    })
    expect(events).toEqual(['create', 'bind:browser-session-new', 'unbind:browser-session-old'])
  })

  test('Given 新会话已绑定但旧绑定解除失败 When 完成开启新会话 Then 保留新会话为活动会话并报告旧绑定未解除', async () => {
    const result = await createAndSwitchBrowserAgentSession(
      'browser-session-old',
      async () => ({ id: 'browser-session-new' }),
      async () => undefined,
      async () => {
        throw new Error('旧绑定服务暂时不可用')
      },
    )

    expect(result).toEqual({
      sessionId: 'browser-session-new',
      previousSessionId: 'browser-session-old',
      previousBindingReleased: false,
    })
  })
})
