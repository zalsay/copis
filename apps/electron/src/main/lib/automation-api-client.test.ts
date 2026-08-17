import { describe, expect, test } from 'bun:test'
import type { Automation } from '@copis/shared'
import { createAutomationApiClient } from './automation-api-client'

describe('AutomationApiClient', () => {
  test('Given Rust 尚未就绪 When 首次拉取列表 Then 网络错误后自动重试到服务可用', async () => {
    const previousFetch = globalThis.fetch
    let attempts = 0
    const automation: Automation = {
      id: 'automation-1',
      name: '测试任务',
      prompt: '执行一次测试',
      active: false,
      scheduleType: 'interval',
      intervalMinutes: 60,
      channelId: 'channel-1',
      createdAt: 1,
      updatedAt: 1,
      nextRunAt: 1,
      runHistory: [],
    }
    globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) => {
      attempts += 1
      if (attempts === 1) throw new Error('fetch failed')
      return Response.json([automation])
    }) as typeof fetch

    try {
      const client = createAutomationApiClient('http://127.0.0.1:51740', { retryCount: 1, retryDelayMs: 0 })
      await expect(client.list()).resolves.toEqual([automation])
      expect(attempts).toBe(2)
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  test('Given an immediate run request When calling Rust Then it posts to the Rust task-run endpoint', async () => {
    const previousFetch = globalThis.fetch
    const requests: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = (async (url, init) => {
      requests.push({ url: String(url), init })
      return Response.json({ started: true })
    }) as typeof fetch

    try {
      const client = createAutomationApiClient('http://127.0.0.1:51740')
      await expect(client.runNow('automation-1')).resolves.toBe(true)
      expect(requests).toEqual([{
        url: 'http://127.0.0.1:51740/api/automations/automation-1/run',
        init: {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: '{}',
        },
      }])
    } finally {
      globalThis.fetch = previousFetch
    }
  })
})
