/**
 * Copis Working 客户端与 ai-education 后端之间的业务契约。
 *
 * 这里仅描述账号、工作区、历史和技能数据；本地 Agent 运行仍由
 * Electron main process 直接调用 Pi SDK，不通过 Working 远程 run API。
 */

import type { Channel } from './channel'

export interface WorkingUser {
  id: number | string
  userId?: number | string
  email?: string
  nickname?: string
  isAdmin?: boolean
  account_type?: string
  accountType?: string
  role?: string
  tokens?: number
  isVip?: boolean
  vipExpiresAt?: string | null
  mustChangePassword?: boolean
  createdAt?: string
  updatedAt?: string
  [key: string]: unknown
}

export interface WorkingLoginInput {
  email: string
  password: string
}

export interface WorkingRegisterInput {
  email: string
  password: string
  nickname?: string
  invitationCode?: string
  verificationCode?: string
}

export interface WorkingSendVerificationCodeInput {
  email: string
  purpose?: 'register' | 'password_reset'
}

export interface WorkingVerifyPasswordResetCodeInput {
  email: string
  code: string
}

export interface WorkingPasswordResetInput {
  email: string
  resetToken: string
  password: string
}

export interface WorkingLoginResult {
  token: string
  refreshToken?: string
  userId?: number | string
  isAdmin?: boolean
  accountType?: string
  role?: string
  mustChangePassword?: boolean
  user?: WorkingUser
}

export interface WorkingPasswordResetVerificationResult {
  resetToken: string
}

export interface WorkingWorkspace {
  id: number | string
  workspacePath: string
  pcId?: string
  workspaceType: 'local' | 'cloud'
  isDefault?: boolean
  allowWorkspaceWrite?: boolean
  updatedAt?: string
}

export interface WorkingWorkspaceInput {
  workspacePath: string
  pcId?: string
  workspaceType?: 'local' | 'cloud'
  allowWorkspaceWrite?: boolean
}

export interface WorkingSessionSummary {
  runId: string
  sessionId?: string
  title?: string
  status?: string
  finalText?: string
  updatedAt?: string
  [key: string]: unknown
}

export interface WorkingSessionHistory {
  runId: string
  sessionId?: string
  jsonl?: string
  [key: string]: unknown
}

/** Copis Working 只在主进程中使用的虚拟渠道标识，不会写入 channels.json。 */
export const COPIS_WORKING_CHANNEL_ID = 'copis-working'
export const COPIS_WORKING_DEEPSEEK_CHANNEL_ID = 'copis-working-deepseek'
export const COPIS_WORKING_MODEL_ENDPOINT_PATH = '/api/internal/working-model/v1'
export const COPIS_WORKING_FAST_MODEL_ID = 'fast'
export const COPIS_WORKING_EXPERT_MODEL_ID = 'export'
export const COPIS_WORKING_DEEPSEEK_FAST_MODEL_ID = 'deepseek-v4-flash'
/** Working 模型计费来源头：官方 Copis 客户端标记请求属于 Copis Agent 模型。 */
export const COPIS_WORKING_MODEL_SOURCE_TYPE_HEADER = 'X-Working-Model-Source-Type'
/** Working 模型计费来源值：Copis 内置 Agent 模型统一标记为 copis-agent-model。 */
export const COPIS_WORKING_MODEL_SOURCE_TYPE_COPIS_AGENT = 'copis-agent-model'
export const COPIS_WORKING_MODEL_IDS = [
  COPIS_WORKING_FAST_MODEL_ID,
  COPIS_WORKING_EXPERT_MODEL_ID,
] as const
export const COPIS_WORKING_DEEPSEEK_MODEL_IDS = [
  COPIS_WORKING_DEEPSEEK_FAST_MODEL_ID,
] as const
export const COPIS_WORKING_CHANNEL_IDS = [
  COPIS_WORKING_CHANNEL_ID,
  COPIS_WORKING_DEEPSEEK_CHANNEL_ID,
] as const
export type CopisWorkingModelId = (typeof COPIS_WORKING_MODEL_IDS)[number]

export function isCopisWorkingChannelId(value: string | undefined): boolean {
  return value === COPIS_WORKING_CHANNEL_ID || value === COPIS_WORKING_DEEPSEEK_CHANNEL_ID
}

