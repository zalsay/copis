import type {
  WorkingCheckInResult,
  WorkingDiamondPackage,
  WorkingDiamondPurchaseResult,
  WorkingFeedbackInput,
  WorkingFeedbackResult,
  WorkingInvitedUser,
  WorkingLedgerEntry,
  WorkingLoginInput,
  WorkingLoginResult,
  WorkingOrder,
  WorkingOrderPayment,
  WorkingOrdersPage,
  WorkingPasswordResetInput,
  WorkingPasswordResetVerificationResult,
  WorkingPaymentCancelResult,
  WorkingPaymentCheckResult,
  WorkingPaymentIdentifier,
  WorkingPendingDiamondPurchase,
  WorkingRegisterInput,
  WorkingSendVerificationCodeInput,
  WorkingSessionHistory,
  WorkingVerifyPasswordResetCodeInput,
  WorkingReceiveChannel,
  WorkingReceiveChannelSettings,
  WorkingSessionSummary,
  WorkingSettingsSnapshot,
  WorkingSkill,
  WorkingUser,
  WorkingVipStatus,
  WorkingWalletMember,
  WorkingWorkspace,
  WorkingWorkspaceInput,
  WorkingImageGenerationResult,
} from '@copis/shared'
import {
  getWorkingPaymentCheckError,
  isWorkingPaymentCheckFailure,
  isWorkingVipDiamondPackage,
  normalizeWorkingDiamondPackages,
  normalizeWorkingDiamondPurchaseResult,
  normalizeWorkingOrderPayment,
  normalizeWorkingPaymentCancelResult,
  normalizeWorkingPaymentCheckResult,
  normalizeWorkingPendingDiamondPurchase,
  WorkingPaymentNormalizationError,
} from '@copis/shared'
import type { WorkingAuthProvider, WorkingTokenStore } from './working-auth-store'
import { discoverWorkingOidc, exchangeWorkingRefreshToken, WorkingOAuthError, WorkingOidcClient, type WorkingOAuthTokenSet } from './working-oidc-client'
import { DEFAULT_COPIS_BACKEND_URL } from './backend-endpoint-resolver'

export { DEFAULT_COPIS_BACKEND_URL }

const WORKING_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000
const WORKING_REFRESH_RETRY_DELAY_MS = 60 * 1000
export const DEFAULT_COPIS_AUTH_ISSUER = 'https://edu-api.meetlife.com.cn:9001/module/auth'
export const COPIS_AUTH_CLIENT_ID = 'copis-desktop'
export const COPIS_AUTH_REDIRECT_URI = 'http://127.0.0.1:43123/oauth/callback'

export type WorkingOidcClientFactory = (openExternal: (url: string) => Promise<void>) => Pick<WorkingOidcClient, 'authorize'>

export interface WorkingApiClientOptions {
  baseUrl?: string
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>
  tokenStore: WorkingTokenStore
  authIssuer?: string
  authClientId?: string
  authRedirectUri?: string
  oidcClientFactory?: WorkingOidcClientFactory
}

export interface WorkingRustRequest {
  method: string
  path: string
  body?: string
}

export class WorkingApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly payload?: unknown

  constructor(message: string, status: number, code?: string, payload?: unknown) {
    super(message)
    this.name = 'WorkingApiError'
    this.status = status
    this.code = code
    this.payload = payload
  }
}

function resolveBackendUrl(value?: string): string {
  const raw = value?.trim() || process.env.COPIS_BACKEND_URL?.trim() || DEFAULT_COPIS_BACKEND_URL
  const normalized = raw.replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    throw new Error('COPIS_BACKEND_URL 不是有效的 URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('COPIS_BACKEND_URL 只支持 http 或 https')
  }
  return normalized
}

function resolveAuthIssuer(baseUrl: string, configured?: string): string {
  const rawConfigured = configured?.trim() || process.env.COPIS_AUTH_ISSUER?.trim()
  if (rawConfigured) {
    const parsed = new URL(rawConfigured)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('COPIS_AUTH_ISSUER 只支持 http 或 https')
    return rawConfigured.replace(/\/+$/, '')
  }
  if (baseUrl === DEFAULT_COPIS_BACKEND_URL) return DEFAULT_COPIS_AUTH_ISSUER
  const parsed = new URL(baseUrl)
  parsed.pathname = '/module/auth'
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString().replace(/\/+$/, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function unwrapData<T>(payload: unknown): T {
  if (isRecord(payload) && Object.prototype.hasOwnProperty.call(payload, 'data')) {
    return payload.data as T
  }
  return payload as T
}

function errorMessage(payload: unknown, fallback: string): { message: string; code?: string } {
  if (!isRecord(payload)) return { message: fallback }
  const message = typeof payload.error === 'string'
    ? payload.error
    : typeof payload.message === 'string'
      ? payload.message
      : fallback
  const code = typeof payload.code === 'string' ? payload.code : undefined
  return { message, code }
}

function firstDefined(item: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (item[key] !== undefined && item[key] !== null) return item[key]
  }
  return undefined
}

function normalizeIdentifier(value: unknown): number | string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) return value.trim()
  return undefined
}

