/**
 * Agent Mail (Agent 原生 QQ 邮箱) 类型与 IPC 通道定义
 *
 * 通过 Rust HTTP API 与 agently-cli 受控交互。
 */

export type AgentMailAction =
  | 'auth.status'
  | 'auth.login'
  | 'auth.logout'
  | 'me'
  | 'message.list'
  | 'message.read'
  | 'message.send'
  | 'message.reply'
  | 'message.forward'
  | 'message.search'
  | 'message.trash'
  | 'message.delete'
  | 'attachment.download'
  | 'attachment.upload'

export interface AgentMailAlias {
  alias_id: string
  email: string
  is_primary: boolean
  name: string
}

export interface AgentMailStatus {
  installed: boolean
  loggedIn: boolean
  email?: string
  name?: string
  aliases?: AgentMailAlias[]
  authUrl?: string
  status: 'not_installed' | 'not_logged_in' | 'authenticating' | 'connected' | 'error'
  errorMessage?: string
}

export interface AgentMailRequest {
  action: AgentMailAction
  sessionId?: string
  id?: string
  query?: string
  dir?: 'inbox' | 'sent' | 'trash' | 'spam'
  limit?: number
  cursor?: string
  after?: string
  before?: string
  hasAttachments?: boolean
  isUnread?: boolean
  to?: string[]
  cc?: string[]
  bcc?: string[]
  subject?: string
  body?: string
  bodyFile?: string
  attachments?: string[]
  replyAll?: boolean
  includeAttachments?: boolean
  confirmed?: boolean
  confirmationToken?: string
  all?: boolean
  file?: string
  msgId?: string
  attId?: string
  outputDir?: string
}

export interface AgentMailResponse {
  ok: boolean
  data?: unknown
  error?: {
    code?: string
    message: string
  }
}

export const AGENT_MAIL_IPC_CHANNELS = {
  /** 获取 Agent Mail 授权与账号状态 */
  GET_STATUS: 'agent-mail:get-status',
  /** 发起 OAuth 扫码/网页登录 */
  START_LOGIN: 'agent-mail:start-login',
  /** 取消登录流程 */
  CANCEL_LOGIN: 'agent-mail:cancel-login',
  /** 退出登录并清除凭证 */
  LOGOUT: 'agent-mail:logout',
  /** 状态变化推送 */
  STATUS_CHANGED: 'agent-mail:status-changed',
} as const