/** Working Composer 的执行模式。edu-api 使用 fast/export alias；Copis 保留 fast/expert UI 语义。 */
export type WorkingMode = 'fast' | 'expert'

export const WORKING_MODES = ['fast', 'expert'] as const satisfies readonly WorkingMode[]

export function isWorkingMode(value: unknown): value is WorkingMode {
  return value === 'fast' || value === 'expert'
}

export function normalizeWorkingMode(value: unknown): WorkingMode {
  return value === 'expert' ? 'expert' : 'fast'
}

export function workingModeToModelId(mode: WorkingMode): CopisWorkingModelId {
  return mode === 'expert' ? COPIS_WORKING_EXPERT_MODEL_ID : COPIS_WORKING_FAST_MODEL_ID
}

/** 构造仅供 Agent UI 和主进程使用的 Working Responses 渠道。 */
export function createCopisWorkingChannel(backendUrl: string, now = 0): Channel {
  const baseUrl = backendUrl.trim().replace(/\/+$/, '')
  if (!baseUrl) throw new Error('Copis Working 后端地址不能为空')

  return {
    id: COPIS_WORKING_CHANNEL_ID,
    name: '内置模型',
    provider: 'openai-responses',
    baseUrl: `${baseUrl}${COPIS_WORKING_MODEL_ENDPOINT_PATH}`,
    apiKey: '',
    models: COPIS_WORKING_MODEL_IDS.map((id) => ({
      id,
      name: id === COPIS_WORKING_FAST_MODEL_ID ? '快速' : '专家',
      enabled: true,
      source: 'manual' as const,
    })),
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }
}

/** 构造仅供 Agent UI 和主进程使用的 DeepSeek 虚拟渠道。 */
export function createCopisWorkingDeepSeekChannel(backendUrl: string, now = 0): Channel {
  const baseUrl = backendUrl.trim().replace(/\/+$/, '')
  if (!baseUrl) throw new Error('Copis Working 后端地址不能为空')

  return {
    id: COPIS_WORKING_DEEPSEEK_CHANNEL_ID,
    name: 'DeepSeek',
    provider: 'openai-responses',
    baseUrl: `${baseUrl}${COPIS_WORKING_MODEL_ENDPOINT_PATH}`,
    apiKey: '',
    models: [{
      id: COPIS_WORKING_DEEPSEEK_FAST_MODEL_ID,
      name: '快速',
      enabled: true,
      source: 'manual',
    }],
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }
}

/** 根据虚拟渠道 ID 构造 Copis Working 内置渠道。 */
export function createCopisWorkingChannelForId(
  backendUrl: string,
  channelId: string,
  now = 0,
): Channel | undefined {
  if (channelId === COPIS_WORKING_CHANNEL_ID) return createCopisWorkingChannel(backendUrl, now)
  if (channelId === COPIS_WORKING_DEEPSEEK_CHANNEL_ID) return createCopisWorkingDeepSeekChannel(backendUrl, now)
  return undefined
}

/**
 * Copis Working 对本地 Agent 运行暴露的稳定事件契约。
 *
 * Pi/Copis 的底层 SDK 事件不直接成为 Working UI 的业务协议，主进程或
 * renderer 适配层统一映射到以下事件，便于历史回放和实时运行复用同一套语义。
 */
export type WorkingEvent =
  | {
    type: 'run_started'
    sessionId: string
    runId?: string
    startedAt: number
    model?: string
  }
  | {
    type: 'message_delta'
    sessionId: string
    role: 'user' | 'assistant'
    text: string
    messageId?: string
  }
  | {
    type: 'tool_call'
    sessionId: string
    toolUseId: string
    toolName: string
    input: Record<string, unknown>
    parentToolUseId?: string
  }
  | {
    type: 'tool_result'
    sessionId: string
    toolUseId: string
    result: string
    isError: boolean
  }
  | {
    type: 'file_change'
    sessionId: string
    toolUseId?: string
    path: string
    operation?: string
    content?: string
    diff?: string
  }
  | {
    type: 'patch'
    sessionId: string
    patchId?: string
    summary?: string
    files: Array<{ path: string; content?: string; diff?: string }>
  }
  | {
    type: 'todo'
    sessionId: string
    toolUseId?: string
    todos: unknown[]
  }
  | {
    type: 'run_completed'
    sessionId: string
    stopReason?: string
  }
  | {
    type: 'run_failed'
    sessionId: string
    error: string
  }
  | {
    type: 'run_stopped'
    sessionId: string
    reason?: string
  }

