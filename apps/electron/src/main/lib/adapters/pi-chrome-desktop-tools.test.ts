import { describe, expect, it } from 'bun:test'
import {
  buildPiChromeDesktopTools,
  PiChromeDesktopToolBridge,
} from './pi-chrome-desktop-tools'

describe('pi-chrome-desktop-tools', () => {
  it('builds all 7 tools with sequential execution mode', () => {
    const tools = buildPiChromeDesktopTools({} as any, {
      sessionId: 'sess-1',
      capability: {
        endpoint: '/api/internal/agent/chrome-desktop-tool',
        token: 'tok-1',
      },
    })

    expect(tools.length).toBe(7)
    const names = tools.map((t) => t.name)
    expect(names).toContain('ChromeDesktopStart')
    expect(names).toContain('ChromeDesktopObserve')
    expect(names).toContain('ChromeDesktopClick')
    expect(names).toContain('ChromeDesktopScroll')
    expect(names).toContain('ChromeDesktopType')
    expect(names).toContain('ChromeDesktopPress')
    expect(names).toContain('ChromeDesktopStop')

    for (const tool of tools) {
      expect((tool as any).executionMode).toBe('sequential')
    }
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
    expect((first as any)?.text).toContain('30 秒')
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
