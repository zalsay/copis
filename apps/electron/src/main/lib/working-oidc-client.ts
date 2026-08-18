import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto'
import { createServer } from 'node:http'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>
export type RandomBytesFactory = (size: number) => Uint8Array

export interface WorkingOAuthTokenSet {
  accessToken: string
  refreshToken?: string
  idToken?: string
  tokenType: string
  expiresIn?: number
  scope?: string
}

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

export interface WorkingAuthorizationCodeExchangeInput {
  tokenEndpoint: string
  clientId: string
  redirectUri: string
  code: string
  codeVerifier: string
  signal?: AbortSignal
  fetchImpl?: FetchLike
}

export interface WorkingRefreshTokenExchangeInput {
  tokenEndpoint: string
  clientId: string
  refreshToken: string
  fetchImpl?: FetchLike
}

export interface WorkingOidcClientOptions {
  issuer: string
  clientId: string
  redirectUri: string
  openExternal: (url: string) => Promise<void>
  fetchImpl?: FetchLike
  randomBytes?: RandomBytesFactory
  timeoutMs?: number
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

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new WorkingOAuthError('OAuth 请求已取消', undefined, 'aborted')
}

function withAbortSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(abortError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      },
    )
  })
}

async function readJsonResponse(response: Response, signal?: AbortSignal): Promise<unknown> {
  const text = await withAbortSignal(Promise.resolve().then(() => response.text()), signal)
  if (!text.trim()) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function responseError(payload: unknown, fallback: string): { message: string; code?: string } {
  if (!isRecord(payload)) return { message: fallback }
  const code = typeof payload.error === 'string' ? payload.error : undefined
  const description = typeof payload.error_description === 'string' ? payload.error_description.trim() : ''
  return {
    message: description && description.length <= 160 ? description : fallback,
    code,
  }
}

export async function createPkcePair(randomBytes: RandomBytesFactory = defaultRandomBytes): Promise<WorkingPkcePair> {
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

export async function exchangeWorkingAuthorizationCode(input: WorkingAuthorizationCodeExchangeInput): Promise<WorkingOAuthTokenSet> {
  const fetchImpl = input.fetchImpl ?? fetch
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code: input.code,
    code_verifier: input.codeVerifier,
  })
  const response = await withAbortSignal(Promise.resolve().then(() => fetchImpl(input.tokenEndpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    signal: input.signal,
  })), input.signal)
  const payload = await readJsonResponse(response, input.signal)
  if (!response.ok) {
    const detail = responseError(payload, `OAuth token 请求失败（HTTP ${response.status}）`)
    throw new WorkingOAuthError(detail.message, response.status, detail.code)
  }
  return normalizeTokenResponse(payload)
}

export async function exchangeWorkingRefreshToken(input: WorkingRefreshTokenExchangeInput): Promise<WorkingOAuthTokenSet> {
  const fetchImpl = input.fetchImpl ?? fetch
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: input.clientId,
    refresh_token: input.refreshToken,
  })
  const response = await fetchImpl(input.tokenEndpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  })
  const payload = await readJsonResponse(response)
  if (!response.ok) {
    const detail = responseError(payload, `OAuth refresh 请求失败（HTTP ${response.status}）`)
    throw new WorkingOAuthError(detail.message, response.status, detail.code)
  }
  return normalizeTokenResponse(payload)
}

function normalizeTokenResponse(value: unknown): WorkingOAuthTokenSet {
  if (!isRecord(value)) throw new WorkingOAuthError('OAuth token 响应格式不正确')
  const accessToken = typeof value.access_token === 'string' ? value.access_token.trim() : ''
  if (!accessToken) throw new WorkingOAuthError('token 响应缺少 access_token', 200, 'invalid_token_response')
  const refreshToken = typeof value.refresh_token === 'string' && value.refresh_token.trim() ? value.refresh_token.trim() : undefined
  const tokenType = typeof value.token_type === 'string' && value.token_type.trim() ? value.token_type : 'Bearer'
  const expiresIn = typeof value.expires_in === 'number' && Number.isFinite(value.expires_in) ? value.expires_in : undefined
  const idToken = typeof value.id_token === 'string' && value.id_token.trim() ? value.id_token : undefined
  const scope = typeof value.scope === 'string' && value.scope.trim() ? value.scope : undefined
  return { accessToken, ...(refreshToken && { refreshToken }), tokenType, ...(expiresIn !== undefined && { expiresIn }), ...(idToken && { idToken }), ...(scope && { scope }) }
}

interface WorkingCallbackServer {
  waitForCallback(): Promise<string>
  close(): Promise<void>
}