export interface WorkingSkill {
  slug: string
  name: string
  description?: string
  version?: string
  instructions?: string
  downloadUrl?: string
  sha256?: string
  size?: number
  [key: string]: unknown
}

/** Working 专家技能市场列表项；安装状态是账号级状态。 */
export interface WorkingExpertSkillMarketItem {
  id: number | string
  slug: string
  name: string
  description: string
  category: string
  accent: string
  version: string
  installed: boolean
  installedAt?: string
  sourceProvider: string
  sourceSlug?: string
  packageSize?: number
  syncStatus: string
  hasOverview?: boolean
  /** 当前 Copis 工作区是否已经落地该市场 Skill。 */
  localInstalled?: boolean
  localVersion?: string
}

export interface WorkingAuthState {
  authenticated: boolean
  user: WorkingUser | null
  backendUrl: string
}

export interface WorkingClientConfig {
  backendUrl: string
}

export interface WorkingFeedbackAttachment {
  type: 'screenshot'
  cosKey: string
  fileName: string
  mimeType: string
  sizeBytes: number
}

export interface WorkingFeedbackInput {
  pageKey: string
  topicKey?: string
  moduleHint?: string
  feedbackType: string
  severity: string
  title: string
  description: string
  route: string
  browser?: Record<string, unknown>
  runtimeContext?: Record<string, unknown>
  pageState?: Record<string, unknown>
  clientLogs?: Array<Record<string, unknown>>
  attachments?: WorkingFeedbackAttachment[]
}

export interface WorkingFeedbackResult {
  id: number | string
  status: string
  message: string
}

export interface WorkingVipStatus {
  isVip: boolean
  vipExpiresAt?: string | null
  tokens: number
  diamonds: number
  upgradeAvailable?: boolean
  upgradeAmount?: string
  upgradeAmountCents?: number
  upgradeBonusDiamonds?: number
  upgradeDays: number
  quotaBytes: number
  quotaLabel: string
}

export interface WorkingInvitedUser {
  id: number | string
  email: string
  nickname: string
  createdAt?: string
  tokens: number
}

export interface WorkingWalletMember {
  userId: number | string
  role?: string
  displayName?: string
  email?: string
  tokens: number
}

export interface WorkingLedgerEntry {
  id: number | string
  payerUserId: number | string
  beneficiaryUserId?: number | string
  amountTokens: number
  type: string
  sourceType?: string
  modelAlias?: string
  memo?: string
  deductionMultiplier?: number
  payerBalanceAfter?: number
  payeeBalanceAfter?: number
  createdAt?: string
}

/** Copis 图片生成结果（edu-api /api/working/images/generate） */
export interface WorkingImageGenerationResult {
  imageUrl?: string
  dataUrl?: string
  contentType?: string
  outputHint?: string
  deductedTokens?: number
  balanceAfter?: number
}

export type WorkingReceiveChannel = 'weixin' | 'feishu'

export interface WorkingReceiveChannelSettings {
  channel: WorkingReceiveChannel
  weixinBound: boolean
  feishuBound: boolean
}

export interface WorkingSettingsSnapshot {
  user: WorkingUser
  hasCheckedIn: boolean
  vip: WorkingVipStatus | null
  invitedUsers: WorkingInvitedUser[]
  inviteCode?: string
  inviteLink?: string
  members: WorkingWalletMember[]
  ledger: WorkingLedgerEntry[]
  receiveChannel: WorkingReceiveChannelSettings | null
}

export interface WorkingCheckInResult {
  tokens: number
  reward: number
}

export type WorkingOrderStatus = 'pending' | 'paid' | 'cancelled' | 'failed' | string