function normalizeWorkingUser(value: unknown, fallback: Partial<WorkingUser> = {}): WorkingUser | null {
  const item = isRecord(value) ? value : {}
  const id = normalizeIdentifier(firstDefined(item, ['id', 'ID', 'user_id', 'userId'])) ?? fallback.id
  if (id === undefined || id === null || (typeof id === 'string' && !id.trim())) return null

  const user: WorkingUser = { id }
  const userId = normalizeIdentifier(firstDefined(item, ['user_id', 'userId', 'id', 'ID'])) ?? fallback.userId
  if (userId !== undefined) user.userId = userId

  const email = firstDefined(item, ['email', 'Email']) ?? fallback.email
  if (typeof email === 'string' && email.trim()) user.email = email.trim()
  const nickname = firstDefined(item, ['nickname', 'Nickname']) ?? fallback.nickname
  if (typeof nickname === 'string' && nickname.trim()) user.nickname = nickname.trim()

  const accountType = firstDefined(item, ['account_type', 'accountType', 'AccountType']) ?? fallback.accountType ?? fallback.account_type
  if (typeof accountType === 'string' && accountType.trim()) {
    user.accountType = accountType.trim()
    user.account_type = accountType.trim()
  }
  const role = firstDefined(item, ['role', 'Role']) ?? fallback.role
  if (typeof role === 'string' && role.trim()) user.role = role.trim()

  const isAdmin = firstDefined(item, ['is_admin', 'isAdmin', 'IsAdmin']) ?? fallback.isAdmin
  if (typeof isAdmin === 'boolean') user.isAdmin = isAdmin
  const tokens = firstDefined(item, ['tokens', 'Tokens']) ?? fallback.tokens
  if (typeof tokens === 'number' && Number.isFinite(tokens)) user.tokens = tokens
  const isVip = firstDefined(item, ['is_vip', 'isVip', 'IsVIP']) ?? fallback.isVip
  if (typeof isVip === 'boolean') user.isVip = isVip
  const vipExpiresAt = firstDefined(item, ['vip_expires_at', 'vipExpiresAt', 'VIPExpiresAt']) ?? fallback.vipExpiresAt
  if (vipExpiresAt === null || typeof vipExpiresAt === 'string') user.vipExpiresAt = vipExpiresAt
  const mustChangePassword = firstDefined(item, ['must_change_password', 'mustChangePassword', 'MustChangePassword']) ?? fallback.mustChangePassword
  if (typeof mustChangePassword === 'boolean') user.mustChangePassword = mustChangePassword
  const createdAt = firstDefined(item, ['created_at', 'createdAt', 'CreatedAt']) ?? fallback.createdAt
  if (typeof createdAt === 'string') user.createdAt = createdAt
  const updatedAt = firstDefined(item, ['updated_at', 'updatedAt', 'UpdatedAt']) ?? fallback.updatedAt
  if (typeof updatedAt === 'string') user.updatedAt = updatedAt

  return user
}

function getJwtExpiryMs(token: string): number | null {
  const encodedPayload = token.split('.')[1]
  if (!encodedPayload) return null
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as unknown
    if (!isRecord(payload) || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null
    return payload.exp * 1000
  } catch {
    return null
  }
}

function normalizeWorkingLoginResult(value: unknown): WorkingLoginResult {
  const item = isRecord(value) ? value : {}
  const token = firstDefined(item, ['token', 'access_token', 'accessToken'])
  const refreshToken = firstDefined(item, ['refresh_token', 'refreshToken'])
  const userId = normalizeIdentifier(firstDefined(item, ['user_id', 'userId', 'id', 'ID']))
  const isAdmin = firstDefined(item, ['is_admin', 'isAdmin', 'IsAdmin'])
  const accountType = firstDefined(item, ['account_type', 'accountType', 'AccountType'])
  const role = firstDefined(item, ['role', 'Role'])
  const mustChangePassword = firstDefined(item, ['must_change_password', 'mustChangePassword', 'MustChangePassword'])
  const user = normalizeWorkingUser(item.user)
  return {
    token: typeof token === 'string' ? token : '',
    ...(typeof refreshToken === 'string' && refreshToken ? { refreshToken } : {}),
    ...(userId !== undefined ? { userId } : {}),
    ...(typeof isAdmin === 'boolean' ? { isAdmin } : {}),
    ...(typeof accountType === 'string' ? { accountType } : {}),
    ...(typeof role === 'string' ? { role } : {}),
    ...(typeof mustChangePassword === 'boolean' ? { mustChangePassword } : {}),
    ...(user ? { user } : {}),
  }
}

function isAllowedRustWorkingPath(pathname: string): boolean {
  return pathname === '/api/working'
    || pathname.startsWith('/api/working/')
    || pathname.startsWith('/api/pay/')
    || pathname.startsWith('/api/users/orders/')
    || pathname.startsWith('/api/internal/working-desktop/')
    || pathname.startsWith('/api/internal/working-model/')
}

function normalizeWorkspace(value: unknown): WorkingWorkspace {
  const item = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    id: item.id as number | string,
    workspacePath: String(item.workspace_path ?? item.workspacePath ?? ''),
    pcId: String(item.pc_id ?? item.pcId ?? ''),
    workspaceType: item.workspace_type === 'cloud' || item.workspaceType === 'cloud' ? 'cloud' : 'local',
    isDefault: Boolean(item.is_default ?? item.isDefault),
    allowWorkspaceWrite: Boolean(item.allow_workspace_write ?? item.allowWorkspaceWrite),
    updatedAt: typeof (item.updated_at ?? item.updatedAt) === 'string'
      ? String(item.updated_at ?? item.updatedAt)
      : undefined,
  }
}

function normalizeSession(value: unknown): WorkingSessionSummary {
  const item = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    ...item,
    runId: String(item.run_id ?? item.runId ?? ''),
    sessionId: item.session_id == null && item.sessionId == null ? undefined : String(item.session_id ?? item.sessionId),
    title: item.title == null ? undefined : String(item.title),
    status: item.status == null ? undefined : String(item.status),
    finalText: item.final_text == null && item.finalText == null ? undefined : String(item.final_text ?? item.finalText),
    updatedAt: item.updated_at == null && item.updatedAt == null ? undefined : String(item.updated_at ?? item.updatedAt),
  }
}

function normalizeHistory(value: unknown): WorkingSessionHistory {
  const item = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    ...item,
    runId: String(item.run_id ?? item.runId ?? ''),
    sessionId: item.session_id == null && item.sessionId == null ? undefined : String(item.session_id ?? item.sessionId),
    jsonl: item.jsonl == null ? undefined : String(item.jsonl),
  }
}

function normalizeSkill(value: unknown): WorkingSkill {
  const item = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    ...item,
    slug: String(item.slug ?? ''),
    name: String(item.name ?? item.slug ?? ''),
    description: item.description == null ? undefined : String(item.description),
    version: item.version == null ? undefined : String(item.version),
    instructions: item.instructions == null ? undefined : String(item.instructions),
    downloadUrl: item.download_url == null && item.downloadUrl == null ? undefined : String(item.download_url ?? item.downloadUrl),
    sha256: item.sha256 == null ? undefined : String(item.sha256),
    size: typeof item.size === 'number' ? item.size : undefined,
  }
}

function normalizeNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function normalizeVip(value: unknown): WorkingVipStatus | null {
  if (!isRecord(value)) return null
  return {
    isVip: Boolean(value.is_vip ?? value.isVip),
    vipExpiresAt: value.vip_expires_at == null && value.vipExpiresAt == null
      ? undefined
      : String(value.vip_expires_at ?? value.vipExpiresAt),
    tokens: normalizeNumber(value.tokens),
    diamonds: normalizeNumber(value.diamonds ?? value.tokens),
    upgradeAvailable: typeof (value.upgrade_available ?? value.upgradeAvailable) === 'boolean'
      ? Boolean(value.upgrade_available ?? value.upgradeAvailable)
      : undefined,
    upgradeAmount: value.upgrade_amount == null && value.upgradeAmount == null
      ? undefined
      : String(value.upgrade_amount ?? value.upgradeAmount),
    upgradeAmountCents: normalizeNumber(value.upgrade_amount_cents ?? value.upgradeAmountCents),
    upgradeBonusDiamonds: normalizeNumber(value.upgrade_bonus_diamonds ?? value.upgradeBonusDiamonds),
    upgradeDays: normalizeNumber(value.upgrade_days ?? value.upgradeDays, 30),
    quotaBytes: normalizeNumber(value.quota_bytes ?? value.quotaBytes),
    quotaLabel: String(value.quota_label ?? value.quotaLabel ?? '500M'),
  }
}

function normalizeInvitedUser(value: unknown): WorkingInvitedUser {
  const item = isRecord(value) ? value : {}
  return {
    id: normalizeIdentifier(item.id) ?? '',
    email: String(item.email ?? ''),
    nickname: String(item.nickname ?? ''),
    createdAt: item.created_at == null && item.createdAt == null ? undefined : String(item.created_at ?? item.createdAt),
    tokens: normalizeNumber(item.tokens),
  }
}

function normalizeWalletMember(value: unknown): WorkingWalletMember {
  const item = isRecord(value) ? value : {}
  return {
    userId: normalizeIdentifier(item.user_id ?? item.userId) ?? '',
    role: item.role == null ? undefined : String(item.role),
    displayName: item.display_name == null && item.displayName == null ? undefined : String(item.display_name ?? item.displayName),
    email: item.email == null ? undefined : String(item.email),
    tokens: normalizeNumber(item.tokens),
  }
}

function normalizeLedgerEntry(value: unknown): WorkingLedgerEntry {
  const item = isRecord(value) ? value : {}
  return {
    id: normalizeIdentifier(item.id) ?? '',
    payerUserId: normalizeIdentifier(item.payer_user_id ?? item.payerUserId) ?? '',
    beneficiaryUserId: normalizeIdentifier(item.beneficiary_user_id ?? item.beneficiaryUserId),
    amountTokens: normalizeNumber(item.amount_tokens ?? item.amountTokens),
    type: String(item.type ?? ''),
    sourceType: item.source_type == null && item.sourceType == null ? undefined : String(item.source_type ?? item.sourceType),
    modelAlias: item.alias == null && item.model_alias == null && item.modelAlias == null
      ? undefined
      : String(item.alias ?? item.model_alias ?? item.modelAlias),
    memo: item.memo == null ? undefined : String(item.memo),
    deductionMultiplier: normalizeNumber(item.deduction_multiplier ?? item.deductionMultiplier),
    payerBalanceAfter: normalizeNumber(item.payer_balance_after ?? item.payerBalanceAfter),
    payeeBalanceAfter: normalizeNumber(item.payee_balance_after ?? item.payeeBalanceAfter),
    createdAt: item.created_at == null && item.createdAt == null ? undefined : String(item.created_at ?? item.createdAt),
  }
}

function mergeSettingsLedger(familyLedger: WorkingLedgerEntry[], billingLedger: WorkingLedgerEntry[]): WorkingLedgerEntry[] {
  const entries = [
    ...familyLedger
      .filter((entry) => entry.sourceType !== 'alipay_diamond')
      .map((entry) => ({ ...entry, id: `family:${entry.id}` })),
    ...billingLedger.map((entry) => ({ ...entry, id: `billing:${entry.id}` })),
  ]
  return entries.sort((left, right) => ledgerCreatedAt(right) - ledgerCreatedAt(left))
}

function purchaseLedgerFromOrders(orders: WorkingOrder[], payerUserId: number | string): WorkingLedgerEntry[] {
  return orders
    .filter((order) => order.orderType === 'diamond_recharge' && order.status === 'paid' && order.diamonds > 0)
    .map((order) => ({
      id: `order:${order.id}`,
      payerUserId,
      beneficiaryUserId: payerUserId,
      amountTokens: order.diamonds,
      type: 'purchase',
      sourceType: 'alipay_diamond',
      memo: order.outTradeNo ? `支付宝获取钻石 · ${order.outTradeNo}` : '支付宝获取钻石',
      createdAt: order.paidAt ?? order.createdAt,
    }))
    .sort((left, right) => ledgerCreatedAt(right) - ledgerCreatedAt(left))
}

function ledgerCreatedAt(entry: WorkingLedgerEntry): number {
  if (!entry.createdAt) return 0
  const timestamp = Date.parse(entry.createdAt)
  return Number.isNaN(timestamp) ? 0 : timestamp
}

function normalizeReceiveChannel(value: unknown): WorkingReceiveChannelSettings | null {
  if (!isRecord(value)) return null
  const channel = value.channel === 'feishu' ? 'feishu' : 'weixin'
  return {
    channel,
    weixinBound: Boolean(value.weixin_bound ?? value.weixinBound),
    feishuBound: Boolean(value.feishu_bound ?? value.feishuBound),
  }
}

function normalizeOrder(value: unknown): WorkingOrder {
  const item = isRecord(value) ? value : {}
  const orderType = String(item.order_type ?? item.orderType ?? 'diamond_recharge')
  return {
    id: normalizeIdentifier(item.id) ?? '',
    outTradeNo: String(item.out_trade_no ?? item.outTradeNo ?? ''),
    orderType,
    title: String(item.title ?? ''),
    amount: String(item.amount ?? '0'),
    currency: String(item.currency ?? 'CNY'),
    diamonds: normalizeNumber(item.diamonds),
    vipDays: normalizeNumber(item.vip_days ?? item.vipDays),
    method: String(item.method ?? ''),
    status: String(item.status ?? 'failed'),
    createdAt: item.created_at == null && item.createdAt == null ? undefined : String(item.created_at ?? item.createdAt),
    paidAt: item.paid_at == null && item.paidAt == null ? undefined : String(item.paid_at ?? item.paidAt),
  }
}

