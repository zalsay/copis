import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  buildWorkingAuthorizationUrl,
  createPkcePair,
  parseWorkingOAuthCallback,
  validateWorkingDiscovery,
} from './working-oidc-client'

describe('Copis OIDC 协议纯函数', () => {
  test('生成 S256 PKCE challenge，并且 state 与 verifier 不相同', async () => {
    let call = 0
    const randomBytes = (size: number): Uint8Array => {
      call += 1
      return Uint8Array.from({ length: size }, (_, index) => index + call)
    }

    const pair = await createPkcePair(randomBytes)
    expect(pair.state).not.toBe(pair.codeVerifier)
    expect(pair.codeChallenge).toBe(createHash('sha256').update(pair.codeVerifier).digest('base64url'))
  })

  test('构造 Authorization Code + PKCE 授权 URL', () => {
    const url = new URL(buildWorkingAuthorizationUrl({
      authorizationEndpoint: 'https://auth.example.test/oauth/authorize',
      clientId: 'copis-desktop',
      redirectUri: 'http://127.0.0.1:43123/oauth/callback',
      state: 'state-1',
      codeChallenge: 'challenge-1',
      scope: 'openid profile email offline_access',
    }))

    expect(url.origin + url.pathname).toBe('https://auth.example.test/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('copis-desktop')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1')
    expect(url.searchParams.get('state')).toBe('state-1')
  })

  test('拒绝不匹配的 discovery issuer 和畸形回调', () => {
    expect(() => validateWorkingDiscovery(
      'https://auth.example.test',
      {
        issuer: 'https://other.example.test',
        authorization_endpoint: 'https://other.example.test/oauth/authorize',
        token_endpoint: 'https://other.example.test/oauth/token',
      },
    )).toThrow('OIDC issuer 不匹配')

    expect(parseWorkingOAuthCallback(
      'http://127.0.0.1:43123/oauth/callback?code=code-1&state=state-1',
      'state-1',
    )).toEqual({ code: 'code-1' })
    expect(() => parseWorkingOAuthCallback(
      'http://127.0.0.1:43123/oauth/callback?code=code-1&state=wrong',
      'state-1',
    )).toThrow('OAuth state 校验失败')
  })
})
