import { describe, expect, test } from 'bun:test'
import { installHttpApiBridge } from './http-api-bridge'

interface TestWindow {
  electronAPI?: Window['electronAPI']
}

describe('浏览器 HTTP API bridge 业务请求重试边界', () => {
  test('业务 POST 收到 503 时只发送一次请求', async () => {
    const runtime = globalThis as typeof globalThis & { window?: TestWindow }
    const previousWindow = runtime.window
    const previousFetch = globalThis.fetch
    let calls = 0

    globalThis.fetch = (async () => {
      calls += 1
      return new Response(JSON.stringify({ error: 'upstream unavailable', code: 'upstream_unavailable' }), { status: 503 })
    }) as unknown as typeof fetch
    runtime.window = {} as unknown as Window & typeof globalThis & TestWindow

    try {
      installHttpApiBridge()
      await expect(runtime.window.electronAPI?.loginWorking({ email: 'user@example.com', password: 'password' }))
        .rejects.toMatchObject({ status: 503, code: 'upstream_unavailable' })
      expect(calls).toBe(1)
    } finally {
      globalThis.fetch = previousFetch
      runtime.window = previousWindow
    }
  })
})