function paymentErrorFromCheck(value: unknown): WorkingApiError {
  const detail = getWorkingPaymentCheckError(value)
  return new WorkingApiError(detail.message, 200, detail.code ?? 'payment_check_failed')
}

function normalizePaymentResult<T>(normalize: () => T): T {
  try {
    return normalize()
  } catch (error: unknown) {
    if (error instanceof WorkingPaymentNormalizationError) {
      throw new WorkingApiError(error.message, 200, error.code)
    }
    throw error
  }
}

function normalizeWorkingImageGenerationResult(value: unknown): WorkingImageGenerationResult {
  const item = isRecord(value) ? value : {}
  const numberOrUndefined = (keys: readonly string[]): number | undefined => {
    for (const key of keys) {
      const raw = item[key]
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw
    }
    return undefined
  }
  const stringOrUndefined = (keys: readonly string[]): string | undefined => {
    for (const key of keys) {
      const raw = item[key]
      if (typeof raw === 'string' && raw.trim()) return raw
    }
    return undefined
  }
  return {
    imageUrl: stringOrUndefined(['image_url', 'imageUrl']),
    dataUrl: stringOrUndefined(['data_url', 'dataUrl']),
    contentType: stringOrUndefined(['content_type', 'contentType']),
    outputHint: stringOrUndefined(['output_hint', 'outputHint']),
    deductedTokens: numberOrUndefined(['deducted_tokens', 'deductedTokens']),
    balanceAfter: numberOrUndefined(['balance_after', 'balanceAfter']),
  }
}

export class WorkingApiClient {
  readonly baseUrl: string
  readonly authIssuer: string
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>
  private readonly tokenStore: WorkingTokenStore
  private readonly authClientId: string
  private readonly authRedirectUri: string
  private readonly oidcClientFactory?: WorkingOidcClientFactory
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private refreshPromise: Promise<string> | null = null

  constructor(options: WorkingApiClientOptions) {
    this.baseUrl = resolveBackendUrl(options.baseUrl)
    this.authIssuer = resolveAuthIssuer(this.baseUrl, options.authIssuer)
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
    this.tokenStore = options.tokenStore
    this.authClientId = options.authClientId?.trim() || COPIS_AUTH_CLIENT_ID
    this.authRedirectUri = options.authRedirectUri?.trim() || COPIS_AUTH_REDIRECT_URI
    this.oidcClientFactory = options.oidcClientFactory
    this.scheduleAutomaticRefresh()
  }

  getToken(): string | null {
    return this.tokenStore.getToken()
  }

  async getValidToken(): Promise<string | null> {
    const token = this.tokenStore.getToken()
    if (!token) return null

    const expiresAt = getJwtExpiryMs(token)
    const shouldRefresh = expiresAt !== null && expiresAt - Date.now() <= WORKING_TOKEN_REFRESH_BUFFER_MS
    if (!shouldRefresh || !this.tokenStore.getRefreshToken()) return token

    try {
      return await this.refreshAccessToken()
    } catch (error) {
      if (error instanceof WorkingApiError && error.status === 401) {
        this.clearAuth()
        throw error
      }
      // 网络短暂异常时，只要旧 token 尚未过期，继续使用它完成本次请求。
      if (expiresAt > Date.now()) {
        console.warn('[Copis Working] 自动刷新 token 失败，将暂时使用现有 token:', error)
        return token
      }
      throw error
    }
  }

  getCachedUser(): WorkingUser | null {
    const rawUser = this.tokenStore.getUser()
    const user = normalizeWorkingUser(rawUser)
    if (!user) return null

    // 清理旧版本可能把后端 User 原对象（含 Password hash）写入认证文件的情况。
    const hasSensitiveFields = isRecord(rawUser)
      && Object.keys(rawUser).some((key) => /password|secret|credential/i.test(key))
    const token = this.tokenStore.getToken()
    if (token && hasSensitiveFields) this.tokenStore.save(token, user)
    return user
  }

  async requestFromRust(input: WorkingRustRequest): Promise<unknown> {
    const method = input.method.trim().toUpperCase()
    if (!['GET', 'POST', 'DELETE'].includes(method)) {
      throw new WorkingApiError('Rust Working 请求方法不支持', 405, 'method_not_allowed')
    }
    if (!input.path.startsWith('/')) {
      throw new WorkingApiError('Rust Working 请求路径不正确', 400, 'invalid_path')
    }
    let url: URL
    try {
      url = new URL(input.path, 'http://copis-working-bridge.invalid')
    } catch {
      throw new WorkingApiError('Rust Working 请求路径不正确', 400, 'invalid_path')
    }
    if (!isAllowedRustWorkingPath(url.pathname)) {
      throw new WorkingApiError('Rust Working 请求路径不允许', 403, 'path_not_allowed')
    }
    if (method === 'GET' || method === 'DELETE') {
      if (input.body !== undefined && input.body.trim()) {
        throw new WorkingApiError('Rust Working 请求体不允许存在', 400, 'invalid_request_body')
      }
    } else if (input.body !== undefined) {
      try {
        JSON.parse(input.body)
      } catch {
        throw new WorkingApiError('Rust Working 请求体不是有效 JSON', 400, 'invalid_json')
      }
    }
    return this.request<unknown>(input.path, {
      method,
      auth: true,
      unwrap: false,
      ...(input.body !== undefined ? { body: input.body } : {}),
    })
  }

  clearAuth(): void {
    this.stopAutomaticRefresh()
    this.tokenStore.clear()
  }

  private getAuthProvider(): WorkingAuthProvider {
    const persisted = this.tokenStore.getProvider?.()
    if (persisted === 'oidc' || persisted === 'legacy') return persisted
    return 'legacy'
  }

