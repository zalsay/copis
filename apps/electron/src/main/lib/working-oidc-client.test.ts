import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { describe, expect, test } from 'bun:test'
import {
  buildWorkingAuthorizationUrl,
  createPkcePair,
  exchangeWorkingAuthorizationCode,
  exchangeWorkingRefreshToken,
  parseWorkingOAuthCallback,
  validateWorkingDiscovery,
  WorkingOidcClient,
} from './working-oidc-client'

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function getAvailablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法读取测试端口')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

describe('Copis OIDC 协议边界', () => {
  test('生成 S256 PKCE challenge，并且 state 与 verifier 不相同', async () => {
    let call = 0
    const randomBytes = (size: number): Uint8Array => {
      call += 1
      return Uint8Array.from({ length: size }, (_, index) => index + call)
    }

    const pair = await createPkcePair(randomBytes)
    const expectedChallenge = createHash('sha256')
      .update(pair.codeVerifier)
      .digest('base64url')

    expect(pair.state).toBeTruthy()
    expect(pair.codeVerifier).toBeTruthy()
    expect(pair.state).not.toBe(pair.codeVerifier)
    expect(pair.codeChallenge).toBe(expectedChallenge)
  })

  test('构造 Authorization Code + PKCE 授权 URL', () => {
    const url = buildWorkingAuthorizationUrl({
      authorizationEndpoint: 'https://auth.example.test/oauth/authorize',
      clientId: 'copis-desktop',
      redirectUri: 'http://127.0.0.1:43123/oauth/callback',
      state: 'state-1',
      codeChallenge: 'challenge-1',
      scope: 'openid profile email offline_access',
    })
    const parsed = new URL(url)

    expect(parsed.origin + parsed.pathname).toBe('https://auth.example.test/oauth/authorize')
    expect(parsed.searchParams.get('client_id')).toBe('copis-desktop')
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:43123/oauth/callback')
    expect(parsed.searchParams.get('response_type')).toBe('code')
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256')
    expect(parsed.searchParams.get('code_challenge')).toBe('challenge-1')
    expect(parsed.searchParams.get('state')).toBe('state-1')
    expect(parsed.searchParams.get('scope')).toBe('openid profile email offline_access')
  })

  test('使用 form-urlencoded 兑换 code，且 public client 不发送 secret', async () => {
    let requestUrl = ''
    let requestInit: RequestInit | undefined
    const result = await exchangeWorkingAuthorizationCode({
      tokenEndpoint: 'https://auth.example.test/oauth/token',
      clientId: 'copis-desktop',
      redirectUri: 'http://127.0.0.1:43123/oauth/callback',
      code: 'authorization-code',
      codeVerifier: 'code-verifier',
      fetchImpl: async (url, init) => {
        requestUrl = url
        requestInit = init
        return jsonResponse({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          id_token: 'id-token',
          token_type: 'Bearer',
          expires_in: 900,
          scope: 'openid profile email offline_access',
        })
      },
    })

    expect(requestUrl).toBe('https://auth.example.test/oauth/token')
    expect(requestInit?.method).toBe('POST')
    expect(new Headers(requestInit?.headers).get('Content-Type')).toBe('application/x-www-form-urlencoded')
    expect(new Headers(requestInit?.headers).get('Authorization')).toBeNull()
    const body = new URLSearchParams(String(requestInit?.body))
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('client_id')).toBe('copis-desktop')
    expect(body.get('redirect_uri')).toBe('http://127.0.0.1:43123/oauth/callback')
    expect(body.get('code')).toBe('authorization-code')
    expect(body.get('code_verifier')).toBe('code-verifier')
    expect(body.get('client_secret')).toBeNull()
    expect(result).toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      idToken: 'id-token',
      tokenType: 'Bearer',
      expiresIn: 900,
      scope: 'openid profile email offline_access',
    })
  })

  test('授权码兑换把 AbortSignal 传给 fetch', async () => {
    const controller = new AbortController()
    let requestSignal: AbortSignal | undefined
    await exchangeWorkingAuthorizationCode({
      tokenEndpoint: 'https://auth.example.test/oauth/token',
      clientId: 'copis-desktop',
      redirectUri: 'http://127.0.0.1:43123/oauth/callback',
      code: 'authorization-code',
      codeVerifier: 'code-verifier',
      signal: controller.signal,
      fetchImpl: async (_url, init) => {
        requestSignal = init?.signal ?? undefined
        return jsonResponse({ access_token: 'access-token' })
      },
    })

    expect(requestSignal).toBe(controller.signal)
  })

  test('refresh token 响应可以省略 refresh_token，但必须保留 access_token', async () => {
    await expect(exchangeWorkingRefreshToken({
      tokenEndpoint: 'https://auth.example.test/oauth/token',
      clientId: 'copis-desktop',
      refreshToken: 'refresh-token',
      fetchImpl: async () => jsonResponse({ access_token: 'next-access-token' }),
    })).resolves.toEqual({
      accessToken: 'next-access-token',
      tokenType: 'Bearer',
    })
  })

  test('拒绝不匹配的 discovery issuer 和缺少 access token 的响应', async () => {
    expect(() => validateWorkingDiscovery(
      'https://auth.example.test',
      { issuer: 'https://other.example.test', authorization_endpoint: 'https://other.example.test/oauth/authorize', token_endpoint: 'https://other.example.test/oauth/token' },
    )).toThrow('OIDC issuer 不匹配')

    await expect(exchangeWorkingAuthorizationCode({
      tokenEndpoint: 'https://auth.example.test/oauth/token',
      clientId: 'copis-desktop',
      redirectUri: 'http://127.0.0.1:43123/oauth/callback',
      code: 'authorization-code',
      codeVerifier: 'code-verifier',
      fetchImpl: async () => jsonResponse({ token_type: 'Bearer' }),
    })).rejects.toThrow('token 响应缺少 access_token')
  })

  test('只接受匹配 state 的成功回调，并把 OAuth error 转换为异常', () => {
    expect(parseWorkingOAuthCallback(
      'http://127.0.0.1:43123/oauth/callback?code=code-1&state=state-1',
      'state-1',
    )).toEqual({ code: 'code-1' })

    expect(() => parseWorkingOAuthCallback(
      'http://127.0.0.1:43123/oauth/callback?code=code-1&state=wrong',
      'state-1',
    )).toThrow('OAuth state 校验失败')
    expect(() => parseWorkingOAuthCallback(
      'http://127.0.0.1:43123/oauth/callback?error=access_denied&state=state-1',
      'state-1',
    )).toThrow('access_denied')
  })

  test('回调端口已占用时快速失败，不让授权流程挂起', async () => {
    const occupiedServer = createServer()
    await new Promise<void>((resolve, reject) => {
      occupiedServer.once('error', reject)
      occupiedServer.listen(0, '127.0.0.1', () => resolve())
    })
    const address = occupiedServer.address()
    if (!address || typeof address === 'string') throw new Error('无法读取测试回调端口')

    const client = new WorkingOidcClient({
      issuer: 'https://auth.example.test',
      clientId: 'copis-desktop',
      redirectUri: `http://127.0.0.1:${address.port}/oauth/callback`,
      openExternal: async () => {},
      fetchImpl: async () => jsonResponse({
        issuer: 'https://auth.example.test',
        authorization_endpoint: 'https://auth.example.test/oauth/authorize',
        token_endpoint: 'https://auth.example.test/oauth/token',
      }),
    })

    const result = await Promise.race([
      client.authorize().then(() => 'resolved' as const, () => 'rejected' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 250)),
    ])
    await new Promise<void>((resolve) => occupiedServer.close(() => resolve()))
    expect(result).toBe('rejected')
  })

  test('畸形回调请求返回 400 后仍允许后续合法回调完成授权', async () => {
    const port = await getAvailablePort()
    const redirectUri = `http://127.0.0.1:${port}/oauth/callback`
    const client = new WorkingOidcClient({
      issuer: 'https://auth.example.test',
      clientId: 'copis-desktop',
      redirectUri,
      openExternal: async (authorizationUrl) => {
        const state = new URL(authorizationUrl).searchParams.get('state')
        const malformedResponse = await fetch(`${redirectUri}?state=wrong`)
        expect(malformedResponse.status).toBe(400)
        const validResponse = await fetch(`${redirectUri}?code=authorization-code&state=${encodeURIComponent(state ?? '')}`)
        expect(validResponse.status).toBe(200)
      },
      fetchImpl: async (url) => url.endsWith('/.well-known/openid-configuration')
        ? jsonResponse({
          issuer: 'https://auth.example.test',
          authorization_endpoint: 'https://auth.example.test/oauth/authorize',
          token_endpoint: 'https://auth.example.test/oauth/token',
        })
        : jsonResponse({ access_token: 'access-token' }),
      timeoutMs: 500,
    })

    await expect(client.authorize()).resolves.toEqual({
      accessToken: 'access-token',
      tokenType: 'Bearer',
    })
  })

  test('token fetch 永不完成时按配置超时拒绝并关闭回调服务器', async () => {
    const port = await getAvailablePort()
    const redirectUri = `http://127.0.0.1:${port}/oauth/callback`
    let requestSignal: AbortSignal | undefined
    const client = new WorkingOidcClient({
      issuer: 'https://auth.example.test',
      clientId: 'copis-desktop',
      redirectUri,
      openExternal: async (authorizationUrl) => {
        const state = new URL(authorizationUrl).searchParams.get('state')
        const response = await fetch(`${redirectUri}?code=authorization-code&state=${encodeURIComponent(state ?? '')}`)
        expect(response.status).toBe(200)
      },
      fetchImpl: async (url, init) => {
        if (url.endsWith('/.well-known/openid-configuration')) {
          return jsonResponse({
            issuer: 'https://auth.example.test',
            authorization_endpoint: 'https://auth.example.test/oauth/authorize',
            token_endpoint: 'https://auth.example.test/oauth/token',
          })
        }
        requestSignal = init?.signal ?? undefined
        return new Promise<Response>(() => {})
      },
      timeoutMs: 40,
    })

    await expect(client.authorize()).rejects.toThrow('OAuth token 请求超时')
    expect(requestSignal?.aborted).toBe(true)

    const probe = createServer()
    await expect(new Promise<void>((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(port, '127.0.0.1', () => resolve())
    })).resolves.toBeUndefined()
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  })
})
