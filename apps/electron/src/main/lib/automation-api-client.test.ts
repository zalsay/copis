import { describe, expect, test } from 'bun:test'
import { createAutomationApiClient } from './automation-api-client'

describe('AutomationApiClient', () => {
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