  async login(input: WorkingLoginInput): Promise<WorkingLoginResult> {
    const email = input.email.trim()
    if (!email || !input.password) throw new Error('请输入邮箱和密码')

    const rawResult = await this.request<unknown>('/api/auth/login', {
      method: 'POST',
      auth: false,
      body: JSON.stringify({ email, password: input.password }),
    })
    const result = normalizeWorkingLoginResult(rawResult)
    if (!result || typeof result.token !== 'string' || result.token.length === 0) {
      throw new WorkingApiError('登录响应缺少 token', 200, 'invalid_login_response', rawResult)
    }

    const loginUser = result.user || result.userId !== undefined
      ? normalizeWorkingUser(result.user, {
        id: result.userId,
        email,
        isAdmin: result.isAdmin,
        accountType: result.accountType,
        role: result.role,
        mustChangePassword: result.mustChangePassword,
      })
      : null
    this.tokenStore.save(result.token, loginUser, result.refreshToken ?? null, 'legacy')
    this.scheduleAutomaticRefresh()
    try {
      const currentUser = await this.getCurrentUser()
      const user = normalizeWorkingUser(currentUser, loginUser ?? {}) ?? currentUser
      this.tokenStore.save(result.token, user, undefined, 'legacy')
      this.scheduleAutomaticRefresh()
      return { ...result, user }
    } catch (error) {
      if (error instanceof WorkingApiError && error.status === 401) {
        this.clearAuth()
        throw error
      }
      this.tokenStore.save(result.token, loginUser, undefined, 'legacy')
      this.scheduleAutomaticRefresh()
      return { ...result, ...(loginUser ? { user: loginUser } : {}) }
    }
  }

  async loginWithOAuth(openExternal: (url: string) => Promise<void>): Promise<WorkingLoginResult> {
    const oidcClient = this.oidcClientFactory?.(openExternal) ?? new WorkingOidcClient({
      issuer: this.authIssuer,
      clientId: this.authClientId,
      redirectUri: this.authRedirectUri,
      openExternal,
      fetchImpl: this.fetchImpl,
    })
    const tokens: WorkingOAuthTokenSet = await oidcClient.authorize()
    const result: WorkingLoginResult = {
      token: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    }
    this.tokenStore.save(result.token, null, result.refreshToken, 'oidc')
    this.scheduleAutomaticRefresh()
    try {
      const currentUser = await this.getCurrentUser()
      const user = normalizeWorkingUser(currentUser) ?? currentUser
      this.tokenStore.save(result.token, user, undefined, 'oidc')
      this.scheduleAutomaticRefresh()
      return { ...result, user }
    } catch (error) {
      if (error instanceof WorkingApiError && error.status === 401) {
        this.clearAuth()
        throw error
      }
      this.tokenStore.save(result.token, null, undefined, 'oidc')
      this.scheduleAutomaticRefresh()
      return result
    }
  }

  async refreshAccessToken(): Promise<string> {
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = this.performRefreshAccessToken().finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }

  /** VIP 到账后的 Rust bridge 调用。refresh token 留在 Electron 加密存储，不反向请求正在等待的 Rust 进程。 */
  async refreshAfterVipPayment(): Promise<{ userId: string; isVip: boolean }> {
    const token = await this.performRefreshAccessToken()
    const user = await this.getCurrentUser()
    this.tokenStore.save(token, user)
    this.scheduleAutomaticRefresh()
    return { userId: String(user.id), isVip: user.isVip === true }
  }

  private async performRefreshAccessToken(): Promise<string> {
    const refreshToken = this.tokenStore.getRefreshToken()
    if (!refreshToken) throw new WorkingApiError('登录状态缺少 refresh token', 401, 'missing_refresh_token')

    try {
      let token: string
      let nextRefreshToken: string | null = refreshToken
      if (this.getAuthProvider() === 'oidc') {
        const discovery = await discoverWorkingOidc(this.authIssuer, this.fetchImpl)
        const result = await exchangeWorkingRefreshToken({
          tokenEndpoint: discovery.tokenEndpoint,
          clientId: this.authClientId,
          refreshToken,
          fetchImpl: this.fetchImpl,
        })
        token = result.accessToken
        nextRefreshToken = result.refreshToken ?? refreshToken
      } else {
        const rawResult = await this.request<unknown>('/api/auth/refresh', {
          method: 'POST',
          auth: false,
          body: JSON.stringify({ refresh_token: refreshToken }),
        })
        const result = normalizeWorkingLoginResult(rawResult)
        if (!result.token) {
          throw new WorkingApiError('刷新响应缺少 token', 200, 'invalid_refresh_response', rawResult)
        }
        token = result.token
        nextRefreshToken = result.refreshToken ?? refreshToken
      }
      this.tokenStore.save(token, this.tokenStore.getUser(), nextRefreshToken, this.getAuthProvider())
      this.scheduleAutomaticRefresh()
      return token
    } catch (error) {
      if (error instanceof WorkingApiError && error.status === 401) this.clearAuth()
      if (error instanceof WorkingOAuthError) {
        if (error.status === 400 || error.status === 401 || error.code === 'invalid_grant') this.clearAuth()
        throw new WorkingApiError(error.message, error.status ?? 0, error.code)
      }
      throw error
    }
  }

  async register(input: WorkingRegisterInput): Promise<WorkingUser | null> {
    const email = input.email.trim().toLowerCase()
    if (!email || !input.password) throw new Error('请输入邮箱和密码')
    const data = await this.request<unknown>('/api/auth/register', {
      method: 'POST',
      auth: false,
      body: JSON.stringify({
        email,
        password: input.password,
        nickname: input.nickname?.trim() ?? '',
        invitationCode: input.invitationCode?.trim() ?? '',
        verificationCode: input.verificationCode?.trim() ?? '',
      }),
    })
    return normalizeWorkingUser(data, { email })
  }

  async sendVerificationCode(input: WorkingSendVerificationCodeInput): Promise<void> {
    const email = input.email.trim().toLowerCase()
    if (!email) throw new Error('请输入邮箱地址')
    await this.request('/api/auth/send-code', {
      method: 'POST',
      auth: false,
      body: JSON.stringify({ email, ...(input.purpose ? { purpose: input.purpose } : {}) }),
    })
  }

