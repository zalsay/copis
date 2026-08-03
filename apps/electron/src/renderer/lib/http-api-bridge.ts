// 浏览器模式走 Vite 同源代理，代理目标仍是主进程的 127.0.0.1:51730。
const HTTP_API_BASE_URL = ''
const HTTP_API_STARTUP_RETRY_COUNT = 60
const HTTP_API_STARTUP_RETRY_DELAY_MS = 500

let httpApiBridgeActive = false

export function isHttpApiBridgeActive(): boolean {
  return httpApiBridgeActive
}

type HttpMethod = (args: readonly unknown[]) => Promise<unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function fetchWithStartupRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt < HTTP_API_STARTUP_RETRY_COUNT; attempt += 1) {
    try {
      const response = await fetch(url, init)
      // Vite 代理在目标服务启动前可能返回 5xx，按启动失败重试。
      if (response.status < 500 || response.status > 504 || attempt + 1 >= HTTP_API_STARTUP_RETRY_COUNT) {
        return response
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, HTTP_API_STARTUP_RETRY_DELAY_MS))
    } catch (error: unknown) {
      lastError = error
      if (attempt + 1 >= HTTP_API_STARTUP_RETRY_COUNT) break
      await new Promise<void>((resolve) => window.setTimeout(resolve, HTTP_API_STARTUP_RETRY_DELAY_MS))
    }
  }
  throw lastError instanceof Error ? lastError : new Error('HTTP API 服务未启动')
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }
  const response = await fetchWithStartupRetry(`${HTTP_API_BASE_URL}${path}`, init)
  const text = await response.text()
  let payload: unknown
  if (text) {
    try {
      payload = JSON.parse(text) as unknown
    } catch {
      payload = text
    }
  }
  if (!response.ok) {
    const message = isRecord(payload) && typeof payload.error === 'string'
      ? payload.error
      : `HTTP API 请求失败（${response.status}）`
    throw new Error(message)
  }
  return payload as T
}

function getArgument<T>(args: readonly unknown[], index: number): T {
  return args[index] as T
}

