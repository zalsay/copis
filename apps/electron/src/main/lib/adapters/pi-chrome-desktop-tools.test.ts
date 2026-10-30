import { describe, expect, it } from 'bun:test'
import {
  buildPiChromeDesktopTools,
  PiChromeDesktopToolBridge,
} from './pi-chrome-desktop-tools'

describe('pi-chrome-desktop-tools', () => {
  it('builds all 8 tools with sequential execution mode', () => {
    const tools = buildPiChromeDesktopTools({} as any, {
      sessionId: 'sess-1',
      capability: {
        endpoint: '/api/internal/agent/chrome-desktop-tool',
        token: 'tok-1',
      },
    })

    expect(tools.length).toBe(8)
    const names = tools.map((t) => t.name)
    expect(names).toContain('ChromeDesktopStart')
    expect(names).toContain('ChromeDesktopObserve')
    expect(names).toContain('ChromeDesktopClick')
    expect(names).toContain('ChromeDesktopScroll')
    expect(names).toContain('ChromeDesktopType')
    expect(names).toContain('ChromeDesktopPress')
    expect(names).toContain('ChromeDesktopSelectFile')
    expect(names).toContain('ChromeDesktopStop')

    const descriptions = JSON.stringify(tools.map(tool => tool.description))
    expect(descriptions).not.toContain('消耗该 frameId')
    expect(descriptions).not.toContain('后续操作前必须重新 Observe')
    expect(descriptions).toContain('可重复使用')
    expect(descriptions).toContain('已有控制权时直接复用')
    expect(descriptions).toContain('普通任务完成后不要自动调用')
    const startTool = tools.find(tool => tool.name === 'ChromeDesktopStart')!
    expect(startTool.description).toContain('CHROME_USER_PAUSED')
    expect(startTool.description).toContain('停止自动重试输入')
    expect(descriptions).toContain('当前任务要求在已授权')
    expect(descriptions).not.toContain('仅按用户明确指定')

    for (const tool of tools) {
      expect(tool.description).toContain('MCC（mcc）')
      expect((tool as any).executionMode).toBe('sequential')
    }
  })

  it('sends only controlId and the absolute path for file selection and never reports upload success', async () => {
    const requests: unknown[] = []
    const bridge = new PiChromeDesktopToolBridge({
      sessionId: 'sess-1',
      capability: { endpoint: '/api/internal/agent/chrome-desktop-tool', token: 'tok-1' },
      fetchImpl: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify({ kind: 'json', value: {
          selected: true, dialogClosed: true, uploadConfirmed: false, requiresObserve: true,
        } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    })
    const result = await bridge.execute('ChromeDesktopSelectFile', 'file-call', { controlId: 'control-1', path: '/Users/test/a.pdf' })
    expect(requests).toEqual([{
      sessionId: 'sess-1', capabilityToken: 'tok-1', toolCallId: 'file-call',
      toolName: 'ChromeDesktopSelectFile', toolInput: { controlId: 'control-1', path: '/Users/test/a.pdf' },
    }])
    expect((result.content[0] as { text: string }).text).toContain('uploadConfirmed')
    expect((result.content[0] as { text: string }).text).toContain('requiresObserve')
    expect((result.content[0] as { text: string }).text).not.toContain('上传已完成')
  })

  it('reports USER_PAUSED from Start as a retained user handoff, not an authorization failure', async () => {
    const bridge = new PiChromeDesktopToolBridge({
      sessionId: 'sess-1',
      capability: { endpoint: '/api/internal/agent/chrome-desktop-tool', token: 'tok-1' },
      fetchImpl: async () => new Response(JSON.stringify({ kind: 'json', value: {
        status: 'paused', controlId: 'control-1', error: 'CHROME_USER_PAUSED',
        message: '用户已接管鼠标或点击暂停，请在屏幕上方控制条点击执行后再继续；不要自动重试输入',
      } }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    })
    const result = await bridge.execute('ChromeDesktopStart', 'start-paused', {})
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('CHROME_USER_PAUSED')
    expect(text).toContain('点击执行')
    expect(text).not.toContain('等待用户在界面授权')
  })

  it('transforms image response into Pi SDK content format with untrusted label', async () => {
    const mockFetch = async () => {
      return new Response(
        JSON.stringify({
          kind: 'image',
          frame: {
            controlId: 'cd_123',
            frameId: 'frm_456',
            width: 1200,
            height: 800,
            capturedAt: 1700000000000,
            geometryVersion: 2,
          },
          image: {
            mimeType: 'image/jpeg',
            data: 'test-jpeg-base64',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const bridge = new PiChromeDesktopToolBridge({
      sessionId: 'sess-1',
      capability: {
        endpoint: '/api/internal/agent/chrome-desktop-tool',
        token: 'tok-1',
      },
      fetchImpl: mockFetch as any,
    })

    const res = await bridge.execute('ChromeDesktopObserve', 'call-1', { controlId: 'cd_123' })
    const first = res.content[0]
    const second = res.content[1]
    expect(first?.type).toBe('text')
    expect((first as any)?.text).toContain('untrusted_chrome_frame')
    expect((first as any)?.text).not.toContain('30 秒')
    expect((first as any)?.text).toContain('无固定时间有效期')
    expect((first as any)?.text).toContain('同一 frameId 可重复使用')
    expect((first as any)?.text).not.toContain('未消费')
    expect((first as any)?.text).not.toContain('每帧仅供一次输入')
    expect((first as any)?.text).toContain('CHROME_FRAME_STALE')
    expect((first as any)?.text).toContain('无需重新授权')
    expect((first as any)?.text).toContain('根据实际错误')
    expect((first as any)?.text).not.toContain('应说明模型响应耗时过长')
    expect(second?.type).toBe('image')
    expect((second as any)?.data).toBe('test-jpeg-base64')
    expect(res.details).toBeDefined()
    expect((res.details as any).frameId).toBe('frm_456')
  })
})