  async verifyPasswordResetCode(input: WorkingVerifyPasswordResetCodeInput): Promise<WorkingPasswordResetVerificationResult> {
    const data = await this.request<unknown>('/api/auth/verify-code', {
      method: 'POST',
      auth: false,
      body: JSON.stringify({ email: input.email.trim().toLowerCase(), code: input.code.trim(), purpose: 'password_reset' }),
    })
    const item = isRecord(data) ? data : {}
    const resetToken = item.reset_token ?? item.resetToken
    if (typeof resetToken !== 'string' || !resetToken) {
      throw new WorkingApiError('验证码响应缺少重置凭证', 200, 'invalid_reset_response', data)
    }
    return { resetToken }
  }

  async resetPassword(input: WorkingPasswordResetInput): Promise<void> {
    await this.request('/api/auth/password/reset', {
      method: 'POST',
      auth: false,
      body: JSON.stringify({
        email: input.email.trim().toLowerCase(),
        reset_token: input.resetToken,
        password: input.password,
      }),
    })
  }

  logout(): void {
    this.clearAuth()
  }

  async getCurrentUser(): Promise<WorkingUser> {
    const rawUser = await this.request<unknown>('/api/users/me')
    const user = normalizeWorkingUser(rawUser)
    if (!user) {
      throw new WorkingApiError('当前账号响应格式不正确', 200, 'invalid_user_response', rawUser)
    }
    const token = this.tokenStore.getToken()
    if (token) this.tokenStore.save(token, user)
    return user
  }

  async getSettingsSnapshot(): Promise<WorkingSettingsSnapshot> {
    const mePayload = await this.request<unknown>('/api/users/me', { unwrap: false })
    const meItem = isRecord(mePayload) && isRecord(mePayload.data) ? mePayload.data : mePayload
    const user = normalizeWorkingUser(meItem)
    if (!user) {
      throw new WorkingApiError('当前账号响应格式不正确', 200, 'invalid_user_response', mePayload)
    }

    const meEnvelope = isRecord(mePayload) ? mePayload : {}
    const [invitedResult, walletResult, ledgerResult, ordersResult, inviteResult, receiveChannelResult] = await Promise.allSettled([
      this.request<unknown>('/api/users/invited'),
      this.request<unknown>('/api/family/wallet'),
      this.request<unknown>('/api/users/billing-ledger'),
      this.request<unknown>('/api/users/orders?page=1&page_size=50'),
      this.request<unknown>('/api/users/invite-code', { method: 'POST', body: JSON.stringify({}), unwrap: false }),
      this.request<unknown>('/api/working/receive-channel'),
    ])

    const invitedUsers = invitedResult.status === 'fulfilled' && Array.isArray(invitedResult.value)
      ? invitedResult.value.map(normalizeInvitedUser)
      : []
    const wallet = walletResult.status === 'fulfilled' && isRecord(walletResult.value) ? walletResult.value : {}
    const members = Array.isArray(wallet.members) ? wallet.members.map(normalizeWalletMember) : []
    const familyLedger = Array.isArray(wallet.ledger) ? wallet.ledger.map(normalizeLedgerEntry) : []
    const billingLedger = ledgerResult.status === 'fulfilled' && Array.isArray(ledgerResult.value)
      ? ledgerResult.value.map(normalizeLedgerEntry)
      : []
    const ordersPayload = ordersResult.status === 'fulfilled' && isRecord(ordersResult.value) ? ordersResult.value : {}
    const orders = Array.isArray(ordersPayload.items) ? ordersPayload.items.map(normalizeOrder) : []
    const invitePayload = inviteResult.status === 'fulfilled' && isRecord(inviteResult.value) ? inviteResult.value : {}
    const inviteData = isRecord(invitePayload.data) ? invitePayload.data : {}
    const receiveChannel = receiveChannelResult.status === 'fulfilled'
      ? normalizeReceiveChannel(receiveChannelResult.value)
      : null
    const vip = normalizeVip(meEnvelope.vip)
    const token = this.tokenStore.getToken()
    if (token) this.tokenStore.save(token, user)

    return {
      user,
      hasCheckedIn: Boolean(meEnvelope.has_checked_in ?? meEnvelope.hasCheckedIn),
      vip,
      invitedUsers,
      inviteCode: typeof (inviteData.Code ?? inviteData.code) === 'string'
        ? String(inviteData.Code ?? inviteData.code)
        : undefined,
      inviteLink: typeof invitePayload.invite_link === 'string' ? invitePayload.invite_link : undefined,
      members,
      ledger: [
        ...purchaseLedgerFromOrders(orders, user.id),
        ...mergeSettingsLedger(familyLedger, billingLedger),
      ].sort((left, right) => ledgerCreatedAt(right) - ledgerCreatedAt(left)),
      receiveChannel,
    }
  }

