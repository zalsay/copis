import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto'

export type RandomBytesFactory = (size: number) => Uint8Array

export interface WorkingOidcDiscovery {
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  userInfoEndpoint?: string
  jwksUri?: string
}

export interface WorkingPkcePair {
  state: string
  codeVerifier: string
  codeChallenge: string
}

export interface WorkingAuthorizationUrlInput {
  authorizationEndpoint: string
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
  scope: string
}

export class WorkingOAuthError extends Error {
  readonly status?: number
  readonly code?: string

  constructor(message: string, status?: number, code?: string) {
    super(message)
    this.name = 'WorkingOAuthError'
    this.status = status
    this.code = code
  }
}

function defaultRandomBytes(size: number): Uint8Array {
  return nodeRandomBytes(size)
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url')
}

function normalizeIssuer(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function requireHttpUrl(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WorkingOAuthError(`OIDC discovery 缺少 ${fieldName}`)
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new WorkingOAuthError(`OIDC discovery 的 ${fieldName} 不是有效 URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WorkingOAuthError(`OIDC discovery 的 ${fieldName} 只支持 http 或 https`)
  }
  return parsed.toString().replace(/\/$/, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export async function createPkcePair(
  randomBytes: RandomBytesFactory = defaultRandomBytes,
): Promise<WorkingPkcePair> {
  const state = base64Url(randomBytes(32))
  const codeVerifier = base64Url(randomBytes(32))
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  return { state, codeVerifier, codeChallenge }
}

export function buildWorkingAuthorizationUrl(input: WorkingAuthorizationUrlInput): string {
  const url = new URL(input.authorizationEndpoint)
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', input.scope)
  url.searchParams.set('state', input.state)
  url.searchParams.set('code_challenge', input.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

export function validateWorkingDiscovery(issuer: string, value: unknown): WorkingOidcDiscovery {
  if (!isRecord(value)) throw new WorkingOAuthError('OIDC discovery 响应格式不正确')
  const expectedIssuer = normalizeIssuer(issuer)
  const discoveredIssuer = typeof value.issuer === 'string' ? normalizeIssuer(value.issuer) : ''
  if (!discoveredIssuer || discoveredIssuer !== expectedIssuer) {
    throw new WorkingOAuthError('OIDC issuer 不匹配')
  }
  return {
    issuer: discoveredIssuer,
    authorizationEndpoint: requireHttpUrl(value.authorization_endpoint, 'authorization_endpoint'),
    tokenEndpoint: requireHttpUrl(value.token_endpoint, 'token_endpoint'),
    ...(value.userinfo_endpoint !== undefined && { userInfoEndpoint: requireHttpUrl(value.userinfo_endpoint, 'userinfo_endpoint') }),
    ...(value.jwks_uri !== undefined && { jwksUri: requireHttpUrl(value.jwks_uri, 'jwks_uri') }),
  }
}

export function parseWorkingOAuthCallback(callbackUrl: string, expectedState: string): { code: string } {
  let url: URL
  try {
    url = new URL(callbackUrl)
  } catch {
    throw new WorkingOAuthError('OAuth 回调地址无效')
  }
  if (url.searchParams.get('state') !== expectedState) {
    throw new WorkingOAuthError('OAuth state 校验失败', undefined, 'invalid_state')
  }
  const error = url.searchParams.get('error')
  if (error) {
    const description = url.searchParams.get('error_description')
    throw new WorkingOAuthError(description ? `${error}: ${description}` : error, undefined, error)
  }
  const code = url.searchParams.get('code')?.trim()
  if (!code) throw new WorkingOAuthError('OAuth 回调缺少授权码', undefined, 'missing_code')
  return { code }
}
