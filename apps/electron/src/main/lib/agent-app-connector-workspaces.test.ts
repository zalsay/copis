import { describe, expect, test } from 'bun:test'
import { isAppConnectorSession } from '@copis/shared'
import { buildSystemPrompt } from './agent-prompt-builder'

describe('App 连接器全工作区调用权限 (BDD)', () => {
  const workspaces = [
    {
      id: 'ws-app-1',
      name: '前端应用',
      slug: 'frontend-app',
      projectRootPath: '/workspace/frontend-app',
      allowWorkspaceWrite: true,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'ws-app-2',
      name: '后端服务',
      slug: 'backend-service',
      projectRootPath: '/workspace/backend-service',
      allowWorkspaceWrite: true,
      createdAt: 2,
      updatedAt: 2,
    },
    {
      id: 'ws-app-3',
      name: '文档中心',
      slug: 'doc-center',
      allowWorkspaceWrite: true,
      createdAt: 3,
      updatedAt: 3,
    },
  ]

  test('Given 飞书专属会话 When 判断会话特征 Then 识别为 App 连接器会话', () => {
    const session = {
      id: 'session-feishu',
      source: 'feishu' as const,
      feishuDedicated: true,
    }
    expect(isAppConnectorSession(session)).toBe(true)
    expect(isAppConnectorSession(session, 'feishu')).toBe(true)
  })

  test('Given 微信 iLink Bot 专属会话 When 判断会话特征 Then 识别为 App 连接器会话', () => {
    const session = {
      id: 'session-wechat',
      source: 'wechat' as const,
      wechatDedicated: true,
    }
    expect(isAppConnectorSession(session)).toBe(true)
    expect(isAppConnectorSession(session, 'wechat')).toBe(true)
    expect(isAppConnectorSession(null, 'wechat')).toBe(true)
  })

  test('Given 钉钉 Stream 会话 When 判断会话特征 Then 识别为 App 连接器会话', () => {
    const session = {
      id: 'session-dingtalk',
      source: 'dingtalk' as const,
      dingtalkDedicated: true,
    }
    expect(isAppConnectorSession(session)).toBe(true)
    expect(isAppConnectorSession(session, 'dingtalk')).toBe(true)
    expect(isAppConnectorSession(null, 'dingtalk')).toBe(true)
  })

  test('Given App 连接器会话 When 构建系统提示词 Then 注入包含所有工作区的索引表及跨项目调度指引', () => {
    const prompt = buildSystemPrompt({
      agentRuntime: 'pi',
      workspaceName: '前端应用',
      workspaceSlug: 'frontend-app',
      sessionId: 'session-feishu-100',
      agentCwd: '/workspace/frontend-app',
      permissionMode: 'bypassPermissions',
      allWorkspacesAccess: true,
      allWorkspaces: workspaces,
    })

    // 提示词标题与中枢说明
    expect(prompt).toContain('## App 连接器全工作区调用权限 (All Workspaces Access)')
    expect(prompt).toContain('当前会话由 **App 连接器（飞书 / 微信 / 钉钉）** 接入')
    expect(prompt).toContain('调用本机所有工作区的最高权限')

    // 工作区表格包含所有工作区
    expect(prompt).toContain('**前端应用**')
    expect(prompt).toContain('`frontend-app`')
    expect(prompt).toContain('**后端服务**')
    expect(prompt).toContain('`backend-service`')
    expect(prompt).toContain('**文档中心**')
    expect(prompt).toContain('`doc-center`')

    // 跨项目操作规范
    expect(prompt).toContain('1. **全工作区读写权限**')
    expect(prompt).toContain('2. **跨项目命令执行**')
    expect(prompt).toContain('3. **跨工作区技能与工具**')
    expect(prompt).toContain('4. **任务与日程归属**')
    expect(prompt).toContain('5. **智能项目定位**')
  })

  test('Given 普通桌面会话 When 构建系统提示词 Then 仅保留当前工作区上下文，不注入多工作区调度表', () => {
    const prompt = buildSystemPrompt({
      agentRuntime: 'pi',
      workspaceName: '前端应用',
      workspaceSlug: 'frontend-app',
      sessionId: 'session-desktop-1',
      agentCwd: '/workspace/frontend-app',
      permissionMode: 'bypassPermissions',
      allWorkspacesAccess: false,
    })

    expect(prompt).not.toContain('## App 连接器全工作区调用权限 (All Workspaces Access)')
    expect(prompt).not.toContain('调用本机所有工作区的最高权限')
  })
})