  async checkIn(): Promise<WorkingCheckInResult> {
    const data = await this.request<unknown>('/api/users/checkin', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    const item = isRecord(data) ? data : {}
    const tokens = normalizeNumber(item.tokens, NaN)
    const reward = normalizeNumber(item.reward, NaN)
    if (!Number.isFinite(tokens) || !Number.isFinite(reward)) {
      throw new WorkingApiError('签到响应格式不正确', 200, 'invalid_checkin_response', data)
    }
    return { tokens, reward }
  }

  async setReceiveChannel(channel: WorkingReceiveChannel): Promise<WorkingReceiveChannelSettings> {
    const data = await this.request<unknown>('/api/working/receive-channel', {
      method: 'PUT',
      body: JSON.stringify({ channel }),
    })
    const settings = normalizeReceiveChannel(data)
    if (!settings) {
      throw new WorkingApiError('消息接收方式响应格式不正确', 200, 'invalid_receive_channel_response', data)
    }
    return settings
  }

  async listOrders(page = 1, pageSize = 20): Promise<WorkingOrdersPage> {
    const safePage = Math.max(1, Math.floor(page))
    const safePageSize = Math.min(50, Math.max(1, Math.floor(pageSize)))
    const data = await this.request<unknown>(`/api/users/orders?page=${safePage}&page_size=${safePageSize}`)
    const item = isRecord(data) ? data : {}
    const rawPagination = isRecord(item.pagination) ? item.pagination : {}
    return {
      items: Array.isArray(item.items) ? item.items.map(normalizeOrder) : [],
      pagination: {
        page: normalizeNumber(rawPagination.page, safePage),
        pageSize: normalizeNumber(rawPagination.page_size ?? rawPagination.pageSize, safePageSize),
        total: normalizeNumber(rawPagination.total),
        totalPages: normalizeNumber(rawPagination.total_pages ?? rawPagination.totalPages),
      },
    }
  }

  async deleteOrder(orderId: number | string): Promise<void> {
    const value = String(orderId).trim()
    if (!value) throw new Error('订单 ID 不能为空')
    await this.request<unknown>(`/api/users/orders/${encodeURIComponent(value)}`, { method: 'DELETE' })
  }

  async listDiamondPackages(): Promise<WorkingDiamondPackage[]> {
    const data = await this.requestRust<unknown>('/api/working/diamond-packages', { includePayload: false })
    return normalizePaymentResult(() => normalizeWorkingDiamondPackages(data))
  }

  async getPendingDiamondPurchase(): Promise<WorkingPendingDiamondPurchase | null> {
    const data = await this.requestRust<unknown>('/api/working/diamond-purchases/pending', { includePayload: false })
    return normalizePaymentResult(() => normalizeWorkingPendingDiamondPurchase(data))
  }

  async createDiamondPurchase(packageId: number): Promise<WorkingDiamondPurchaseResult> {
    if (!Number.isSafeInteger(packageId) || packageId <= 0) throw new Error('套餐 ID 不正确')
    const data = await this.requestRust<unknown>('/api/working/diamond-purchases', {
      method: 'POST',
      body: JSON.stringify({ packageId }),
      includePayload: false,
    })
    const result = normalizePaymentResult(() => normalizeWorkingDiamondPurchaseResult(data))
    if (result.isVip || isWorkingVipDiamondPackage(result.package)) {
      throw new WorkingApiError('普通钻石套餐响应无效', 200, 'invalid_diamond_package_response')
    }
    return result
  }

  async createVipUpgrade(): Promise<WorkingDiamondPurchaseResult> {
    const data = await this.requestRust<unknown>('/api/working/vip/upgrade', {
      method: 'POST',
      body: JSON.stringify({}),
      includePayload: false,
    })
    const result = normalizePaymentResult(() => normalizeWorkingDiamondPurchaseResult(data))
    if (!result.isVip && !result.vip && !isWorkingVipDiamondPackage(result.package)) {
      throw new WorkingApiError('VIP 支付响应格式不正确', 200, 'invalid_vip_payment_response')
    }
    return result
  }

  async getOrderPayment(orderId: WorkingPaymentIdentifier): Promise<WorkingOrderPayment> {
    const value = String(orderId).trim()
    if (!value) throw new Error('订单 ID 不能为空')
    const data = await this.requestRust<unknown>(`/api/working/orders/${encodeURIComponent(value)}/payment`, { includePayload: false })
    return normalizePaymentResult(() => normalizeWorkingOrderPayment(data))
  }

  async checkPayment(paymentId: WorkingPaymentIdentifier): Promise<WorkingPaymentCheckResult> {
    const value = String(paymentId).trim()
    if (!value) throw new Error('支付会话 ID 不能为空')
    const payload = await this.requestRust<unknown>(`/api/working/diamond-purchases/${encodeURIComponent(value)}/check`, {
      method: 'POST',
      body: JSON.stringify({}),
      unwrap: false,
      includePayload: false,
    })
    if (isWorkingPaymentCheckFailure(payload)) throw paymentErrorFromCheck(payload)
    return normalizePaymentResult(() => normalizeWorkingPaymentCheckResult(payload))
  }

  async cancelDiamondPayment(paymentId: WorkingPaymentIdentifier): Promise<WorkingPaymentCancelResult> {
    const value = String(paymentId).trim()
    if (!value) throw new Error('支付会话 ID 不能为空')
    const data = await this.requestRust<unknown>(`/api/working/diamond-purchases/${encodeURIComponent(value)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
      includePayload: false,
    })
    return normalizePaymentResult(() => normalizeWorkingPaymentCancelResult(data))
  }

  async listWorkspaces(): Promise<WorkingWorkspace[]> {
    const data = await this.request<unknown>('/api/working/workspaces')
    if (!Array.isArray(data)) throw new WorkingApiError('工作区响应格式不正确', 200, 'invalid_workspaces_response', data)
    return data.map(normalizeWorkspace)
  }

  async saveWorkspace(input: WorkingWorkspaceInput): Promise<WorkingWorkspace> {
    const workspacePath = input.workspacePath.trim()
    if (!workspacePath) throw new Error('工作区路径不能为空')
    const data = await this.request<unknown>('/api/working/workspaces', {
      method: 'POST',
      body: JSON.stringify({
        workspace_path: workspacePath,
        pc_id: input.pcId?.trim() ?? '',
        workspace_type: input.workspaceType ?? 'local',
        allow_workspace_write: input.allowWorkspaceWrite ?? false,
      }),
    })
    return normalizeWorkspace(data)
  }

  /** 调用 edu-api /api/working/images/generate 生成图片（Copis 图片生成） */
  async generateWorkingImage(input: { prompt: string; size?: string; runId?: string }): Promise<WorkingImageGenerationResult> {
    const prompt = input.prompt.trim()
    if (!prompt) throw new Error('图片生成提示词不能为空')
    const data = await this.request<unknown>('/api/working/images/generate', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        size: input.size?.trim() ?? '',
        run_id: input.runId?.trim() ?? '',
      }),
    })
    return normalizeWorkingImageGenerationResult(data)
  }

  async listSessions(): Promise<WorkingSessionSummary[]> {
    const data = await this.request<unknown>('/api/working/sessions')
    if (!Array.isArray(data)) throw new WorkingApiError('Working 历史响应格式不正确', 200, 'invalid_sessions_response', data)
    return data.map(normalizeSession)
  }

  async getSessionHistory(runId: string, sessionId?: string): Promise<WorkingSessionHistory> {
    const cleanRunId = runId.trim()
    if (!cleanRunId) throw new Error('runId 不能为空')
    const query = sessionId?.trim() ? `?session_id=${encodeURIComponent(sessionId.trim())}` : ''
    const data = await this.request<unknown>(`/api/working/sessions/${encodeURIComponent(cleanRunId)}/history${query}`)
    return normalizeHistory(data)
  }

  async listSkills(): Promise<WorkingSkill[]> {
    const data = await this.request<unknown>('/api/working/expert-skills/runtime')
    if (!Array.isArray(data)) throw new WorkingApiError('技能响应格式不正确', 200, 'invalid_skills_response', data)
    return data.map(normalizeSkill)
  }

  async createFeedback(input: WorkingFeedbackInput): Promise<WorkingFeedbackResult> {
    const data = await this.request<unknown>('/api/feedback/', {
      method: 'POST',
      body: JSON.stringify({
        page_key: input.pageKey,
        topic_key: input.topicKey ?? '',
        module_hint: input.moduleHint ?? '',
        feedback_type: input.feedbackType,
        severity: input.severity,
        title: input.title.trim(),
        description: input.description.trim(),
        route: input.route,
        browser: input.browser ?? {},
        runtime_context: input.runtimeContext ?? {},
        page_state: input.pageState ?? {},
        client_logs: input.clientLogs ?? [],
        attachments: (input.attachments ?? []).map((attachment) => ({
          type: attachment.type,
          cos_key: attachment.cosKey,
          file_name: attachment.fileName,
          mime_type: attachment.mimeType,
          size_bytes: attachment.sizeBytes,
        })),
      }),
    })
    const item = isRecord(data) ? data : {}
    const id = normalizeIdentifier(item.id)
    if (id === undefined) {
      throw new WorkingApiError('反馈响应格式不正确', 200, 'invalid_feedback_response', data)
    }
    return {
      id,
      status: typeof item.status === 'string' ? item.status : 'submitted',
      message: typeof item.message === 'string' ? item.message : '反馈已提交。',
    }
  }

  private scheduleAutomaticRefresh(retryDelayMs?: number): void {
    this.stopAutomaticRefresh()
    const token = this.tokenStore.getToken()
    if (!token || !this.tokenStore.getRefreshToken()) return

    const expiresAt = getJwtExpiryMs(token)
    if (expiresAt === null) return
    const delay = retryDelayMs ?? Math.max(0, expiresAt - Date.now() - WORKING_TOKEN_REFRESH_BUFFER_MS)
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      void this.refreshAccessToken().catch((error) => {
        if (error instanceof WorkingApiError && error.status === 401) return
        console.warn('[Copis Working] 定时刷新 token 失败，将在稍后重试:', error)
        this.scheduleAutomaticRefresh(WORKING_REFRESH_RETRY_DELAY_MS)
      })
    }, delay)
  }

  private stopAutomaticRefresh(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
  }

  private async request<T>(
    path: string,
    options: RequestInit & { auth?: boolean; unwrap?: boolean; includePayload?: boolean } = {},
    retryOnUnauthorized = true,
  ): Promise<T> {
    const { auth = true, unwrap = true, includePayload = true, ...requestInit } = options
    const headers = new Headers(requestInit.headers)
    headers.set('Accept', 'application/json')
    if (requestInit.body !== undefined) headers.set('Content-Type', 'application/json')
    if (auth) {
      const token = await this.getValidToken()
      if (!token) throw new WorkingApiError('请先登录 Copis Working', 401, 'unauthorized')
      headers.set('Authorization', `Bearer ${token}`)
    }

    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`, {
        ...requestInit,
        headers,
      })
    } catch (error) {
      throw new WorkingApiError(error instanceof Error ? error.message : '无法连接 Working 后端', 0, 'network_error', error)
    }

    const text = await response.text()
    let payload: unknown = null
    if (text.trim()) {
      try {
        payload = JSON.parse(text) as unknown
      } catch {
        payload = text
      }
    }
    if (!response.ok) {
      if (response.status === 401 && auth && retryOnUnauthorized && this.tokenStore.getRefreshToken()) {
        try {
          await this.refreshAccessToken()
          return this.request(path, options, false)
        } catch (error) {
          if (error instanceof WorkingApiError && error.status === 401) this.clearAuth()
          throw error
        }
      }
      if (response.status === 401 && auth) this.clearAuth()
      const detail = errorMessage(payload, `Working 后端请求失败（HTTP ${response.status}）`)
      throw new WorkingApiError(detail.message, response.status, detail.code, includePayload ? payload : undefined)
    }
    return unwrap ? unwrapData<T>(payload) : payload as T
  }