export interface WorkingOrder {
  id: number | string
  outTradeNo: string
  orderType: 'diamond_recharge' | 'vip_upgrade' | string
  title: string
  amount: string
  currency: string
  diamonds: number
  vipDays: number
  method: string
  status: WorkingOrderStatus
  createdAt?: string
  paidAt?: string
}

export interface WorkingOrdersPagination {
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export interface WorkingOrdersPage {
  items: WorkingOrder[]
  pagination: WorkingOrdersPagination
}

export type WorkingPaymentIdentifier = number | string

export interface WorkingDiamondPackage {
  id: number
  serviceId?: string
  goodsName?: string
  amount: string
  amountCents: number
  currency: string
  diamonds: number
  enabled?: boolean
  sortOrder?: number
}

export interface WorkingPaymentSession {
  paymentId: string
  resourceId?: string
  outTradeNo?: string
  tradeNo?: string
  outShakeNo?: string
  status: string
  goodsName?: string
  amount?: string
  currency?: string
  cashierUrl?: string
  qrCodeImage?: string
  qrCodeMimeType?: string
  expiresAt?: string | null
}

export interface WorkingVipPaymentSummary {
  serviceId: string
  days: number
  amount?: string
  amountCents?: number
  bonusDiamonds?: number
  paymentPackage?: WorkingDiamondPackage
}

export interface WorkingPendingDiamondPurchase {
  payment: WorkingPaymentSession
  package: WorkingDiamondPackage
}

export interface WorkingDiamondPurchaseResult {
  outTradeNo?: string
  package: WorkingDiamondPackage
  isVip: boolean
  payment: WorkingPaymentSession
  vip?: WorkingVipPaymentSummary
  pendingExisting?: boolean
}

export interface WorkingOrderPayment {
  order: WorkingOrder
  payment: WorkingPaymentSession
  package: WorkingDiamondPackage
  vip?: WorkingVipPaymentSummary
}

export interface WorkingPaymentCheckResult {
  payment: WorkingPaymentSession
  status: string
}

export interface WorkingPaymentCancelResult {
  cancelled: boolean
  payment: WorkingPaymentSession
}

/** Renderer 可见的登录结果，不包含 token。 */
export type WorkingLoginResponse = WorkingAuthState

/** Renderer 只接收归一化后的支付结果，不包含支付 proof、payment_needed 或资源诊断数据。 */
export const WORKING_IPC_CHANNELS = {
  GET_CONFIG: 'working:get-config',
  GET_AUTH_STATE: 'working:get-auth-state',
  LOGIN: 'working:login',
  LOGOUT: 'working:logout',
  GET_CURRENT_USER: 'working:get-current-user',
  REGISTER: 'working:register',
  SEND_VERIFICATION_CODE: 'working:send-verification-code',
  VERIFY_PASSWORD_RESET_CODE: 'working:verify-password-reset-code',
  RESET_PASSWORD: 'working:reset-password',
  LIST_WORKSPACES: 'working:list-workspaces',
  SAVE_WORKSPACE: 'working:save-workspace',
  LIST_SESSIONS: 'working:list-sessions',
  GET_SESSION_HISTORY: 'working:get-session-history',
  LIST_SKILLS: 'working:list-skills',
  CREATE_FEEDBACK: 'working:create-feedback',
  GET_SETTINGS_SNAPSHOT: 'working:get-settings-snapshot',
  CHECK_IN: 'working:check-in',
  SET_RECEIVE_CHANNEL: 'working:set-receive-channel',
  LIST_ORDERS: 'working:list-orders',
  DELETE_ORDER: 'working:delete-order',
  LIST_DIAMOND_PACKAGES: 'working:list-diamond-packages',
  GET_PENDING_DIAMOND_PURCHASE: 'working:get-pending-diamond-purchase',
  CREATE_DIAMOND_PURCHASE: 'working:create-diamond-purchase',
  CREATE_VIP_UPGRADE: 'working:create-vip-upgrade',
  GET_ORDER_PAYMENT: 'working:get-order-payment',
  CHECK_PAYMENT: 'working:check-payment',
  CANCEL_DIAMOND_PAYMENT: 'working:cancel-diamond-payment',
  /** VIP 到账后主进程向 Renderer 推送最新账户资料。 */
  AUTH_UPDATED: 'working:auth-updated',
} as const
