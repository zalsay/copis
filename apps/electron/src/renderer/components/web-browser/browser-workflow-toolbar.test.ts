import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWorkflowStatus } from '@copis/shared'
import {
  createBrowserAgentBindingQueue,
  getBrowserWorkflowToolbarAction,
  isCurrentBrowserAgentContextRequest,
  shouldFinalizeBrowserAgentUnmount,
  shouldCommitBrowserAgentAction,
  type BrowserAgentContextRequest,
  type BrowserAgentTarget,
} from './browser-workflow-toolbar'

const webBrowserSurfaceSource = readFileSync(join(import.meta.dir, 'WebBrowserSurface.tsx'), 'utf8')

function status(state: BrowserWorkflowStatus['state'], run = false): BrowserWorkflowStatus {
  return {
    sessionId: 'session-1',
    state,
    ...(run ? { run: {
      runId: 'run-1',
      workflowId: 'workflow-1',
      version: 1,
      status: 'running' as const,
      startedAt: 1,
    } } : {}),
  }
}

describe('网页工具栏 Browser Workflow 状态', () => {
  test('Given 已绑定页签被激活 When 恢复网页 Agent 会话 Then 不自动展开面板，显式打开逻辑保持不变', () => {
    const restoreStart = webBrowserSurfaceSource.indexOf('getSessionIdForTab(activeTabId)')
    const restoreEnd = webBrowserSurfaceSource.indexOf('React.useEffect', restoreStart)
    const restoreEffect = webBrowserSurfaceSource.slice(restoreStart, restoreEnd)
    const explicitOpenStart = webBrowserSurfaceSource.indexOf('const handleOpenBrowserAgent')
    const explicitOpenEnd = webBrowserSurfaceSource.indexOf('const handleStartNewBrowserAgentSession', explicitOpenStart)
    const explicitOpenHandler = webBrowserSurfaceSource.slice(explicitOpenStart, explicitOpenEnd)

    expect(restoreEffect).toContain('setBrowserAgentSessionId(sessionId)')
    expect(restoreEffect).not.toContain('setBrowserAgentPanelOpen(true)')
    expect(explicitOpenHandler).toContain('setBrowserAgentPanelOpen(true)')
  })

  test('Given 当前没有录制 When 点击 Copis 按钮 Then 只打开 AI浏览器抽屉', () => {
    expect(getBrowserWorkflowToolbarAction(status('idle'))).toBe('open-agent')
    expect(getBrowserWorkflowToolbarAction(status('error'))).toBe('open-agent')
  })

  test('Given 当前正在录制 When 点击 Copis 按钮 Then 应停止录制', () => {
    expect(getBrowserWorkflowToolbarAction(status('recording'))).toBe('stop-recording')
  })

  test('Given 录制期间 CDP 断开且没有运行中的 Workflow When 点击 Copis 按钮 Then 仍应停止录制', () => {
    expect(getBrowserWorkflowToolbarAction(status('paused_cdp_detached'))).toBe('stop-recording')
  })

  test('Given Workflow 正在总结或运行 When 点击 Copis 按钮 Then 只打开 Agent 面板', () => {
    expect(getBrowserWorkflowToolbarAction(status('awaiting_summary'))).toBe('open-agent')
    expect(getBrowserWorkflowToolbarAction(status('running', true))).toBe('open-agent')
  })

  test('Given 旧的绑定请求回包 When session、tab 或页面地址已变化 Then 不应用旧 status', () => {
    const request: BrowserAgentContextRequest = {
      requestId: 1,
      sessionId: 'session-1',
      tabId: 'tab-1',
      pageUrl: 'https://old.example.test',
    }
    const target: BrowserAgentTarget = { tabId: request.tabId, pageUrl: request.pageUrl }
    expect(isCurrentBrowserAgentContextRequest(request, request, true, target)).toBe(true)
    expect(isCurrentBrowserAgentContextRequest(request, { ...request, requestId: 2 }, true, target)).toBe(false)
    expect(isCurrentBrowserAgentContextRequest(request, { ...request, sessionId: 'session-2' }, true, target)).toBe(false)
    expect(isCurrentBrowserAgentContextRequest(request, { ...request, tabId: 'tab-2' }, true, target)).toBe(false)
    expect(isCurrentBrowserAgentContextRequest(request, { ...request, pageUrl: 'https://new.example.test' }, true, target)).toBe(false)
    expect(isCurrentBrowserAgentContextRequest(request, request, false, target)).toBe(false)
    expect(isCurrentBrowserAgentContextRequest(request, request, true, { ...target, tabId: 'tab-2' })).toBe(false)
    expect(isCurrentBrowserAgentContextRequest(request, request, true, { ...target, pageUrl: 'https://new.example.test' })).toBe(false)
  })

  test('Given ensure session 完成后组件卸载或目标页面变化 Then 不打开抽屉', () => {
    const target: BrowserAgentTarget = { tabId: 'tab-1', pageUrl: 'https://example.test' }
    expect(shouldCommitBrowserAgentAction(1, 1, true, target, target)).toBe(true)
    expect(shouldCommitBrowserAgentAction(1, 2, true, target, target)).toBe(false)
    expect(shouldCommitBrowserAgentAction(1, 1, false, target, target)).toBe(false)
    expect(shouldCommitBrowserAgentAction(1, 1, true, target, { ...target, tabId: 'tab-2' })).toBe(false)
    expect(shouldCommitBrowserAgentAction(1, 1, true, target, { ...target, pageUrl: 'https://new.example.test' })).toBe(false)
  })

  test('Given 稳定页面 When 点击 Copis 图标或抽屉 Play Then 图标只开抽屉且 Play 才开始录制', () => {
    const target: BrowserAgentTarget = { tabId: 'tab-1', pageUrl: 'https://example.test' }

    expect(getBrowserWorkflowToolbarAction(status('idle'))).toBe('open-agent')
    expect(shouldCommitBrowserAgentAction(1, 1, true, target, target)).toBe(true)
  })

  test('Given Play 已开始初始化 When 返回前切页或卸载 Then 不提交旧录制状态', () => {
    const target: BrowserAgentTarget = { tabId: 'tab-1', pageUrl: 'https://example.test' }

    expect(shouldCommitBrowserAgentAction(1, 1, true, target, { ...target, tabId: 'tab-2' })).toBe(false)
    expect(shouldCommitBrowserAgentAction(1, 1, false, target, target)).toBe(false)
  })

  test('Given StrictMode cleanup 已被下一次 setup 取代 When 延迟清理执行 Then 不解除绑定或关闭抽屉', () => {
    expect(shouldFinalizeBrowserAgentUnmount(1, 2, true)).toBe(false)
    expect(shouldFinalizeBrowserAgentUnmount(2, 2, false)).toBe(true)
  })

  test('Given A 绑定后 B 新绑定已排队 When A 的打开请求失效 Then 不解除 B 的新绑定', async () => {
    let releaseFirstBind: (() => void) | undefined
    const firstBindBlocked = new Promise<void>((resolve) => {
      releaseFirstBind = resolve
    })
    const events: string[] = []
    const queue = createBrowserAgentBindingQueue({
      bindContext: async (_sessionId, tabId) => {
        events.push(`bind:${tabId}:start`)
        if (tabId === 'tab-a') await firstBindBlocked
        events.push(`bind:${tabId}:end`)
        return status('idle')
      },
      unbindContext: async () => {
        events.push('unbind')
      },
    })

    const bindingA = queue.bind('session-1', 'tab-a')
    const bindingB = queue.bind('session-1', 'tab-b')
    releaseFirstBind?.()
    const resultA = await bindingA

    expect(await queue.unbindIfCurrent(resultA)).toBe(false)
    await bindingB
    expect(events).toEqual([
      'bind:tab-a:start',
      'bind:tab-a:end',
      'bind:tab-b:start',
      'bind:tab-b:end',
    ])
  })

  test('Given 新绑定属于另一个 session When 旧 session 请求失效 Then 仍解除旧 session 绑定', async () => {
    const unboundSessions: string[] = []
    const queue = createBrowserAgentBindingQueue({
      bindContext: async () => status('idle'),
      unbindContext: async (sessionId) => {
        unboundSessions.push(sessionId)
      },
    })

    const oldBinding = await queue.bind('session-old', 'tab-a')
    await queue.bind('session-new', 'tab-b')

    expect(await queue.unbindIfCurrent(oldBinding)).toBe(true)
    expect(unboundSessions).toEqual(['session-old'])
  })

  test('Given 真正卸载时仍有 bind 未完成 When bind 晚到 Then 最终 unbind 排在 bind 后执行', async () => {
    let releaseBind: (() => void) | undefined
    const bindBlocked = new Promise<void>((resolve) => {
      releaseBind = resolve
    })
    const events: string[] = []
    const queue = createBrowserAgentBindingQueue({
      bindContext: async () => {
        events.push('bind:start')
        await bindBlocked
        events.push('bind:end')
        return status('idle')
      },
      unbindContext: async () => {
        events.push('unbind')
      },
    })

    const binding = queue.bind('session-1', 'tab-a')
    const unbinding = queue.unbindAfterPending('session-1')
    await Promise.resolve()
    expect(events).toEqual(['bind:start'])

    releaseBind?.()
    await Promise.all([binding, unbinding])
    expect(events).toEqual(['bind:start', 'bind:end', 'unbind'])
  })

  test('Given 最终 unbind 已完成 When 旧 binding 再请求清理 Then 不重复 unbind', async () => {
    let unbindCount = 0
    const queue = createBrowserAgentBindingQueue({
      bindContext: async () => status('idle'),
      unbindContext: async () => {
        unbindCount += 1
      },
    })

    const binding = await queue.bind('session-1', 'tab-a')
    await queue.unbindAfterPending('session-1')

    expect(await queue.unbindIfCurrent(binding)).toBe(false)
    expect(unbindCount).toBe(1)
  })

  test('Given 录制初始化已排队 When 页面真正卸载 Then unbind 必须等待录制初始化完成', async () => {
    let releaseRecording: (() => void) | undefined
    let markRecordingStarted: (() => void) | undefined
    const recordingBlocked = new Promise<void>((resolve) => {
      releaseRecording = resolve
    })
    const recordingStarted = new Promise<void>((resolve) => {
      markRecordingStarted = resolve
    })
    const events: string[] = []
    const queue = createBrowserAgentBindingQueue({
      bindContext: async () => {
        events.push('bind')
        return status('idle')
      },
      unbindContext: async () => {
        events.push('unbind')
      },
    })
    const startRecording = async (): Promise<BrowserWorkflowStatus> => {
      events.push('recording:start')
      markRecordingStarted?.()
      await recordingBlocked
      events.push('recording:end')
      return status('recording')
    }

    const binding = queue.bind('session-1', 'tab-a')
    const recording = queue.runAfterPending(startRecording)
    const unbinding = queue.unbindAfterPending('session-1')
    await recordingStarted

    expect(events).toEqual(['bind', 'recording:start'])
    releaseRecording?.()
    await Promise.all([binding, recording, unbinding])
    expect(events).toEqual(['bind', 'recording:start', 'recording:end', 'unbind'])
  })
})
