/**
 * Copis Working 客户端与 ai-education 后端之间的业务契约。
 *
 * 这里仅描述账号、工作区、历史和技能数据；本地 Agent 运行仍由
 * Electron main process 直接调用 Pi SDK，不通过 Working 远程 run API。
 */

export interface WorkingUser {
  id: number | string
  email?: string
  nickname?: string
  account_type?: string
  accountType?: string
  [key: string]: unknown
}

export interface WorkingLoginInput {
  email: string
  password: string
}

export interface WorkingLoginResult {
  token: string
  userId?: number | string
  isAdmin?: boolean
  accountType?: string
  role?: string
  mustChangePassword?: boolean
  user?: WorkingUser
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

export interface WorkingAuthState {
  authenticated: boolean
  user: WorkingUser | null
  backendUrl: string
}

export interface WorkingClientConfig {
  backendUrl: string
}

/** Renderer 可见的登录结果，不包含 token。 */
export type WorkingLoginResponse = WorkingAuthState

export const WORKING_IPC_CHANNELS = {
  GET_CONFIG: 'working:get-config',
  GET_AUTH_STATE: 'working:get-auth-state',
  LOGIN: 'working:login',
  LOGOUT: 'working:logout',
  GET_CURRENT_USER: 'working:get-current-user',
  LIST_WORKSPACES: 'working:list-workspaces',
  SAVE_WORKSPACE: 'working:save-workspace',
  LIST_SESSIONS: 'working:list-sessions',
  GET_SESSION_HISTORY: 'working:get-session-history',
  LIST_SKILLS: 'working:list-skills',
} as const