function startWorkingCallbackServer(redirectUri: string, expectedState: string, timeoutMs: number): Promise<WorkingCallbackServer> {
  const target = new URL(redirectUri)
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.pathname !== '/oauth/callback') {
    throw new WorkingOAuthError('OAuth 回调地址必须是 127.0.0.1 的 HTTP 回调')
  }
  const port = Number(target.port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new WorkingOAuthError('OAuth 回调端口无效')
  }

  return new Promise((resolve, reject) => {
    let callbackSettled = false
    let serverReady = false
    let timer: NodeJS.Timeout | null = null
    let callbackResolve: (value: string) => void
    let callbackReject: (error: Error) => void
    const callbackPromise = new Promise<string>((resolveCallback, rejectCallback) => {
      callbackResolve = resolveCallback
      callbackReject = rejectCallback
    })
    const server = createServer((request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(404)
        response.end()
        return
      }
      let callbackUrl: string
      try {
        const requestUrl = new URL(request.url ?? '/', redirectUri)
        if (requestUrl.pathname !== target.pathname) {
          response.writeHead(404)
          response.end()
          return
        }
        callbackUrl = requestUrl.toString()
        parseWorkingOAuthCallback(callbackUrl, expectedState)
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end('<!doctype html><html><body>登录成功，请返回 Copis。</body></html>')
        settleCallbackResolve(callbackUrl)
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end('<!doctype html><html><body>登录未完成，请返回 Copis 重试。</body></html>')
      }
    })

    const close = (): Promise<void> => new Promise((closeResolve) => {
      if (!server.listening) {
        closeResolve()
        return
      }
      server.close(() => closeResolve())
    })
    const settleCallbackResolve = (value: string): void => {
      if (callbackSettled) return
      callbackSettled = true
      if (timer) clearTimeout(timer)
      callbackResolve(value)
    }
    const settleCallbackReject = (error: unknown): void => {
      if (callbackSettled) return
      callbackSettled = true
      if (timer) clearTimeout(timer)
      callbackReject(error instanceof Error ? error : new WorkingOAuthError('OAuth 回调失败'))
      void close()
    }
    server.once('error', (error) => {
      const normalized = error instanceof Error ? error : new WorkingOAuthError('OAuth 回调服务器启动失败')
      if (!serverReady) {
        reject(normalized)
        return
      }
      settleCallbackReject(normalized)
    })
    server.listen(port, target.hostname, () => {
      serverReady = true
      timer = setTimeout(() => settleCallbackReject(new WorkingOAuthError('OAuth 登录超时', undefined, 'timeout')), timeoutMs)
      resolve({ waitForCallback: async () => callbackPromise, close })
    })
  })
}

export class WorkingOidcClient {
  private readonly options: WorkingOidcClientOptions

  constructor(options: WorkingOidcClientOptions) {
    this.options = options
  }

  async authorize(): Promise<WorkingOAuthTokenSet> {
    const issuer = normalizeIssuer(this.options.issuer)
    const fetchImpl = this.options.fetchImpl ?? fetch
    const discoveryResponse = await fetchImpl(`${issuer}/.well-known/openid-configuration`, {
      headers: { Accept: 'application/json' },
    })
    const discoveryPayload = await readJsonResponse(discoveryResponse)
    if (!discoveryResponse.ok) {
      const detail = responseError(discoveryPayload, `OIDC discovery 请求失败（HTTP ${discoveryResponse.status}）`)
      throw new WorkingOAuthError(detail.message, discoveryResponse.status, detail.code)
    }
    const discovery = validateWorkingDiscovery(issuer, discoveryPayload)
    const pair = await createPkcePair(this.options.randomBytes)
    const authorizationUrl = buildWorkingAuthorizationUrl({
      authorizationEndpoint: discovery.authorizationEndpoint,
      clientId: this.options.clientId,
      redirectUri: this.options.redirectUri,
      state: pair.state,
      codeChallenge: pair.codeChallenge,
      scope: 'openid profile email offline_access',
    })
    const timeoutMs = this.options.timeoutMs ?? 5 * 60 * 1000
    const callbackServer = await startWorkingCallbackServer(this.options.redirectUri, pair.state, timeoutMs)
    try {
      await this.options.openExternal(authorizationUrl)
      const callbackUrl = await callbackServer.waitForCallback()
      const { code } = parseWorkingOAuthCallback(callbackUrl, pair.state)
      const tokenAbortController = new AbortController()
      const tokenTimeout = setTimeout(() => {
        tokenAbortController.abort(new WorkingOAuthError('OAuth token 请求超时', undefined, 'timeout'))
      }, timeoutMs)
      try {
        return await exchangeWorkingAuthorizationCode({
          tokenEndpoint: discovery.tokenEndpoint,
          clientId: this.options.clientId,
          redirectUri: this.options.redirectUri,
          code,
          codeVerifier: pair.codeVerifier,
          signal: tokenAbortController.signal,
          fetchImpl,
        })
      } finally {
        clearTimeout(tokenTimeout)
      }
    } finally {
      await callbackServer.close()
    }
  }
}