function createHttpMethods(): Record<string, HttpMethod> {
  return {
    // ===== Copis Working =====
    getWorkingConfig: () => request('/api/working/config'),
    getWorkingAuthState: () => request('/api/working/auth-state'),
    loginWorking: (args) => request('/api/working/login', 'POST', getArgument(args, 0)),
    registerWorking: (args) => request('/api/working/register', 'POST', getArgument(args, 0)),
    sendWorkingVerificationCode: (args) => request('/api/working/send-verification-code', 'POST', getArgument(args, 0)),
    verifyWorkingPasswordResetCode: (args) => request('/api/working/verify-password-reset-code', 'POST', getArgument(args, 0)),
    resetWorkingPassword: (args) => request('/api/working/reset-password', 'POST', getArgument(args, 0)),
    logoutWorking: () => request('/api/working/logout', 'POST'),
    getWorkingCurrentUser: () => request('/api/working/current-user'),
    listWorkingWorkspaces: () => request('/api/working/workspaces'),
    saveWorkingWorkspace: (args) => request('/api/working/workspaces', 'POST', getArgument(args, 0)),
    listWorkingSessions: () => request('/api/working/sessions'),
    getWorkingSessionHistory: (args) => {
      const runId = encodeURIComponent(getArgument<string>(args, 0))
      const sessionId = getArgument<string | undefined>(args, 1)
      const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
      return request(`/api/working/sessions/${runId}/history${query}`)
    },
    listWorkingSkills: () => request('/api/working/skills'),
    createWorkingFeedback: (args) => request('/api/working/feedback', 'POST', getArgument(args, 0)),
    getWorkingSettingsSnapshot: () => request('/api/working/settings'),
    checkInWorking: () => request('/api/working/check-in', 'POST'),
    setWorkingReceiveChannel: (args) => request('/api/working/receive-channel', 'PUT', { channel: getArgument(args, 0) }),
    listWorkingOrders: (args) => {
      const page = getArgument<number | undefined>(args, 0)
      const pageSize = getArgument<number | undefined>(args, 1)
      const query = new URLSearchParams()
      if (page !== undefined) query.set('page', String(page))
      if (pageSize !== undefined) query.set('pageSize', String(pageSize))
      return request(`/api/working/orders?${query.toString()}`)
    },
    deleteWorkingOrder: (args) => request(`/api/working/orders/${encodeURIComponent(String(getArgument<number | string>(args, 0)))}`, 'DELETE'),

    // ===== 应用设置 =====
    getSettings: () => request('/api/settings'),
    updateSettings: (args) => request('/api/settings', 'PATCH', getArgument(args, 0)),
    getTutorialContent: async () => {
      const result = await request<{ content: string | null }>('/api/tutorial')
      return result.content
    },

    // ===== Agent 默认项目 =====
    listAgentWorkspaces: () => request('/api/agent/workspaces'),
    listAgentSessions: () => request('/api/agent/sessions'),
    clearAgentCompletionState: (args) => {
      const sessionId = encodeURIComponent(getArgument<string>(args, 0))
      return request(`/api/agent/sessions/${sessionId}/clear-completion-state`, 'POST')
    },
    createAgentSession: (args) => request('/api/agent/sessions', 'POST', {
      ...(getArgument<string | undefined>(args, 0) ? { title: getArgument<string>(args, 0) } : {}),
      ...(getArgument<string | undefined>(args, 2) ? { workspaceId: getArgument<string>(args, 2) } : {}),
      ...(getArgument<string | undefined>(args, 3) ? { modelId: getArgument<string>(args, 3) } : {}),
    }),
    getAgentSessionSDKMessages: (args) => {
      const sessionId = encodeURIComponent(getArgument<string>(args, 0))
      return request(`/api/agent/sessions/${sessionId}/messages`)
        .then((result) => isRecord(result) && Array.isArray(result.messages) ? result.messages : [])
    },
    sendAgentMessage: (args) => {
      const input = getArgument<{ sessionId: string; userMessage: string; modelId?: string }>(args, 0)
      const sessionId = encodeURIComponent(input.sessionId)
      return request(`/api/agent/sessions/${sessionId}/messages`, 'POST', {
        userMessage: input.userMessage,
        ...(input.modelId ? { modelId: input.modelId } : {}),
      })
    },
    stopAgent: (args) => {
      const sessionId = encodeURIComponent(getArgument<string>(args, 0))
      return request(`/api/agent/sessions/${sessionId}/stop`, 'POST')
    },

    // ===== 浏览器可替代的系统能力 =====
    getSystemTheme: () => Promise.resolve(window.matchMedia('(prefers-color-scheme: dark)').matches),
    openExternal: (args) => {
      const url = getArgument<string>(args, 0)
      window.open(url, '_blank', 'noopener,noreferrer')
      return Promise.resolve(undefined)
    },
    writeClipboardText: async (args) => {
      const text = getArgument<string>(args, 0)
      await navigator.clipboard?.writeText(text)
    },
    windowIsMaximized: () => Promise.resolve(false),
    setDockBadgeCount: () => Promise.resolve(true),
  }
}

const ARRAY_DEFAULT_METHODS = new Set([
  'listChannels',
  'listConversations',
  'listAgentSessions',
  'listAgentWorkspaces',
  'listTodos',
  'listCalendarEvents',
  'listPlanningGroups',
  'listPlanningTags',
  'listActivePlanningReminders',
  'listAutomations',
  'listWorktrees',
  'getChatTools',
  'getConversationMessages',
  'getAgentSessionSDKMessages',
  'getWorkspaceSkills',
  'getOtherWorkspaceSkills',
  'getDefaultSkillSlugs',
  'searchConversationMessages',
  'searchAgentSessionMessages',
  'searchAgentSessionReferences',
  'listSkillFiles',
  'listWorkspaceAutoMemoryFiles',
])

