import { afterEach, describe, expect, test } from 'bun:test'
import { clearReleaseCache, getLatestRelease } from './github-release-service'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  clearReleaseCache()
})

describe('Copis GitHub Release service', () => {
  test('requests the Copis repository with a Copis user agent', async () => {
    const requests: Array<{ url: string; userAgent: string | null }> = []
    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        userAgent: new Headers(init?.headers).get('User-Agent'),
      })
      return new Response(JSON.stringify({ tag_name: 'v0.1.0', name: 'Copis 0.1.0' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const release = await getLatestRelease()

    expect(release?.tag_name).toBe('v0.1.0')
    expect(requests).toEqual([{
      url: 'https://api.github.com/repos/zalsay/copis/releases/latest',
      userAgent: 'Copis-Desktop-App',
    }])
  })
})