  private async requestRust<T>(
    path: string,
    options: RequestInit & { unwrap?: boolean; includePayload?: boolean } = {},
    retryOnUnauthorized = true,
  ): Promise<T> {
    const { unwrap = true, includePayload = true, ...requestInit } = options
    const token = await this.getValidToken()
    if (!token) throw new WorkingApiError('请先登录 Copis Working', 401, 'unauthorized')

    const baseUrl = await this.resolveRustApiBaseUrl()
    const headers = new Headers(requestInit.headers)
    headers.set('Accept', 'application/json')
    if (requestInit.body !== undefined) headers.set('Content-Type', 'application/json')

    let response: Response
    try {
      response = await this.fetchImpl(`${baseUrl}${path.startsWith('/') ? path : `/${path}`}`, {
        ...requestInit,
        headers,
      })
    } catch (error) {
      throw new WorkingApiError(error instanceof Error ? error.message : '无法连接本地 Rust HTTP API', 0, 'network_error', error)
    }

    const text = await response.text()
    let payload: unknown = null
    if (text.trim()) {
      try {
        payload = JSON.parse(text) as unknown
      } catch {
        payload = text
      }
    }
    if (!response.ok) {
      if (response.status === 401 && retryOnUnauthorized && this.tokenStore.getRefreshToken()) {
        try {
          await this.refreshAccessToken()
          return this.requestRust(path, options, false)
        } catch (error) {
          if (error instanceof WorkingApiError && error.status === 401) this.clearAuth()
          throw error
        }
      }
      if (response.status === 401) this.clearAuth()
      const detail = errorMessage(payload, `Rust HTTP API 请求失败（HTTP ${response.status}）`)
      throw new WorkingApiError(detail.message, response.status, detail.code, includePayload ? payload : undefined)
    }
    return unwrap ? unwrapData<T>(payload) : payload as T
  }

  private async resolveRustApiBaseUrl(): Promise<string> {
    const configured = process.env.COPIS_HTTP_API_BASE_URL?.trim()
    if (configured) return resolveBackendUrl(configured)
    const { HTTP_API_HOST, HTTP_API_PORT } = await import('./http-api-server')
    return `http://${HTTP_API_HOST}:${HTTP_API_PORT}`
  }
}