const OBJECT_DEFAULTS: Record<string, unknown> = {
  getFeishuMultiStatus: { bots: {} },
  getDingTalkMultiStatus: { bots: {} },
  getFeishuStatus: { status: 'disconnected' },
  getDingTalkStatus: { status: 'disconnected' },
  getWeChatStatus: { status: 'disconnected' },
  getPendingRequests: { permissions: [], askUsers: [], exitPlans: [] },
  getWorkspaceCapabilities: { mcpServers: [], builtinMcpServers: [], skills: [], memory: { directory: '', memoryMdExists: false, fileCount: 0, totalSize: 0 } },
  getWorkspaceMcpConfig: { mcpServers: [] },
  getUserProfile: { userName: '用户', avatar: '' },
  getRuntimeStatus: null,
  checkEnvironment: null,
}

function createAgentIslandFallback(): Record<string, unknown> {
  return new Proxy<Record<string, unknown>>({}, {
    get: (_target, property: string | symbol) => {
      if (typeof property !== 'string') return undefined
      return (..._args: unknown[]) => Promise.resolve(undefined)
    },
  })
}

function createWebTabsFallback(): Record<string, unknown> {
  const emptySnapshot = (): { tabs: never[]; activeTabId: null } => ({ tabs: [], activeTabId: null })
  return {
    list: () => Promise.resolve(emptySnapshot()),
    create: () => Promise.reject(new Error('浏览器模式不支持内嵌 Chromium 页签')),
    activate: () => Promise.resolve(emptySnapshot()),
    close: () => Promise.resolve(emptySnapshot()),
    navigate: () => Promise.reject(new Error('浏览器模式不支持内嵌 Chromium 页签')),
    updateBounds: () => Promise.resolve(),
    goBack: () => Promise.resolve(emptySnapshot()),
    goForward: () => Promise.resolve(emptySnapshot()),
    reload: () => Promise.resolve(emptySnapshot()),
    sendCdpCommand: () => Promise.reject(new Error('浏览器模式不支持 CDP')),
    onChanged: (_callback: unknown) => () => {},
  }
}

function createHttpApiBridge(): Window['electronAPI'] {
  const methods = createHttpMethods()
  const agentIsland = createAgentIslandFallback()
  const webTabs = createWebTabsFallback()

  const bridge = new Proxy<Record<string, unknown>>({}, {
    get: (_target, property: string | symbol) => {
      if (typeof property !== 'string' || property === 'then') return undefined
      if (property === 'updater') return undefined
      if (property === 'agentIsland') return agentIsland
      if (property === 'webTabs') return webTabs
      if (property === 'updateSettingsSync') return () => false
      if (property === 'saveScratchPadSync') return () => true
      if (property === 'loadScratchPad') return () => Promise.resolve('')
      if (property === 'saveScratchPad') return () => Promise.resolve(true)
      if (property === 'openFolderDialog') return () => Promise.resolve(null)
      if (property === 'openFileDialog') return () => Promise.resolve({ files: [] })
      if (property === 'openFileOrFolderDialog') return () => Promise.resolve({ files: [], directories: [] })
      if (property.startsWith('on')) return (_callback: unknown) => () => {}

      const method = methods[property]
      if (method) return (...args: unknown[]) => method(args)
      if (ARRAY_DEFAULT_METHODS.has(property) || property.startsWith('list') || property.startsWith('search')) {
        return () => Promise.resolve([])
      }
      if (Object.prototype.hasOwnProperty.call(OBJECT_DEFAULTS, property)) {
        return () => Promise.resolve(OBJECT_DEFAULTS[property])
      }

      // 桌面专属能力在浏览器中不可用，但保持 Promise 形状，避免初始化流程中断。
      return (..._args: unknown[]) => Promise.resolve(undefined)
    },
  })

  return bridge as unknown as Window['electronAPI']
}

/** 在普通浏览器中补齐 Electron API；Electron Preload 已注入时不做任何覆盖。 */
export function installHttpApiBridge(): void {
  const runtimeWindow = window as unknown as { electronAPI?: Window['electronAPI'] }
  if (runtimeWindow.electronAPI) return
  runtimeWindow.electronAPI = createHttpApiBridge()
  httpApiBridgeActive = true
  console.info('[HTTP API] 浏览器模式已连接：通过 Vite /api 代理访问 51730')
}
