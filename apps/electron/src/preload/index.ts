/**
 * Preload 脚本
 *
 * 通过 contextBridge 安全地将 API 暴露给渲染进程
 * 使用上下文隔离确保安全性
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC_CHANNELS, CHANNEL_IPC_CHANNELS, ATTACHMENT_IPC_CHANNELS, AGENT_IPC_CHANNELS, ENVIRONMENT_IPC_CHANNELS, INSTALLER_IPC_CHANNELS, FUNCTIONAL_MODULE_IPC_CHANNELS, PROXY_IPC_CHANNELS, GITHUB_RELEASE_IPC_CHANNELS, SYSTEM_PROMPT_IPC_CHANNELS, AGENT_TOOL_IPC_CHANNELS, FEISHU_IPC_CHANNELS, DINGTALK_IPC_CHANNELS, WECHAT_IPC_CHANNELS, AUTOMATION_IPC_CHANNELS, PLANNING_IPC_CHANNELS, WORKING_IPC_CHANNELS, WEB_IPC_CHANNELS, BROWSER_WORKFLOW_IPC_CHANNELS } from '@copis/shared'
import { USER_PROFILE_IPC_CHANNELS, SETTINGS_IPC_CHANNELS, SCRATCH_PAD_IPC_CHANNELS, APP_ICON_IPC_CHANNELS, DOCK_BADGE_IPC_CHANNELS, STORAGE_IPC_CHANNELS } from '../types'
import { agentHttpStreamClient } from '../renderer/lib/agent-http-stream'
import type {
  RuntimeStatus,
  GitRepoStatus,
  Channel,
  ChannelCreateInput,
  ChannelUpdateInput,
  ChannelTestResult,
  ChannelDirectTestInput,
  FetchModelsInput,
  FetchModelsResult,
  ChannelPlanQuotaResult,
  CodexOAuthLoginResult,
  XaiOAuthLoginResult,
  XaiOAuthDeviceCode,
  FileDialogResult,
  FileOrFolderDialogResult,
  AgentSessionMeta,
  AgentExpertTeamSession,
  SDKMessage,
  AgentSendInput,
  AgentRuntime,
  AgentThinkingLevel,
  AgentStreamEvent,
  AgentStreamCompletePayload,
  AgentWorkspace,
  CreateAgentWorkspaceInput,
  CreateAgentProjectResult,
  AgentGenerateTitleInput,
  AgentSaveFilesInput,
  AgentSaveWorkspaceFilesInput,
  AgentSavedFile,
  AgentAttachDirectoryInput,
  AgentAttachFileInput,
  WorkspaceAttachDirectoryInput,
  WorkspaceAttachFileInput,
  GetTaskOutputInput,
  GetTaskOutputResult,
  StopTaskInput,
  WorkspaceMcpConfig,
  SkillMeta,
  OtherWorkspaceSkillsGroup,
  WorkspaceCapabilities,
  FileEntry,
  FileSearchResult,
  EnvironmentCheckResult,
  InstallerManifest,
  InstallerDownloadRequest,
  InstallerDownloadResult,
  InstallerProgressPayload,
  FunctionalModuleInstallInput,
  FunctionalModuleName,
  FunctionalModuleProgressPayload,
  FunctionalModuleStartupProgressPayload,
  FunctionalModuleStatus,
  ProxyConfig,
  SystemProxyDetectResult,
  GitHubRelease,
  GitHubReleaseListOptions,
  PermissionRequest,
  PermissionResponse,
  CopisPermissionMode,
  AskUserRequest,
  AskUserResponse,
  ExitPlanModeResponse,
  SystemPromptConfig,
  SystemPrompt,
  SystemPromptCreateInput,
  SystemPromptUpdateInput,
  AgentToolInfo,
  AgentToolState,
  AgentToolMeta,
  MoveSessionToWorkspaceInput,
  ForkSessionInput,
  CreateAgentSideQuestionSessionInput,
  AgentSideQuestionSessionResult,
  RewindSessionInput,
  RewindSessionResult,
  AgentMessageSearchResult,
  AgentSessionReferenceSearchInput,
  AgentSessionReferenceSearchResult,
  DetachedPreviewWindowData,
  DetachedPreviewWindowInput,
  FeishuConfig,
  FeishuConfigInput,
  FeishuBridgeState,
  FeishuTestResult,
  FeishuChatBinding,
  FeishuPresenceReport,
  FeishuUpdateBindingInput,
  DingTalkConfig,
  DingTalkConfigInput,
  DingTalkBridgeState,
  DingTalkTestResult,
  WeChatConfig,
  WeChatBridgeState,
  AgentQueueMessageInput,
  PendingRequestsSnapshot,
  Automation,
  CreateAutomationInput,
  UpdateAutomationInput,
  Todo,
  TodoListQuery,
  CalendarEvent,
  CalendarEventListQuery,
  PlanningGroup,
  PlanningGroupScope,
  PlanningTag,
  PlanningReminder,
  ActivePlanningReminder,
  PlanningAgentOperation,
  PlanningChange,
  CreateTodoInput,
  StartTodoAgentInput,
  StartTodoAgentResult,
  TodoAgentSessionActivation,
  UpdateTodoInput,
  CreateCalendarEventInput,
  UpdateCalendarEventInput,
  CreatePlanningGroupInput,
  UpdatePlanningGroupInput,
  SnoozePlanningReminderInput,
  WorkingAuthState,
  WorkingCheckInResult,
  WorkingAlipayPagePayOrder,
  WorkingClientConfig,
  WorkingFeedbackInput,
  WorkingFeedbackResult,
  WorkingReceiveChannel,
  WorkingReceiveChannelSettings,
  WorkingSettingsSnapshot,
  WorkingLoginInput,
  WorkingOrdersPage,
  WorkingOrderPayment,
  WorkingPaymentCancelResult,
  WorkingPaymentCheckResult,
  WorkingPaymentIdentifier,
  WorkingPendingDiamondPurchase,
  WorkingDiamondPackage,
  WorkingDiamondPurchaseResult,
  WorkingPasswordResetInput,
  WorkingPasswordResetVerificationResult,
  WorkingRegisterInput,
  WorkingSendVerificationCodeInput,
  WorkingSessionHistory,
  WorkingSessionSummary,
  WorkingSkill,
  WorkingUser,
  WorkingVerifyPasswordResetCodeInput,
  CreateWebTabInput,
  NavigateWebTabInput,
  OpenWebBookmarksWindowInput,
  ResizeWebBookmarksWindowInput,
  SaveWebBookmarkInput,
  SaveWebPageProjectAssociationInput,
  CreateWebBookmarkGroupInput,
  RenameWebBookmarkGroupInput,
  UpdateWebTabBoundsInput,
  BrowserAgentContext,
  BrowserPageControlMode,
  BrowserWorkflowStatus,
  BrowserWorkflowRecordingSummary,
  BrowserWorkflowVersion,
  BrowserWorkflowManifest,
  WebBookmarksSnapshot,
  WebPageProjectAssociation,
  WebTabsSnapshot,
  WorkingWorkspace,
  WorkingWorkspaceInput,
} from '@copis/shared'

const HTTP_API_WEB_TOKEN_ARGUMENT_PREFIX = '--copis-http-api-web-token='
import type {
  UserProfile,
  AppSettings,
  QuickTaskSubmitInput,
  QuickTaskOpenSessionData,
  VoiceDictationAudioChunkInput,
  VoiceDictationCommitInput,
  VoiceDictationCommitResult,
  VoiceDictationPreviewInput,
  VoiceDictationResizeInput,
  VoiceDictationSettings,
  VoiceDictationSettingsUpdate,
  VoiceDictationStartInput,
  VoiceDictationIndicatorEvent,
  VoiceDictationStateEvent,
  VoiceDictationStopInput,
  VoiceDictationTestResult,
  VoiceDictationTranscriptEvent,
  VoiceDictationTextEvent,
  MicPermissionResult,
  TrayOpenAgentSessionData,
} from '../types'
import { QUICK_TASK_IPC_CHANNELS, TRAY_IPC_CHANNELS, VOICE_DICTATION_IPC_CHANNELS } from '../types'

/**
 * 暴露给渲染进程的 API 接口定义
 */
export interface ElectronAPI {
  // ===== 运行时相关 =====

  /**
   * 获取本次启动的 HTTP API 浏览器会话令牌
   * 渲染层直连 Rust HTTP API 时通过 x-copis-web-token 请求头携带。
   */
  getHttpApiWebToken: () => string

  /**
   * 获取运行时状态
   * @returns 运行时状态，包含 Bun、Git 等信息
   */
  getRuntimeStatus: () => Promise<RuntimeStatus | null>

  /**
   * 重新初始化运行时状态（重新跑 Node / Bun / Git / Shell 检测）
   * 用户安装完 Git / Node 后触发，强制刷新缓存
   */
  reinitRuntime: () => Promise<RuntimeStatus>

  /**
   * 获取指定目录的 Git 仓库状态
   * @param dirPath - 目录路径
   * @returns Git 仓库状态
   */
  getGitRepoStatus: (dirPath: string) => Promise<GitRepoStatus | null>

  /** 获取未暂存的变更文件列表 */
  getUnstagedChanges: (dirPath: string, sessionPath?: string, workspaceFilesPath?: string, extraPaths?: string[], sessionId?: string) => Promise<import('@copis/shared').UnstagedChangesResult>
  /** 获取单个文件的 diff */
  getFileDiff: (input: import('@copis/shared').GetFileDiffInput) => Promise<string>
  /** 获取未追踪文件内容 */
  getUntrackedContent: (input: import('@copis/shared').GetFileDiffInput) => Promise<string>
  /** 还原文件变更 */
  revertFile: (input: import('@copis/shared').RevertFileInput) => Promise<void>
  /** 获取文件新旧版本内容 */
  getDiffContents: (input: import('@copis/shared').GetFileDiffInput) => Promise<{ oldContent: string; newContent: string } | null>
  /** 列出 Git Worktree */
  listWorktrees: (repoPath: string, sessionId: string) => Promise<import('@copis/shared').WorktreeInfo[]>
  /** 获取 Worktree 相对于基准分支的全量变更 */
  getWorktreeChanges: (worktreePath: string, baseBranch: string, sessionId: string) => Promise<import('@copis/shared').UnstagedChangesResult>
  /** 在独立窗口打开当前文件预览 */
  openDetachedPreview: (input: DetachedPreviewWindowInput) => Promise<string | null>
  /** 获取独立预览窗口数据 */
  getDetachedPreviewData: (previewId: string) => Promise<DetachedPreviewWindowData | null>

  // ===== 通用工具 =====

  /** 在系统默认浏览器中打开外部链接 */
  openExternal: (url: string) => Promise<void>
  /** 在系统剪贴板中写入纯文本 */
  writeClipboardText: (text: string) => Promise<void>

  // ===== 内嵌 Chromium 网页页签 =====
  webTabs: {
    /** 获取网页页签快照。 */
    list: () => Promise<WebTabsSnapshot>
    /** 创建并默认激活网页页签。 */
    create: (input?: CreateWebTabInput) => Promise<WebTabsSnapshot>
    /** 激活网页页签，传 null 返回 Copis 首页。 */
    activate: (tabId: string | null) => Promise<WebTabsSnapshot>
    /** 关闭网页页签。 */
    close: (tabId: string) => Promise<WebTabsSnapshot>
    /** 导航到网页地址。 */
    navigate: (input: NavigateWebTabInput) => Promise<WebTabsSnapshot>
    /** 同步网页原生视图尺寸。 */
    updateBounds: (input: UpdateWebTabBoundsInput) => Promise<void>
    /** 打开原生收藏夹浮层窗口。 */
    bookmarksOpen: (input: OpenWebBookmarksWindowInput) => Promise<void>
    /** 关闭原生收藏夹浮层窗口。 */
    bookmarksClose: () => Promise<void>
    /** 调整原生收藏夹浮层窗口尺寸。 */
    bookmarksResize: (input: ResizeWebBookmarksWindowInput) => Promise<void>
    /** 网页后退。 */
    goBack: (tabId: string) => Promise<WebTabsSnapshot>
    /** 网页前进。 */
    goForward: (tabId: string) => Promise<WebTabsSnapshot>
    /** 刷新网页。 */
    reload: (tabId: string) => Promise<WebTabsSnapshot>
    /** 发送 CDP 命令。 */
    /** 获取网页收藏夹。 */
    bookmarksList: () => Promise<WebBookmarksSnapshot>
    /** 保存网页收藏。 */
    bookmarksSave: (input: SaveWebBookmarkInput) => Promise<WebBookmarksSnapshot>
    /** 删除网页收藏。 */
    bookmarksRemove: (bookmarkId: string) => Promise<WebBookmarksSnapshot>
    /** 创建收藏分组。 */
    bookmarksGroupCreate: (input: CreateWebBookmarkGroupInput) => Promise<WebBookmarksSnapshot>
    /** 重命名收藏分组。 */
    bookmarksGroupRename: (input: RenameWebBookmarkGroupInput) => Promise<WebBookmarksSnapshot>
    /** 删除收藏分组，分组内收藏移动到未分组。 */
    bookmarksGroupRemove: (groupId: string) => Promise<WebBookmarksSnapshot>
    /** 获取当前页面上次关联的 Agent 项目。 */
    getProjectAssociation: (url: string) => Promise<WebPageProjectAssociation | null>
    /** 保存当前页面与 Agent 项目的关联。 */
    saveProjectAssociation: (input: SaveWebPageProjectAssociationInput) => Promise<WebPageProjectAssociation>
    /** 订阅主进程推送的网页页签状态。 */
    onChanged: (callback: (snapshot: WebTabsSnapshot) => void) => () => void
  }

  // ===== Browser Workflow（仅暴露高层录制控制，不暴露 CDP） =====
  browserWorkflow: {
    bindContext: (sessionId: string, context: BrowserAgentContext) => Promise<BrowserWorkflowStatus>
    unbindContext: (sessionId: string) => Promise<void>
    getStatus: (sessionId: string) => Promise<BrowserWorkflowStatus>
    setControlMode: (sessionId: string, mode: BrowserPageControlMode) => Promise<BrowserWorkflowStatus>
    startRecording: (sessionId: string) => Promise<BrowserWorkflowStatus>
    stopRecording: (sessionId: string) => Promise<BrowserWorkflowRecordingSummary>
    stopRun: (sessionId: string) => Promise<void>
    continueRun: (sessionId: string) => Promise<void>
    cancelRecording: (sessionId: string) => Promise<void>
    getDraft: (sessionId: string) => Promise<BrowserWorkflowVersion | undefined>
    approveDraft: (sessionId: string, name?: string, description?: string, unattendedAllowed?: boolean) => Promise<BrowserWorkflowManifest>
    rejectDraft: (sessionId: string) => Promise<void>
    onStatusChanged: (callback: (event: { sessionId: string; status: BrowserWorkflowStatus }) => void) => () => void
  }

  // ===== 窗口控制（Windows 自定义标题栏）=====

  /** 最小化窗口 */
  windowMinimize: () => Promise<void>
  /** 最大化/还原窗口 */
  windowMaximize: () => Promise<void>
  /** 关闭窗口 */
  windowClose: (quitApp?: boolean) => Promise<void>
  /** 窗口是否处于最大化状态 */
  windowIsMaximized: () => Promise<boolean>
  /** 订阅窗口最大化/还原事件 */
  onWindowResize: (callback: () => void) => () => void

  // ===== Copis Working 后端（不暴露 token） =====
  getWorkingConfig: () => Promise<WorkingClientConfig>
  getWorkingAuthState: () => Promise<WorkingAuthState>
  loginWorking: (input: WorkingLoginInput) => Promise<WorkingAuthState>
  registerWorking: (input: WorkingRegisterInput) => Promise<WorkingUser | null>
  sendWorkingVerificationCode: (input: WorkingSendVerificationCodeInput) => Promise<void>
  verifyWorkingPasswordResetCode: (input: WorkingVerifyPasswordResetCodeInput) => Promise<WorkingPasswordResetVerificationResult>
  resetWorkingPassword: (input: WorkingPasswordResetInput) => Promise<void>
  logoutWorking: () => Promise<WorkingAuthState>
  getWorkingCurrentUser: () => Promise<WorkingUser>
  listWorkingWorkspaces: () => Promise<WorkingWorkspace[]>
  saveWorkingWorkspace: (input: WorkingWorkspaceInput) => Promise<WorkingWorkspace>
  listWorkingSessions: () => Promise<WorkingSessionSummary[]>
  getWorkingSessionHistory: (runId: string, sessionId?: string) => Promise<WorkingSessionHistory>
  listWorkingSkills: () => Promise<WorkingSkill[]>
  createWorkingFeedback: (input: WorkingFeedbackInput) => Promise<WorkingFeedbackResult>
  getWorkingSettingsSnapshot: () => Promise<WorkingSettingsSnapshot>
  checkInWorking: () => Promise<WorkingCheckInResult>
  setWorkingReceiveChannel: (channel: WorkingReceiveChannel) => Promise<WorkingReceiveChannelSettings>
  listWorkingOrders: (page?: number, pageSize?: number) => Promise<WorkingOrdersPage>
  deleteWorkingOrder: (orderId: number | string) => Promise<void>
  listWorkingDiamondPackages: () => Promise<WorkingDiamondPackage[]>
  getPendingWorkingDiamondPurchase: () => Promise<WorkingPendingDiamondPurchase | null>
  createWorkingDiamondPurchase: (packageId: number) => Promise<WorkingDiamondPurchaseResult>
  createWorkingVipUpgrade: () => Promise<WorkingDiamondPurchaseResult>
  getWorkingOrderPayment: (orderId: WorkingPaymentIdentifier) => Promise<WorkingOrderPayment>
  checkWorkingPayment: (paymentId: WorkingPaymentIdentifier) => Promise<WorkingPaymentCheckResult>
  cancelWorkingDiamondPayment: (paymentId: WorkingPaymentIdentifier) => Promise<WorkingPaymentCancelResult>
  createWorkingAlipayPagePayOrder: (packageId: number) => Promise<WorkingAlipayPagePayOrder>
  checkWorkingAlipayPagePayOrder: (paymentId: WorkingPaymentIdentifier) => Promise<WorkingAlipayPagePayOrder>

  // ===== 渠道管理相关 =====

  /** 获取所有渠道列表（apiKey 保持加密态） */
  listChannels: () => Promise<Channel[]>

  /** 创建渠道（apiKey 为明文，主进程加密） */
  createChannel: (input: ChannelCreateInput) => Promise<Channel>

  /** 更新渠道 */
  updateChannel: (id: string, input: ChannelUpdateInput) => Promise<Channel>

  /** 删除渠道 */
  deleteChannel: (id: string) => Promise<void>

  /** 解密获取明文 API Key（仅在用户查看时调用） */
  decryptApiKey: (channelId: string) => Promise<string>

  /** 测试渠道连接 */
  testChannel: (channelId: string) => Promise<ChannelTestResult>

  /** 直接测试连接（无需已保存渠道，传入明文凭证） */
  testChannelDirect: (input: ChannelDirectTestInput) => Promise<ChannelTestResult>

  /** 从供应商拉取可用模型列表（直接传入凭证，无需已保存渠道） */
  fetchModels: (input: FetchModelsInput) => Promise<FetchModelsResult>

  /** 查询渠道订阅 Plan 额度 */
  getChannelPlanQuota: (channelId: string) => Promise<ChannelPlanQuotaResult>

  /** 发起 ChatGPT (Codex) OAuth 登录，返回序列化凭据（作为 apiKey 存储） */
  codexOAuthLogin: () => Promise<CodexOAuthLoginResult>

  /** 取消进行中的 ChatGPT (Codex) OAuth 登录 */
  codexOAuthCancel: () => Promise<void>

  /** 发起 xAI（Grok/X 订阅）OAuth 登录 */
  xaiOAuthLogin: () => Promise<XaiOAuthLoginResult>

  /** 取消进行中的 xAI OAuth 登录 */
  xaiOAuthCancel: () => Promise<void>

  /** 订阅登录期间，接收 xAI device code 与授权链接。返回取消订阅函数。 */
  onXaiOAuthDeviceCode: (callback: (deviceCode: XaiOAuthDeviceCode) => void) => () => void

  // ===== 教程 =====

  /** 获取教程内容 */
  getTutorialContent: () => Promise<string | null>

  // ===== 附件管理相关 =====

  /** 读取附件（返回 base64 字符串） */
  readAttachment: (localPath: string) => Promise<string>

  /** 另存图片到用户选择的位置（原生 Save As 对话框） */
  saveImageAs: (localPath: string, defaultFilename: string) => Promise<boolean>

  /** 保存应用内置资源文件到用户选择的位置（原生 Save As 对话框） */
  saveResourceFileAs: (resourceRelativePath: string, defaultFilename: string) => Promise<boolean>

  /** 将 Memory 导出内容保存到用户选择的位置（原生 Save As 对话框） */
  saveMemoryExport: (input: import('@copis/shared').MemoryExportFileInput) => Promise<boolean>

  /** 打开文件选择对话框 */
  openFileDialog: () => Promise<FileDialogResult>

  // ===== 用户档案相关 =====

  /** 获取用户档案 */
  getUserProfile: () => Promise<UserProfile>

  /** 更新用户档案 */
  updateUserProfile: (updates: Partial<UserProfile>) => Promise<UserProfile>

  // ===== 应用设置相关 =====

  /** 获取应用设置 */
  getSettings: () => Promise<AppSettings>

  /** 更新应用设置 */
  updateSettings: (updates: Partial<AppSettings>) => Promise<AppSettings>

  /** 同步更新应用设置（用于 beforeunload 场景） */
  updateSettingsSync: (updates: Partial<AppSettings>) => boolean

  /** 获取系统主题（是否深色模式） */
  getSystemTheme: () => Promise<boolean>

  /** 订阅系统主题变化事件（返回清理函数） */
  onSystemThemeChanged: (callback: (isDark: boolean) => void) => () => void

  /** 订阅用户手动切换主题事件（跨窗口同步，返回清理函数） */
  onThemeSettingsChanged: (callback: (payload: { themeMode: string; themeStyle: string; interfaceVariant?: string }) => void) => () => void

  // ===== Scratch Pad =====

  /** 从磁盘加载 scratch-pad.md */
  loadScratchPad: () => Promise<string>

  /** 异步保存内容到 scratch-pad.md */
  saveScratchPad: (content: string) => Promise<boolean>

  /** 同步保存内容到 scratch-pad.md（beforeunload 场景） */
  saveScratchPadSync: (content: string) => boolean

  /** 导出 ScratchPad 内容为 Markdown 文件到指定目录 */
  exportScratchPad: (markdown: string, dirPath: string, filename: string) => Promise<string>

  /** 打开原生保存对话框，返回用户选择的路径 */
  chooseExportPath: (defaultName: string) => Promise<string | null>

  /** 将图片 data URL 写入系统剪贴板 */
  copyImageToClipboard: (dataUrl: string) => Promise<{ success: boolean; message?: string }>

  // ===== 应用图标切换 =====

  /** 设置应用图标变体（传入 variant ID，如 'blue'、'cyberpunk'，'default' 恢复默认） */
  setAppIcon: (variantId: string) => Promise<boolean>

  /** 设置 Dock/Launcher 角标数量（0 表示清除） */
  setDockBadgeCount: (count: number) => Promise<boolean>

  // ===== 环境检测相关 =====

  /** 执行环境检测 */
  checkEnvironment: () => Promise<EnvironmentCheckResult>

  // ===== 第三方安装包（Git / Node.js）相关 =====

  /** 获取安装包清单（远程，失败回退内置） */
  fetchInstallerManifest: () => Promise<InstallerManifest>

  /** 开始下载指定安装包，resolve 时文件已落地并通过 sha256 校验 */
  downloadInstaller: (req: InstallerDownloadRequest) => Promise<InstallerDownloadResult>

  /** 取消指定 key 的进行中下载 */
  cancelInstallerDownload: (key: string) => Promise<boolean>

  /** 拉起已下载的安装程序（等效双击） */
  launchInstaller: (filePath: string) => Promise<void>

  /** 订阅下载进度事件，返回取消订阅函数 */
  onInstallerProgress: (
    callback: (payload: InstallerProgressPayload) => void,
  ) => () => void

  // ===== Copis 功能模块相关 =====

  /** 获取当前已安装的功能模块状态 */
  listFunctionalModules: () => Promise<FunctionalModuleStatus[]>

  /** 查询指定功能模块的最新版本 */
  checkFunctionalModule: (name: FunctionalModuleName) => Promise<FunctionalModuleStatus>

  /** 下载、校验并激活指定功能模块 */
  installFunctionalModule: (input: FunctionalModuleInstallInput) => Promise<FunctionalModuleStatus>

  /** 订阅功能模块安装进度，返回取消订阅函数 */
  onFunctionalModuleProgress: (
    callback: (payload: FunctionalModuleProgressPayload) => void,
  ) => () => void

  /** 登录后检查并更新全部必选功能模块 */
  ensureRequiredFunctionalModules: () => Promise<FunctionalModuleStatus[]>

  /** 订阅登录后功能模块启动聚合进度，返回取消订阅函数 */
  onFunctionalModuleStartupProgress: (
    callback: (payload: FunctionalModuleStartupProgressPayload) => void,
  ) => () => void

  // ===== 代理配置相关 =====

  /** 获取代理配置 */
  getProxySettings: () => Promise<ProxyConfig>

  /** 更新代理配置 */
  updateProxySettings: (config: ProxyConfig) => Promise<void>

  /** 检测系统代理 */
  detectSystemProxy: () => Promise<SystemProxyDetectResult>

  // ===== Agent 会话管理相关 =====

  /** 获取 Agent 会话列表 */
  listAgentSessions: () => Promise<AgentSessionMeta[]>

  /** 创建 Agent 会话 */
  createAgentSession: (title?: string, channelId?: string, workspaceId?: string, modelId?: string, expertTeamSession?: AgentExpertTeamSession, expertTeamSetup?: boolean) => Promise<AgentSessionMeta>

  /** 创建基于父 Agent 历史的右侧问答子会话 */
  createAgentSideQuestionSession: (input: CreateAgentSideQuestionSessionInput) => Promise<AgentSideQuestionSessionResult>

  /** 获取 Agent 会话 SDKMessage（Phase 4 新格式） */
  getAgentSessionSDKMessages: (id: string) => Promise<SDKMessage[]>

  /** 更新 Agent 会话标题 */
  updateAgentSessionTitle: (id: string, title: string) => Promise<AgentSessionMeta>

  /** 切换 Agent 会话 runtime */
  updateSessionAgentRuntime: (sessionId: string, runtime: AgentRuntime) => Promise<AgentSessionMeta>

  /** 切换当前会话的 ChatGPT Codex Fast Mode */
  updateSessionCodexFastMode: (sessionId: string, enabled: boolean) => Promise<AgentSessionMeta>

  /** 切换当前会话的 Composer 高级授权（控制 Git/SSH 命令） */
  updateSessionAdvancedAuthorization: (sessionId: string, enabled: boolean) => Promise<AgentSessionMeta>

  /** 切换当前会话的 Copis Working 模式 */
  updateSessionWorkingMode: (sessionId: string, mode: import('@copis/shared').WorkingMode, channelId?: string, modelId?: string) => Promise<AgentSessionMeta>

  /** 查询 Pi catalog 或专属 profile 支持的会话级推理档位 */
  getPiReasoningCapability: (channelId: string, modelId: string) => Promise<import('@copis/shared').ReasoningCapability | undefined>

  /** 更新当前会话的推理深度 */
  updateSessionReasoningLevel: (sessionId: string, thinkingLevel: AgentThinkingLevel) => Promise<AgentSessionMeta>

  /** 更新 Agent 会话模型选择 */
  updateAgentSessionModel: (id: string, channelId?: string, modelId?: string) => Promise<AgentSessionMeta>

  /** 删除 Agent 会话 */
  deleteAgentSession: (id: string) => Promise<void>

  /** 切换 Agent 会话置顶状态 */
  togglePinAgentSession: (id: string) => Promise<AgentSessionMeta>

  /** 切换 Agent 会话星标状态 */
  toggleStarAgentSession: (id: string) => Promise<AgentSessionMeta>

  /** 清除 Agent 会话完成状态（兼容清除旧版 manualWorking） */
  clearAgentCompletionState: (id: string) => Promise<AgentSessionMeta>

  /** 切换 Agent 会话归档状态 */
  toggleArchiveAgentSession: (id: string) => Promise<AgentSessionMeta>

  /** 搜索 Agent 会话消息内容 */
  searchAgentSessionMessages: (query: string) => Promise<AgentMessageSearchResult[]>

  /** 搜索可引用的 Agent 会话；省略 workspaceId 时跨工作区搜索。 */
  searchAgentSessionReferences: (input: AgentSessionReferenceSearchInput) => Promise<AgentSessionReferenceSearchResult[]>

  /** 迁移 Agent 会话到另一个工作区 */
  moveAgentSessionToWorkspace: (input: MoveSessionToWorkspaceInput) => Promise<AgentSessionMeta>

  /** 分叉 Agent 会话 */
  forkAgentSession: (input: ForkSessionInput) => Promise<AgentSessionMeta>

  /** 快照回退（同一会话内回退到指定点，恢复文件 + 截断对话） */
  rewindSession: (input: RewindSessionInput) => Promise<RewindSessionResult>

  /** 生成 Agent 会话标题 */
  generateAgentTitle: (input: AgentGenerateTitleInput) => Promise<string | null>

  /** 发送 Agent 消息 */
  sendAgentMessage: (input: AgentSendInput) => Promise<void>

  /** 中止 Agent 执行 */
  stopAgent: (sessionId: string) => Promise<void>

  // ===== Agent 队列消息 =====

  /** 流式追加发送 Agent 消息（Agent 运行中） */
  queueAgentMessage: (input: AgentQueueMessageInput) => Promise<string>

  // ===== Agent 后台任务管理 =====

  /** 获取任务输出 */
  getTaskOutput: (input: GetTaskOutputInput) => Promise<GetTaskOutputResult>

  /** 停止任务 */
  stopTask: (input: StopTaskInput) => Promise<void>

  // ===== Agent 工作区管理相关 =====

  /** 获取 Agent 工作区列表 */
  listAgentWorkspaces: () => Promise<AgentWorkspace[]>

  /** 创建 Agent 工作区 */
  createAgentWorkspace: (input: CreateAgentWorkspaceInput) => Promise<AgentWorkspace>

  /** 创建项目及其首个 Agent 会话 */
  createAgentProject: (input: CreateAgentWorkspaceInput, channelId?: string, modelId?: string) => Promise<CreateAgentProjectResult>

  /** 更新 Agent 工作区 */
  updateAgentWorkspace: (id: string, updates: import('@copis/shared').UpdateAgentWorkspaceInput) => Promise<AgentWorkspace>

  /** 将本地项目关联到一个已存在的目录，保留项目和会话。 */
  relinkAgentWorkspaceProjectRoot: (id: string, projectRootPath: string) => Promise<AgentWorkspace>

  /** 在丢失的本地项目原路径新建空目录。 */
  restoreAgentWorkspaceProjectRoot: (id: string) => Promise<AgentWorkspace>

  /** 删除 Agent 工作区 */
  deleteAgentWorkspace: (id: string) => Promise<void>

  /** 重排工作区顺序 */
  reorderAgentWorkspaces: (orderedIds: string[]) => Promise<AgentWorkspace[]>

  // ===== 工作区能力（MCP + Skill） =====

  /** 获取工作区能力摘要 */
  getWorkspaceCapabilities: (workspaceSlug: string) => Promise<WorkspaceCapabilities>

  /** 获取工作区 MCP 配置 */
  getWorkspaceMcpConfig: (workspaceSlug: string) => Promise<WorkspaceMcpConfig>

  /** 保存工作区 MCP 配置 */
  saveWorkspaceMcpConfig: (workspaceSlug: string, config: WorkspaceMcpConfig) => Promise<void>

  /** 测试 MCP 服务器连接 */
  testMcpServer: (name: string, entry: import('@copis/shared').McpServerEntry) => Promise<{ success: boolean; message: string }>

  /** 启用或关闭 Copis 内置 MCP */
  setBuiltinMcpEnabled: (workspaceSlug: string, id: string, enabled: boolean) => Promise<WorkspaceCapabilities>

  /** 获取工作区 Skill 列表（含活跃和不活跃） */
  getWorkspaceSkills: (workspaceSlug: string) => Promise<SkillMeta[]>

  /** 获取工作区 Skills 目录绝对路径 */
  getWorkspaceSkillsDir: (workspaceSlug: string) => Promise<string>

  /** 删除工作区 Skill */
  deleteWorkspaceSkill: (workspaceSlug: string, skillSlug: string) => Promise<void>

  /** 切换工作区 Skill 启用/禁用 */
  toggleWorkspaceSkill: (workspaceSlug: string, skillSlug: string, enabled: boolean) => Promise<void>

  /** 获取其他工作区的 Skill 列表 */
  getOtherWorkspaceSkills: (currentSlug: string) => Promise<OtherWorkspaceSkillsGroup[]>

  /** 获取默认 Skills 的 slug 列表（来自 ~/.copis/default-skills/） */
  getDefaultSkillSlugs: () => Promise<string[]>

  /** 从其他工作区导入 Skill */
  importSkillFromWorkspace: (targetSlug: string, sourceSlug: string, skillSlug: string) => Promise<SkillMeta>

  /** 从源工作区同步更新已导入的 Skill */
  updateSkillFromSource: (targetSlug: string, skillSlug: string) => Promise<SkillMeta>

  /** 读取 SKILL.md 全文内容 */
  readSkillContent: (workspaceSlug: string, skillSlug: string) => Promise<string>

  /** 写入 SKILL.md 全文内容 */
  writeSkillContent: (workspaceSlug: string, skillSlug: string, content: string) => Promise<void>

  /** 列出 Skill 目录下的子文件树（不含 SKILL.md） */
  listSkillFiles: (workspaceSlug: string, skillSlug: string) => Promise<import('@copis/shared').SkillFileNode[]>

  /** 读取 Skill 目录下的子文件内容 */
  readSkillFile: (workspaceSlug: string, skillSlug: string, relativePath: string) => Promise<import('@copis/shared').SkillFileContent>

  /** 写入 Skill 目录下的子文件内容（文本） */
  writeSkillFile: (workspaceSlug: string, skillSlug: string, relativePath: string, content: string) => Promise<void>

  /** 在 Skill 目录下创建文件或目录 */
  createSkillEntry: (workspaceSlug: string, skillSlug: string, relativePath: string, type: 'file' | 'directory') => Promise<void>

  /** 删除 Skill 目录下的文件或目录 */
  deleteSkillEntry: (workspaceSlug: string, skillSlug: string, relativePath: string) => Promise<void>

  /** 重命名/移动 Skill 目录下的文件或目录 */
  renameSkillEntry: (workspaceSlug: string, skillSlug: string, fromRelative: string, toRelative: string) => Promise<void>

  /** 订阅 Agent 流式事件（返回清理函数） */
  onAgentStreamEvent: (callback: (event: AgentStreamEvent) => void) => () => void

  /** 订阅 Agent 流式完成事件 */
  onAgentStreamComplete: (callback: (data: AgentStreamCompletePayload) => void) => () => void

  /** 订阅 Agent 流式错误事件 */
  onAgentStreamError: (callback: (data: { sessionId: string; error: string }) => void) => () => void

  /** 订阅 Agent 标题自动更新事件 */
  onAgentTitleUpdated: (callback: (data: { sessionId: string; title: string }) => void) => () => void

  // ===== Agent 权限系统 =====

  /** 响应权限请求 */
  respondPermission: (response: PermissionResponse) => Promise<void>

  /** 热切换指定会话的权限模式（运行中生效，仅影响该 session） */
  updateSessionPermissionMode: (sessionId: string, mode: CopisPermissionMode) => Promise<void>

  // ===== Agent 工具管理 =====

  /** 获取所有工具信息 */
  getAgentTools: () => Promise<AgentToolInfo[]>

  /** 获取工具凭据 */
  getAgentToolCredentials: (toolId: string) => Promise<Record<string, string>>

  /** 更新工具开关状态 */
  updateAgentToolState: (toolId: string, state: AgentToolState) => Promise<void>

  /** 更新工具凭据 */
  updateAgentToolCredentials: (toolId: string, credentials: Record<string, string>) => Promise<void>

  /** 创建自定义工具 */
  createCustomAgentTool: (meta: AgentToolMeta) => Promise<void>

  /** 删除自定义工具 */
  deleteCustomAgentTool: (toolId: string) => Promise<void>

  /** 监听自定义工具配置变更 */
  onAgentToolChanged: (callback: () => void) => () => void

  /** 测试工具连接 */
  testAgentTool: (toolId: string) => Promise<{ success: boolean; message: string }>

  // ===== AskUserQuestion 交互式问答 =====

  /** 响应 AskUser 请求 */
  respondAskUser: (response: AskUserResponse) => Promise<void>

  // ===== ExitPlanMode 计划审批 =====

  /** 响应 ExitPlanMode 请求 */
  respondExitPlanMode: (response: ExitPlanModeResponse) => Promise<void>

  /** 获取所有待处理的交互请求快照（渲染进程重载后恢复状态） */
  getPendingRequests: () => Promise<PendingRequestsSnapshot>

  // ===== Agent 附件 =====

  /** 保存文件到 Agent session 工作目录 */
  saveFilesToAgentSession: (input: AgentSaveFilesInput) => Promise<AgentSavedFile[]>

  /** 保存文件到工作区文件目录 */
  saveFilesToWorkspaceFiles: (input: AgentSaveWorkspaceFilesInput) => Promise<AgentSavedFile[]>

  /** 获取工作区文件目录路径 */
  getWorkspaceFilesPath: (workspaceSlug: string) => Promise<string>

  /** 打开文件夹选择对话框 */
  openFolderDialog: () => Promise<{ path: string; name: string } | null>

  /** 打开支持文件与文件夹混合选择的 Composer 对话框 */
  openFileOrFolderDialog: () => Promise<FileOrFolderDialogResult>

  /** 附加外部目录到 Agent 会话 */
  attachDirectory: (input: AgentAttachDirectoryInput) => Promise<string[]>

  /** 移除会话的附加目录 */
  detachDirectory: (input: AgentAttachDirectoryInput) => Promise<string[]>

  /** 附加外部文件到 Agent 会话 */
  attachFile: (input: AgentAttachFileInput) => Promise<string[]>

  /** 移除会话的附加文件 */
  detachFile: (input: AgentAttachFileInput) => Promise<string[]>

  /** 附加外部目录到工作区（所有会话可访问） */
  attachWorkspaceDirectory: (input: WorkspaceAttachDirectoryInput) => Promise<string[]>

  /** 移除工作区的附加目录 */
  detachWorkspaceDirectory: (input: WorkspaceAttachDirectoryInput) => Promise<string[]>

  /** 附加外部文件到工作区（所有会话可访问） */
  attachWorkspaceFile: (input: WorkspaceAttachFileInput) => Promise<string[]>

  /** 移除工作区的附加文件 */
  detachWorkspaceFile: (input: WorkspaceAttachFileInput) => Promise<string[]>

  /** 获取工作区附加目录列表 */
  getWorkspaceDirectories: (workspaceSlug: string) => Promise<string[]>

  /** 获取工作区附加文件列表 */
  getWorkspaceAttachedFiles: (workspaceSlug: string) => Promise<string[]>
  /** 获取工作区 worktree 仓库配置列表 */
  getWorktreeRepos: (workspaceSlug: string) => Promise<import('@copis/shared').WorkspaceWorktreeRepo[]>
  /** 添加 worktree 仓库到工作区配置 */
  addWorktreeRepo: (workspaceSlug: string, repo: import('@copis/shared').WorkspaceWorktreeRepo) => Promise<import('@copis/shared').WorkspaceWorktreeRepo[]>
  /** 从工作区配置移除 worktree 仓库 */
  removeWorktreeRepo: (workspaceSlug: string, repoPath: string) => Promise<import('@copis/shared').WorkspaceWorktreeRepo[]>

  // ===== Agent 文件系统操作 =====

  /** 获取 session 工作路径 */
  getAgentSessionPath: (workspaceId: string, sessionId: string) => Promise<string | null>

  /** 列出目录内容 */
  listDirectory: (dirPath: string, access?: import('@copis/shared').FileAccessOptions) => Promise<FileEntry[]>

  /** 删除文件/目录 */
  deleteFile: (filePath: string, access?: import('@copis/shared').FileAccessOptions) => Promise<void>

  /** 用系统默认应用打开文件 */
  openFile: (filePath: string, access?: import('@copis/shared').FileAccessOptions) => Promise<void>

  /** 将剪贴板文本写入临时预览文件并返回绝对路径 */
  writeClipboardPreview: (filename: string, content: string) => Promise<string>

  /** 用系统默认应用打开任意文件（无工作区限制） */
  systemOpenFile: (filePath: string, appName?: string, access?: import('@copis/shared').FileAccessOptions) => Promise<void>

  /** 扫描系统中可用的编辑器应用（仅 macOS） */
  scanEditors: () => Promise<import('@copis/shared').EditorApp[]>

  /** 查询本机为该文件类型注册的默认打开应用（含图标 dataURL） */
  getDefaultAppForFile: (filePath: string, access?: import('@copis/shared').FileAccessOptions) => Promise<import('@copis/shared').DefaultAppInfo | null>

  /** 在系统文件管理器中显示文件 */
  showInFolder: (filePath: string, access?: import('@copis/shared').FileAccessOptions) => Promise<void>

  /** 使用系统终端打开文件夹 */
  openFolderInTerminal: (folderPath: string) => Promise<void>

  /** 在系统文件管理器中显示文件（无工作区限制，支持候选基础目录） */
  showItemInFolder: (filePath: string, candidateBasePaths?: string[]) => Promise<boolean>

  /** 解析文件路径并读取内容（供内联预览使用） */
  resolveAndReadFile: (filePath: string, access?: import('@copis/shared').FileAccessOptions) => Promise<{ resolvedPath: string; content: string } | null>

  /** 写入文本文件（供 Markdown 内联编辑使用） */
  writeTextFile: (filePath: string, content: string, access?: import('@copis/shared').FileAccessOptions) => Promise<boolean>

  /** 仅解析文件路径（供 PDF/图片等用 file:// 加载） */
  resolveFilePath: (filePath: string, access?: import('@copis/shared').FileAccessOptions) => Promise<import('@copis/shared').ResolvedFileUrl | null>

  /** 为内联 PDF 预览生成临时 HTML 文件，返回文件路径 */
  preparePdfPreview: (filePath: string, access?: import('@copis/shared').FileAccessOptions) => Promise<{ tmpHtmlUrl: string } | null>

  /** 读取文件为 base64（带路径校验，供内联图片预览等） */
  readBinaryBase64: (filePath: string, access?: import('@copis/shared').FileAccessOptions, maxSize?: number) => Promise<string | null>

  /** DOCX 转 HTML（内联预览） */
  docxToHtml: (filePath: string, access?: import('@copis/shared').FileAccessOptions) => Promise<{ resolvedPath: string; html: string } | null>

  /** XLSX/PPTX 转 HTML（内联预览） */
  officeToHtml: (filePath: string, access?: import('@copis/shared').FileAccessOptions) => Promise<import('@copis/shared').OfficePreviewResult | null>

  /** 截图导出：将 HTML 渲染为 PNG 并复制到剪贴板或保存文件 */
  screenshotCapture: (input: { html: string; isDark: boolean; width?: number; mode: 'clipboard' | 'file'; css?: string; themeClass?: string }) => Promise<{ success: boolean; message: string; filePath?: string }>

  /** 重命名文件/目录 */
  renameFile: (filePath: string, newName: string, access?: import('@copis/shared').FileAccessOptions) => Promise<void>

  /** 移动文件/目录到目标目录 */
  moveFile: (filePath: string, targetDir: string, access?: import('@copis/shared').FileAccessOptions) => Promise<void>

  /** 列出附加目录内容 */
  listAttachedDirectory: (dirPath: string, access?: import('@copis/shared').FileAccessOptions) => Promise<FileEntry[]>

  /** 读取附加目录文件内容为 base64（限制在已附加目录范围内） */
  readAttachedFile: (filePath: string, sessionId?: string, workspaceSlug?: string) => Promise<string>

  /** 在文件管理器中显示附加目录文件 */
  showAttachedInFolder: (filePath: string, access?: import('@copis/shared').FileAccessOptions) => Promise<void>

  /** 重命名附加目录文件/目录（无工作区路径限制） */
  renameAttachedFile: (filePath: string, newName: string, access?: import('@copis/shared').FileAccessOptions) => Promise<void>

  /** 移动附加目录文件/目录（无工作区路径限制） */
  moveAttachedFile: (filePath: string, targetDir: string, access?: import('@copis/shared').FileAccessOptions) => Promise<void>

  /** 检查路径类型（文件 or 目录），用于拖拽检测 */
  checkPathsType: (paths: string[]) => Promise<{ directories: string[]; files: string[] }>

  /** 获取拖拽文件的本地路径（替代已废弃的 File.path） */
  getPathForFile: (file: File) => string

  /** 搜索工作区文件（用于 @ 引用，支持附加目录） */
  searchWorkspaceFiles: (rootPath: string, query: string, limit?: number, additionalPaths?: string[], sessionPaths?: string[]) => Promise<FileSearchResult>

  // ===== 系统提示词管理 =====

  /** 获取系统提示词配置 */
  getSystemPromptConfig: () => Promise<SystemPromptConfig>

  /** 创建提示词 */
  createSystemPrompt: (input: SystemPromptCreateInput) => Promise<SystemPrompt>

  /** 更新提示词 */
  updateSystemPrompt: (id: string, input: SystemPromptUpdateInput) => Promise<SystemPrompt>

  /** 删除提示词 */
  deleteSystemPrompt: (id: string) => Promise<void>

  /** 更新追加日期时间和用户名开关 */
  updateAppendSetting: (enabled: boolean) => Promise<void>

  /** 设置默认提示词 */
  setDefaultPrompt: (id: string | null) => Promise<void>

  // ===== 自动更新 =====

  /** 更新 API */
  updater?: {
    checkForUpdates: () => Promise<void>
    getStatus: () => Promise<{
      status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'
      version?: string
      releaseNotes?: string
      progress?: { percent: number; transferred: number; total: number; bytesPerSecond: number }
      error?: string
    }>
    onStatusChanged: (callback: (status: {
      status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'
      version?: string
      releaseNotes?: string
      progress?: { percent: number; transferred: number; total: number; bytesPerSecond: number }
      error?: string
    }) => void) => () => void
    /** 在所有运行中的 Agent 结束后重启并安装更新 */
    installWhenIdle: () => Promise<boolean>
    /** 取消尚未执行的空闲安装请求 */
    cancelIdleInstall: () => Promise<void>
  }

  // GitHub Release
  getLatestRelease: () => Promise<GitHubRelease | null>
  listReleases: (options?: GitHubReleaseListOptions) => Promise<GitHubRelease[]>
  getReleaseByTag: (tag: string) => Promise<GitHubRelease | null>

  // 工作区文件变化通知
  onCapabilitiesChanged: (callback: () => void) => () => void
  onWorkspaceFilesChanged: (callback: () => void) => () => void

  // ===== 飞书集成 =====

  /** 获取飞书配置 */
  getFeishuConfig: () => Promise<FeishuConfig>
  /** 获取解密后的 App Secret */
  getDecryptedFeishuSecret: () => Promise<string>
  /** 保存飞书配置（appSecret 为明文） */
  saveFeishuConfig: (input: FeishuConfigInput) => Promise<FeishuConfig>
  /** 测试飞书连接 */
  testFeishuConnection: (appId: string, appSecret: string) => Promise<FeishuTestResult>
  /** 启动飞书 Bridge */
  startFeishuBridge: () => Promise<void>
  /** 停止飞书 Bridge */
  stopFeishuBridge: () => Promise<void>
  /** 获取飞书 Bridge 状态 */
  getFeishuStatus: () => Promise<FeishuBridgeState>
  /** 获取绑定列表（包含已归档，调用方按视图过滤） */
  listFeishuBindings: () => Promise<FeishuChatBinding[]>
  /** 更新绑定（修改工作区/会话） */
  updateFeishuBinding: (input: FeishuUpdateBindingInput) => Promise<FeishuChatBinding | null>
  /** 移除绑定 */
  removeFeishuBinding: (chatId: string) => Promise<boolean>
  /** 上报用户在场状态 */
  reportFeishuPresence: (report: FeishuPresenceReport) => Promise<void>
  /** 订阅飞书 Bridge 状态变化 */
  onFeishuStatusChanged: (callback: (state: FeishuBridgeState) => void) => () => void

  // --- 多 Bot v2 API ---

  /** 获取多 Bot 配置 */
  getFeishuMultiConfig: () => Promise<import('@copis/shared').FeishuMultiBotConfig>
  /** 保存单个 Bot 配置 */
  saveFeishuBotConfig: (input: import('@copis/shared').FeishuBotConfigInput) => Promise<import('@copis/shared').FeishuBotConfig>
  /** 获取单个 Bot 解密后的 App Secret */
  getDecryptedFeishuBotSecret: (botId: string) => Promise<string>
  /** 删除 Bot */
  removeFeishuBot: (botId: string) => Promise<boolean>
  /** 启动单个 Bot */
  startFeishuBot: (botId: string) => Promise<void>
  /** 停止单个 Bot */
  stopFeishuBot: (botId: string) => Promise<void>
  /** 获取多 Bot 状态 */
  getFeishuMultiStatus: () => Promise<import('@copis/shared').FeishuMultiBridgeState>

  // --- 扫码注册 ---

  /** 启动扫码注册流程，等待用户扫码 + 飞书确认后返回 App ID/Secret */
  registerFeishuApp: () => Promise<import('@copis/shared').FeishuRegisterAppResult>
  /** 取消正在进行的扫码注册流程 */
  cancelFeishuRegistration: () => Promise<void>
  /** 监听二维码 URL 生成 */
  onFeishuRegisterQrcode: (callback: (payload: import('@copis/shared').FeishuRegisterAppQRCode) => void) => () => void
  /** 监听注册流程状态变化 */
  onFeishuRegisterStatus: (callback: (payload: import('@copis/shared').FeishuRegisterAppStatus) => void) => () => void

  // ===== 钉钉集成 =====

  /** 获取钉钉配置 */
  getDingTalkConfig: () => Promise<DingTalkConfig>
  /** 获取解密后的 Client Secret */
  getDecryptedDingTalkSecret: () => Promise<string>
  /** 保存钉钉配置（clientSecret 为明文） */
  saveDingTalkConfig: (input: DingTalkConfigInput) => Promise<DingTalkConfig>
  /** 测试钉钉连接 */
  testDingTalkConnection: (clientId: string, clientSecret: string) => Promise<DingTalkTestResult>
  /** 启动钉钉 Bridge */
  startDingTalkBridge: () => Promise<void>
  /** 停止钉钉 Bridge */
  stopDingTalkBridge: () => Promise<void>
  /** 获取钉钉 Bridge 状态 */
  getDingTalkStatus: () => Promise<DingTalkBridgeState>
  /** 订阅钉钉 Bridge 状态变化 */
  onDingTalkStatusChanged: (callback: (state: DingTalkBridgeState) => void) => () => void

  // --- 钉钉多 Bot v2 API ---

  /** 获取多 Bot 配置 */
  getDingTalkMultiConfig: () => Promise<import('@copis/shared').DingTalkMultiBotConfig>
  /** 保存单个 Bot 配置 */
  saveDingTalkBotConfig: (input: import('@copis/shared').DingTalkBotConfigInput) => Promise<import('@copis/shared').DingTalkBotConfig>
  /** 获取单个 Bot 解密后的 Client Secret */
  getDecryptedDingTalkBotSecret: (botId: string) => Promise<string>
  /** 删除 Bot */
  removeDingTalkBot: (botId: string) => Promise<boolean>
  /** 启动单个 Bot */
  startDingTalkBot: (botId: string) => Promise<void>
  /** 停止单个 Bot */
  stopDingTalkBot: (botId: string) => Promise<void>
  /** 获取多 Bot 状态 */
  getDingTalkMultiStatus: () => Promise<import('@copis/shared').DingTalkMultiBridgeState>

  // ===== 微信集成 =====

  /** 获取微信配置 */
  getWeChatConfig: () => Promise<WeChatConfig>
  /** 开始扫码登录 */
  startWeChatLogin: () => Promise<void>
  /** 登出微信 */
  logoutWeChat: () => Promise<void>
  /** 启动微信 Bridge（用已有凭证） */
  startWeChatBridge: () => Promise<void>
  /** 停止微信 Bridge */
  stopWeChatBridge: () => Promise<void>
  /** 获取微信 Bridge 状态 */
  getWeChatStatus: () => Promise<WeChatBridgeState>
  /** 订阅微信 Bridge 状态变化 */
  onWeChatStatusChanged: (callback: (state: WeChatBridgeState) => void) => () => void

  /** 订阅菜单关闭标签页事件（Cmd+W 被菜单拦截后转发） */
  onMenuCloseTab: (callback: () => void) => () => void

  // ===== 快速任务窗口 =====

  /** 提交快速任务 */
  submitQuickTask: (input: QuickTaskSubmitInput) => Promise<void>
  /** 隐藏快速任务窗口 */
  hideQuickTask: () => Promise<void>
  /** 重新注册全局快捷键（设置变更后） */
  reregisterGlobalShortcuts: () => Promise<Record<string, boolean>>
  /** 获取全局快捷键当前是否已被系统成功注册 */
  getGlobalShortcutRegistrationStatus: () => Promise<Record<string, boolean>>
  /** 订阅快速任务窗口聚焦事件 */
  onQuickTaskFocus: (callback: () => void) => () => void
  /** 订阅快速任务打开会话事件（主窗口接收，由渲染进程负责创建会话） */
  onQuickTaskOpenSession: (callback: (data: QuickTaskOpenSessionData) => void) => () => void

  // ===== 语音输入 =====

  /** 获取语音输入设置 */
  getVoiceDictationSettings: () => Promise<VoiceDictationSettings>
  /** 更新语音输入设置 */
  updateVoiceDictationSettings: (updates: VoiceDictationSettingsUpdate) => Promise<VoiceDictationSettings>
  /** 测试语音输入连接 */
  testVoiceDictationConnection: (updates?: VoiceDictationSettingsUpdate) => Promise<VoiceDictationTestResult>
  /** 唤起或停止语音输入浮窗 */
  toggleVoiceDictation: () => Promise<void>
  /** 开始语音输入会话 */
  startVoiceDictation: (input: VoiceDictationStartInput) => Promise<void>
  /** 发送语音音频分片 */
  sendVoiceDictationAudio: (input: VoiceDictationAudioChunkInput) => Promise<void>
  /** 上报实时麦克风音量，用于外部应用听写状态条。 */
  reportVoiceDictationVolume: (volume: number) => void
  /** 上报实时转写，用于外部应用听写状态条。 */
  reportVoiceDictationTranscript: (text: string) => void
  /** 停止语音输入会话 */
  stopVoiceDictation: (input: VoiceDictationStopInput) => Promise<void>
  /** 取消语音输入会话 */
  cancelVoiceDictation: (input: VoiceDictationStopInput) => Promise<void>
  /** 输出最终语音文本 */
  commitVoiceDictation: (input: VoiceDictationCommitInput) => Promise<VoiceDictationCommitResult>
  /** 更新 Copis 输入框中的临时识别文本 */
  previewVoiceDictation: (input: VoiceDictationPreviewInput) => Promise<void>
  /** 隐藏语音输入窗口 */
  hideVoiceDictation: () => Promise<void>
  /** 调整语音输入窗口高度 */
  resizeVoiceDictation: (input: VoiceDictationResizeInput) => Promise<void>
  /** 订阅语音输入窗口显示事件 */
  onVoiceDictationShown: (callback: () => void) => () => void
  /** 订阅语音输入停止请求事件 */
  onVoiceDictationToggleStop: (callback: () => void) => () => void
  /** 订阅语音输入转写事件 */
  onVoiceDictationTranscript: (callback: (event: VoiceDictationTranscriptEvent) => void) => () => void
  /** 订阅语音输入状态事件 */
  onVoiceDictationState: (callback: (event: VoiceDictationStateEvent) => void) => () => void
  /** 订阅外部应用的听写状态条事件 */
  onVoiceDictationIndicatorState: (callback: (event: VoiceDictationIndicatorEvent) => void) => () => void
  /** 订阅主窗口插入语音文本事件 */
  onVoiceDictationInsertText: (callback: (data: VoiceDictationTextEvent) => void) => () => void
  /** 订阅主窗口临时识别文本更新事件 */
  onVoiceDictationPreviewText: (callback: (data: VoiceDictationTextEvent) => void) => () => void
  /** 订阅主窗口撤销临时识别文本事件 */
  onVoiceDictationClearPreviewText: (callback: (data: Pick<VoiceDictationTextEvent, 'sessionId'>) => void) => () => void

  /** 检查麦克风权限状态 */
  checkMicrophonePermission: () => Promise<MicPermissionResult>
  /** 请求麦克风权限（仅 macOS 有效） */
  requestMicrophonePermission: () => Promise<MicPermissionResult>

  // ===== 菜单栏 =====

  /** 订阅菜单栏打开 Agent 会话事件 */
  onTrayOpenAgentSession: (callback: (data: TrayOpenAgentSessionData) => void) => () => void
  /** 订阅菜单栏创建会话事件 */
  onTrayCreateSession: (callback: () => void) => () => void

  // ===== 数据迁移 =====

  /** 获取工作区导出预览信息 */
  migrationGetExportPreview: (workspaceId: string) => Promise<unknown>
  /** 获取所有工作区的 Skills/MCP 预览（团队分发模式） */
  migrationGetShareExportPreview: () => Promise<unknown>
  /** 执行导出 */
  migrationExport: (options: unknown) => Promise<MigrationExportResult>
  /** 执行 v2 多工作区导出 */
  migrationExportV2: (options: unknown) => Promise<MigrationExportResult>
  /** 解析导入文件，返回预览信息 */
  migrationParseImportFile: (filePath: string) => Promise<unknown>
  /** 确认导入 */
  migrationConfirmImport: (options: unknown) => Promise<{ success: boolean }>
  /** 打开文件选择对话框（选择 .copis-backup/.copis-share，也兼容旧版 .proma-backup/.proma-share 文件） */
  migrationOpenFileDialog: () => Promise<string | null>
  /** 打开文件保存对话框（选择导出路径） */
  migrationSaveFileDialog: (mode: string) => Promise<string | null>
  /** 订阅双击迁移文件触发的导入事件 */
  onMigrationOpenImportFile: (callback: (data: { filePath: string }) => void) => () => void

  // ===== 存储管理 =====

  /** 获取各目录存储统计 */
  getStorageStats: () => Promise<unknown>
  /** 按选项清理存储 */
  cleanupStorage: (options: unknown) => Promise<unknown>
  /** 清理临时文件（快速） */
  cleanupTempStorage: () => Promise<unknown>
  /** 取消迁移导入（清理临时解压目录） */
  migrationCancelImport: (tempDir: string) => Promise<void>

  // ===== 定时任务（Automation）=====
  /** 获取全部定时任务 */
  listAutomations: () => Promise<Automation[]>
  /** 创建定时任务 */
  createAutomation: (input: CreateAutomationInput) => Promise<Automation>
  /** 更新定时任务 */
  updateAutomation: (input: UpdateAutomationInput) => Promise<Automation | undefined>
  /** 删除定时任务 */
  deleteAutomation: (id: string) => Promise<boolean>
  /** 切换启用/暂停 */
  toggleAutomation: (id: string, active: boolean) => Promise<Automation | undefined>
  /** 立即运行一次 */
  runAutomationNow: (id: string) => Promise<void>
  /** 订阅任务列表变更事件 */
  onAutomationChanged: (callback: () => void) => () => void

  // ===== 任务 / 日程（Planning）=====
  /** 打开或聚焦单例独立任务/日程窗口。 */
  openPlanningWindow: () => Promise<void>
  listTodos: (query?: TodoListQuery) => Promise<Todo[]>
  createTodo: (input: CreateTodoInput) => Promise<Todo>
  /** 在主进程原子地关联项目并创建 Todo 的 Agent 会话。 */
  startTodoAgent: (input: StartTodoAgentInput) => Promise<StartTodoAgentResult>
  /** 独立规划窗口启动 Todo 时由主窗口接收并打开对应 Agent 会话。 */
  onTodoAgentSessionReady: (callback: (activation: TodoAgentSessionActivation) => void) => () => void
  updateTodo: (input: UpdateTodoInput) => Promise<Todo | undefined>
  deleteTodo: (id: string) => Promise<boolean>
  listCalendarEvents: (query?: CalendarEventListQuery) => Promise<CalendarEvent[]>
  createCalendarEvent: (input: CreateCalendarEventInput) => Promise<CalendarEvent>
  updateCalendarEvent: (input: UpdateCalendarEventInput) => Promise<CalendarEvent | undefined>
  deleteCalendarEvent: (id: string) => Promise<boolean>
  listPlanningGroups: (scope: PlanningGroupScope) => Promise<PlanningGroup[]>
  createPlanningGroup: (input: CreatePlanningGroupInput) => Promise<PlanningGroup>
  updatePlanningGroup: (input: UpdatePlanningGroupInput) => Promise<PlanningGroup | undefined>
  deletePlanningGroup: (scope: PlanningGroupScope, id: string) => Promise<boolean>
  listPlanningTags: () => Promise<PlanningTag[]>
  listActivePlanningReminders: () => Promise<ActivePlanningReminder[]>
  acknowledgePlanningReminder: (id: string) => Promise<PlanningReminder | undefined>
  snoozePlanningReminder: (input: SnoozePlanningReminderInput) => Promise<PlanningReminder | undefined>
  onPlanningRemindersDue: (callback: (reminders: ActivePlanningReminder[]) => void) => () => void
  onPlanningChanged: (callback: (change: PlanningChange) => void) => () => void
  onPlanningAgentOperation: (callback: (operation: PlanningAgentOperation) => void) => () => void

}

interface MigrationExportResult {
  success: boolean
  filePath: string
  warnings?: string[]
}

/**
 * 实现 ElectronAPI 接口
 */
const electronAPI: ElectronAPI = {
  // 运行时
  getHttpApiWebToken: () => {
    const argument = process.argv.find((value) =>
      value.startsWith(HTTP_API_WEB_TOKEN_ARGUMENT_PREFIX),
    )
    return argument ? argument.slice(HTTP_API_WEB_TOKEN_ARGUMENT_PREFIX.length) : ''
  },

  getRuntimeStatus: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_RUNTIME_STATUS)
  },

  reinitRuntime: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.REINIT_RUNTIME)
  },

  getGitRepoStatus: (dirPath: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_GIT_REPO_STATUS, dirPath)
  },

  getUnstagedChanges: (dirPath: string, sessionPath?: string, workspaceFilesPath?: string, extraPaths?: string[], sessionId?: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_UNSTAGED_CHANGES, dirPath, sessionPath, workspaceFilesPath, extraPaths, sessionId)
  },

  getFileDiff: (input: import('@copis/shared').GetFileDiffInput) => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_FILE_DIFF, input)
  },

  getUntrackedContent: (input: import('@copis/shared').GetFileDiffInput) => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_UNTRACKED_CONTENT, input)
  },

  revertFile: (input: import('@copis/shared').RevertFileInput) => {
    return ipcRenderer.invoke(IPC_CHANNELS.REVERT_FILE, input)
  },

  getDiffContents: (input: import('@copis/shared').GetFileDiffInput) => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_DIFF_CONTENTS, input)
  },

  listWorktrees: (repoPath: string, sessionId: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.LIST_WORKTREES, repoPath, sessionId)
  },

  getWorktreeChanges: (worktreePath: string, baseBranch: string, sessionId: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_WORKTREE_CHANGES, worktreePath, baseBranch, sessionId)
  },

  openDetachedPreview: (input: DetachedPreviewWindowInput) => {
    return ipcRenderer.invoke(IPC_CHANNELS.OPEN_DETACHED_PREVIEW, input) as Promise<string | null>
  },

  getDetachedPreviewData: (previewId: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_DETACHED_PREVIEW_DATA, previewId) as Promise<DetachedPreviewWindowData | null>
  },

  // 通用工具
  openExternal: (url: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.OPEN_EXTERNAL, url)
  },

  writeClipboardText: (text: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.WRITE_CLIPBOARD_TEXT, text)
  },

  // 内嵌 Chromium 网页页签
  webTabs: {
    list: () => ipcRenderer.invoke(WEB_IPC_CHANNELS.LIST) as Promise<WebTabsSnapshot>,
    create: (input?: CreateWebTabInput) => ipcRenderer.invoke(WEB_IPC_CHANNELS.CREATE, input) as Promise<WebTabsSnapshot>,
    activate: (tabId: string | null) => ipcRenderer.invoke(WEB_IPC_CHANNELS.ACTIVATE, tabId) as Promise<WebTabsSnapshot>,
    close: (tabId: string) => ipcRenderer.invoke(WEB_IPC_CHANNELS.CLOSE, tabId) as Promise<WebTabsSnapshot>,
    navigate: (input: NavigateWebTabInput) => ipcRenderer.invoke(WEB_IPC_CHANNELS.NAVIGATE, input) as Promise<WebTabsSnapshot>,
    updateBounds: (input: UpdateWebTabBoundsInput) => ipcRenderer.invoke(WEB_IPC_CHANNELS.UPDATE_BOUNDS, input) as Promise<void>,
    bookmarksOpen: (input: OpenWebBookmarksWindowInput) => ipcRenderer.invoke(WEB_IPC_CHANNELS.BOOKMARKS_WINDOW_OPEN, input) as Promise<void>,
    bookmarksClose: () => ipcRenderer.invoke(WEB_IPC_CHANNELS.BOOKMARKS_WINDOW_CLOSE) as Promise<void>,
    bookmarksResize: (input: ResizeWebBookmarksWindowInput) => ipcRenderer.invoke(WEB_IPC_CHANNELS.BOOKMARKS_WINDOW_RESIZE, input) as Promise<void>,
    goBack: (tabId: string) => ipcRenderer.invoke(WEB_IPC_CHANNELS.GO_BACK, tabId) as Promise<WebTabsSnapshot>,
    goForward: (tabId: string) => ipcRenderer.invoke(WEB_IPC_CHANNELS.GO_FORWARD, tabId) as Promise<WebTabsSnapshot>,
    reload: (tabId: string) => ipcRenderer.invoke(WEB_IPC_CHANNELS.RELOAD, tabId) as Promise<WebTabsSnapshot>,
    bookmarksList: () => ipcRenderer.invoke(WEB_IPC_CHANNELS.BOOKMARKS_LIST) as Promise<WebBookmarksSnapshot>,
    bookmarksSave: (input: SaveWebBookmarkInput) => ipcRenderer.invoke(WEB_IPC_CHANNELS.BOOKMARKS_SAVE, input) as Promise<WebBookmarksSnapshot>,
    bookmarksRemove: (bookmarkId: string) => ipcRenderer.invoke(WEB_IPC_CHANNELS.BOOKMARKS_REMOVE, bookmarkId) as Promise<WebBookmarksSnapshot>,
    bookmarksGroupCreate: (input: CreateWebBookmarkGroupInput) => ipcRenderer.invoke(WEB_IPC_CHANNELS.BOOKMARK_GROUP_CREATE, input) as Promise<WebBookmarksSnapshot>,
    bookmarksGroupRename: (input: RenameWebBookmarkGroupInput) => ipcRenderer.invoke(WEB_IPC_CHANNELS.BOOKMARK_GROUP_RENAME, input) as Promise<WebBookmarksSnapshot>,
    bookmarksGroupRemove: (groupId: string) => ipcRenderer.invoke(WEB_IPC_CHANNELS.BOOKMARK_GROUP_REMOVE, groupId) as Promise<WebBookmarksSnapshot>,
    getProjectAssociation: (url: string) => ipcRenderer.invoke(WEB_IPC_CHANNELS.PROJECT_ASSOCIATION_GET, url) as Promise<WebPageProjectAssociation | null>,
    saveProjectAssociation: (input: SaveWebPageProjectAssociationInput) => ipcRenderer.invoke(WEB_IPC_CHANNELS.PROJECT_ASSOCIATION_SAVE, input) as Promise<WebPageProjectAssociation>,
    onChanged: (callback: (snapshot: WebTabsSnapshot) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshot: WebTabsSnapshot): void => callback(snapshot)
      ipcRenderer.on(WEB_IPC_CHANNELS.STATE_CHANGED, listener)
      return () => { ipcRenderer.removeListener(WEB_IPC_CHANNELS.STATE_CHANGED, listener) }
    },
  },

  // Browser Workflow：只暴露录制和状态控制，CDP 命令仅在主进程内部使用。
  browserWorkflow: {
    bindContext: (sessionId: string, context: BrowserAgentContext) => ipcRenderer.invoke(BROWSER_WORKFLOW_IPC_CHANNELS.BIND_CONTEXT, sessionId, context) as Promise<BrowserWorkflowStatus>,
    unbindContext: (sessionId: string) => ipcRenderer.invoke(BROWSER_WORKFLOW_IPC_CHANNELS.UNBIND_CONTEXT, sessionId) as Promise<void>,
    getStatus: (sessionId: string) => ipcRenderer.invoke(BROWSER_WORKFLOW_IPC_CHANNELS.STATUS, sessionId) as Promise<BrowserWorkflowStatus>,
    setControlMode: (sessionId: string, mode: BrowserPageControlMode) => ipcRenderer.invoke(BROWSER_WORKFLOW_IPC_CHANNELS.SET_CONTROL_MODE, sessionId, mode) as Promise<BrowserWorkflowStatus>,
    startRecording: (sessionId: string) => ipcRenderer.invoke(BROWSER_WORKFLOW_IPC_CHANNELS.START_RECORDING, sessionId) as Promise<BrowserWorkflowStatus>,
    stopRecording: (sessionId: string) => ipcRenderer.invoke(BROWSER_WORKFLOW_IPC_CHANNELS.STOP_RECORDING, sessionId) as Promise<BrowserWorkflowRecordingSummary>,
    stopRun: (sessionId: string) => ipcRenderer.invoke(BROWSER_WORKFLOW_IPC_CHANNELS.STOP_RUN, sessionId) as Promise<void>,
    continueRun: (sessionId: string) => ipcRenderer.invoke(BROWSER_WORKFLOW_IPC_CHANNELS.CONTINUE_RUN, sessionId) as Promise<void>,
    cancelRecording: (sessionId: string) => ipcRenderer.invoke(BROWSER_WORKFLOW_IPC_CHANNELS.CANCEL_RECORDING, sessionId) as Promise<void>,
    getDraft: (sessionId: string) => ipcRenderer.invoke(BROWSER_WORKFLOW_IPC_CHANNELS.DRAFT, sessionId) as Promise<BrowserWorkflowVersion | undefined>,
    approveDraft: (sessionId: string, name?: string, description?: string, unattendedAllowed?: boolean) => ipcRenderer.invoke(BROWSER_WORKFLOW_IPC_CHANNELS.APPROVE_DRAFT, sessionId, name, description, unattendedAllowed) as Promise<BrowserWorkflowManifest>,
    rejectDraft: (sessionId: string) => ipcRenderer.invoke(BROWSER_WORKFLOW_IPC_CHANNELS.REJECT_DRAFT, sessionId) as Promise<void>,
    onStatusChanged: (callback: (event: { sessionId: string; status: BrowserWorkflowStatus }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { sessionId: string; status: BrowserWorkflowStatus }): void => callback(payload)
      ipcRenderer.on(BROWSER_WORKFLOW_IPC_CHANNELS.STATUS_CHANGED, listener)
      return () => { ipcRenderer.removeListener(BROWSER_WORKFLOW_IPC_CHANNELS.STATUS_CHANGED, listener) }
    },
  },

  // 窗口控制
  windowMinimize: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MINIMIZE)
  },

  windowMaximize: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MAXIMIZE)
  },

  windowClose: (quitApp = false) => {
    return ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CLOSE, quitApp)
  },

  windowIsMaximized: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.WINDOW_IS_MAXIMIZED)
  },

  onWindowResize: (callback: () => void) => {
    const handler = (): void => callback()
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  },

  // Copis Working 后端
  getWorkingConfig: () => ipcRenderer.invoke(WORKING_IPC_CHANNELS.GET_CONFIG),
  getWorkingAuthState: () => ipcRenderer.invoke(WORKING_IPC_CHANNELS.GET_AUTH_STATE),
  loginWorking: (input: WorkingLoginInput) => ipcRenderer.invoke(WORKING_IPC_CHANNELS.LOGIN, input),
  registerWorking: (input: WorkingRegisterInput) => ipcRenderer.invoke(WORKING_IPC_CHANNELS.REGISTER, input),
  sendWorkingVerificationCode: (input: WorkingSendVerificationCodeInput) => ipcRenderer.invoke(WORKING_IPC_CHANNELS.SEND_VERIFICATION_CODE, input),
  verifyWorkingPasswordResetCode: (input: WorkingVerifyPasswordResetCodeInput) => ipcRenderer.invoke(WORKING_IPC_CHANNELS.VERIFY_PASSWORD_RESET_CODE, input),
  resetWorkingPassword: (input: WorkingPasswordResetInput) => ipcRenderer.invoke(WORKING_IPC_CHANNELS.RESET_PASSWORD, input),
  logoutWorking: () => ipcRenderer.invoke(WORKING_IPC_CHANNELS.LOGOUT),
  getWorkingCurrentUser: () => ipcRenderer.invoke(WORKING_IPC_CHANNELS.GET_CURRENT_USER),
  listWorkingWorkspaces: () => ipcRenderer.invoke(WORKING_IPC_CHANNELS.LIST_WORKSPACES),
  saveWorkingWorkspace: (input: WorkingWorkspaceInput) => ipcRenderer.invoke(WORKING_IPC_CHANNELS.SAVE_WORKSPACE, input),
  listWorkingSessions: () => ipcRenderer.invoke(WORKING_IPC_CHANNELS.LIST_SESSIONS),
  getWorkingSessionHistory: (runId: string, sessionId?: string) => ipcRenderer.invoke(WORKING_IPC_CHANNELS.GET_SESSION_HISTORY, runId, sessionId),
  listWorkingSkills: () => ipcRenderer.invoke(WORKING_IPC_CHANNELS.LIST_SKILLS),
  createWorkingFeedback: (input: WorkingFeedbackInput) => ipcRenderer.invoke(WORKING_IPC_CHANNELS.CREATE_FEEDBACK, input),
  getWorkingSettingsSnapshot: () => ipcRenderer.invoke(WORKING_IPC_CHANNELS.GET_SETTINGS_SNAPSHOT),
  checkInWorking: () => ipcRenderer.invoke(WORKING_IPC_CHANNELS.CHECK_IN),
  setWorkingReceiveChannel: (channel: WorkingReceiveChannel) => ipcRenderer.invoke(WORKING_IPC_CHANNELS.SET_RECEIVE_CHANNEL, channel),
  listWorkingOrders: (page?: number, pageSize?: number) => ipcRenderer.invoke(WORKING_IPC_CHANNELS.LIST_ORDERS, page, pageSize),
  deleteWorkingOrder: (orderId: number | string) => ipcRenderer.invoke(WORKING_IPC_CHANNELS.DELETE_ORDER, orderId),
  listWorkingDiamondPackages: () => ipcRenderer.invoke(WORKING_IPC_CHANNELS.LIST_DIAMOND_PACKAGES),
  getPendingWorkingDiamondPurchase: () => ipcRenderer.invoke(WORKING_IPC_CHANNELS.GET_PENDING_DIAMOND_PURCHASE),
  createWorkingDiamondPurchase: (packageId: number) => ipcRenderer.invoke(WORKING_IPC_CHANNELS.CREATE_DIAMOND_PURCHASE, packageId),
  createWorkingVipUpgrade: () => ipcRenderer.invoke(WORKING_IPC_CHANNELS.CREATE_VIP_UPGRADE),
  getWorkingOrderPayment: (orderId: WorkingPaymentIdentifier) => ipcRenderer.invoke(WORKING_IPC_CHANNELS.GET_ORDER_PAYMENT, orderId),
  checkWorkingPayment: (paymentId: WorkingPaymentIdentifier) => ipcRenderer.invoke(WORKING_IPC_CHANNELS.CHECK_PAYMENT, paymentId),
  cancelWorkingDiamondPayment: (paymentId: WorkingPaymentIdentifier) => ipcRenderer.invoke(WORKING_IPC_CHANNELS.CANCEL_DIAMOND_PAYMENT, paymentId),
  createWorkingAlipayPagePayOrder: (packageId: number) => ipcRenderer.invoke(WORKING_IPC_CHANNELS.CREATE_ALIPAY_PAGE_PAY_ORDER, packageId),
  checkWorkingAlipayPagePayOrder: (paymentId: WorkingPaymentIdentifier) => ipcRenderer.invoke(WORKING_IPC_CHANNELS.CHECK_ALIPAY_PAGE_PAY_ORDER, paymentId),

  // 渠道管理
  listChannels: () => {
    return ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.LIST)
  },

  createChannel: (input: ChannelCreateInput) => {
    return ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.CREATE, input)
  },

  updateChannel: (id: string, input: ChannelUpdateInput) => {
    return ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.UPDATE, id, input)
  },

  deleteChannel: (id: string) => {
    return ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.DELETE, id)
  },

  decryptApiKey: (channelId: string) => {
    return ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.DECRYPT_KEY, channelId)
  },

  testChannel: (channelId: string) => {
    return ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.TEST, channelId)
  },

  testChannelDirect: (input: ChannelDirectTestInput) => {
    return ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.TEST_DIRECT, input)
  },

  fetchModels: (input: FetchModelsInput) => {
    return ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.FETCH_MODELS, input)
  },

  getChannelPlanQuota: (channelId: string) => {
    return ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.GET_PLAN_QUOTA, channelId)
  },

  codexOAuthLogin: () => {
    return ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.CODEX_OAUTH_LOGIN)
  },

  codexOAuthCancel: () => {
    return ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.CODEX_OAUTH_CANCEL)
  },

  xaiOAuthLogin: () => {
    return ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.XAI_OAUTH_LOGIN)
  },

  xaiOAuthCancel: () => {
    return ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.XAI_OAUTH_CANCEL)
  },

  onXaiOAuthDeviceCode: (callback: (deviceCode: XaiOAuthDeviceCode) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, deviceCode: XaiOAuthDeviceCode) => callback(deviceCode)
    ipcRenderer.on(CHANNEL_IPC_CHANNELS.XAI_OAUTH_DEVICE_CODE, listener)
    return () => ipcRenderer.removeListener(CHANNEL_IPC_CHANNELS.XAI_OAUTH_DEVICE_CODE, listener)
  },

  // 教程
  getTutorialContent: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_TUTORIAL_CONTENT)
  },

  // 附件管理
  readAttachment: (localPath: string) => {
    return ipcRenderer.invoke(ATTACHMENT_IPC_CHANNELS.READ_ATTACHMENT, localPath)
  },

  saveImageAs: (localPath: string, defaultFilename: string) => {
    return ipcRenderer.invoke(ATTACHMENT_IPC_CHANNELS.SAVE_IMAGE_AS, localPath, defaultFilename)
  },

  saveResourceFileAs: (resourceRelativePath: string, defaultFilename: string) => {
    return ipcRenderer.invoke(ATTACHMENT_IPC_CHANNELS.SAVE_RESOURCE_FILE_AS, resourceRelativePath, defaultFilename)
  },

  saveMemoryExport: (input: import('@copis/shared').MemoryExportFileInput) => {
    return ipcRenderer.invoke('memory:save-export', input) as Promise<boolean>
  },

  openFileDialog: () => {
    return ipcRenderer.invoke(ATTACHMENT_IPC_CHANNELS.OPEN_FILE_DIALOG)
  },

  // 用户档案
  getUserProfile: () => {
    return ipcRenderer.invoke(USER_PROFILE_IPC_CHANNELS.GET)
  },

  updateUserProfile: (updates: Partial<UserProfile>) => {
    return ipcRenderer.invoke(USER_PROFILE_IPC_CHANNELS.UPDATE, updates)
  },

  // 应用设置
  getSettings: () => {
    return ipcRenderer.invoke(SETTINGS_IPC_CHANNELS.GET)
  },

  updateSettings: (updates: Partial<AppSettings>) => {
    return ipcRenderer.invoke(SETTINGS_IPC_CHANNELS.UPDATE, updates)
  },

  updateSettingsSync: (updates: Partial<AppSettings>) => {
    return ipcRenderer.sendSync(SETTINGS_IPC_CHANNELS.UPDATE_SYNC, updates)
  },

  getSystemTheme: () => {
    return ipcRenderer.invoke(SETTINGS_IPC_CHANNELS.GET_SYSTEM_THEME)
  },

  onSystemThemeChanged: (callback: (isDark: boolean) => void) => {
    const listener = (_: unknown, isDark: boolean): void => callback(isDark)
    ipcRenderer.on(SETTINGS_IPC_CHANNELS.ON_SYSTEM_THEME_CHANGED, listener)
    return () => { ipcRenderer.removeListener(SETTINGS_IPC_CHANNELS.ON_SYSTEM_THEME_CHANGED, listener) }
  },

  onThemeSettingsChanged: (callback: (payload: { themeMode: string; themeStyle: string; interfaceVariant?: string }) => void) => {
    const listener = (_: unknown, payload: { themeMode: string; themeStyle: string; interfaceVariant?: string }): void => callback(payload)
    ipcRenderer.on(SETTINGS_IPC_CHANNELS.ON_THEME_SETTINGS_CHANGED, listener)
    return () => { ipcRenderer.removeListener(SETTINGS_IPC_CHANNELS.ON_THEME_SETTINGS_CHANGED, listener) }
  },

  // Scratch Pad 持久化
  loadScratchPad: () => {
    return ipcRenderer.invoke(SCRATCH_PAD_IPC_CHANNELS.LOAD)
  },

  saveScratchPad: (content: string) => {
    return ipcRenderer.invoke(SCRATCH_PAD_IPC_CHANNELS.SAVE, content)
  },

  saveScratchPadSync: (content: string) => {
    return ipcRenderer.sendSync(SCRATCH_PAD_IPC_CHANNELS.SAVE_SYNC, content)
  },

  exportScratchPad: (markdown: string, dirPath: string, filename: string) => {
    return ipcRenderer.invoke(SCRATCH_PAD_IPC_CHANNELS.EXPORT, markdown, dirPath, filename)
  },

  chooseExportPath: (defaultName: string) => {
    return ipcRenderer.invoke(SCRATCH_PAD_IPC_CHANNELS.CHOOSE_EXPORT_PATH, defaultName)
  },

  copyImageToClipboard: (dataUrl: string) => {
    return ipcRenderer.invoke(SCRATCH_PAD_IPC_CHANNELS.COPY_IMAGE, dataUrl)
  },

  // 应用图标切换
  setAppIcon: (variantId: string) => {
    return ipcRenderer.invoke(APP_ICON_IPC_CHANNELS.SET, variantId)
  },

  // Dock/Launcher 角标
  setDockBadgeCount: (count: number) => {
    return ipcRenderer.invoke(DOCK_BADGE_IPC_CHANNELS.SET_COUNT, count)
  },

  // 环境检测
  checkEnvironment: () => {
    return ipcRenderer.invoke(ENVIRONMENT_IPC_CHANNELS.CHECK)
  },

  // 第三方安装包（Git / Node.js）
  fetchInstallerManifest: () => {
    return ipcRenderer.invoke(INSTALLER_IPC_CHANNELS.MANIFEST)
  },
  downloadInstaller: (req: InstallerDownloadRequest) => {
    return ipcRenderer.invoke(INSTALLER_IPC_CHANNELS.DOWNLOAD, req)
  },
  cancelInstallerDownload: (key: string) => {
    return ipcRenderer.invoke(INSTALLER_IPC_CHANNELS.CANCEL, key)
  },
  launchInstaller: (filePath: string) => {
    return ipcRenderer.invoke(INSTALLER_IPC_CHANNELS.LAUNCH, filePath)
  },
  onInstallerProgress: (callback: (payload: InstallerProgressPayload) => void) => {
    const listener = (_: unknown, payload: InstallerProgressPayload) => callback(payload)
    ipcRenderer.on(INSTALLER_IPC_CHANNELS.PROGRESS, listener)
    return () => ipcRenderer.off(INSTALLER_IPC_CHANNELS.PROGRESS, listener)
  },

  // Copis 功能模块
  listFunctionalModules: () => {
    return ipcRenderer.invoke(FUNCTIONAL_MODULE_IPC_CHANNELS.LIST)
  },
  checkFunctionalModule: (name: FunctionalModuleName) => {
    return ipcRenderer.invoke(FUNCTIONAL_MODULE_IPC_CHANNELS.CHECK, name)
  },
  installFunctionalModule: (input: FunctionalModuleInstallInput) => {
    return ipcRenderer.invoke(FUNCTIONAL_MODULE_IPC_CHANNELS.INSTALL, input)
  },
  onFunctionalModuleProgress: (callback: (payload: FunctionalModuleProgressPayload) => void) => {
    const listener = (_: unknown, payload: FunctionalModuleProgressPayload) => callback(payload)
    ipcRenderer.on(FUNCTIONAL_MODULE_IPC_CHANNELS.PROGRESS, listener)
    return () => ipcRenderer.off(FUNCTIONAL_MODULE_IPC_CHANNELS.PROGRESS, listener)
  },
  ensureRequiredFunctionalModules: () => {
    return ipcRenderer.invoke(FUNCTIONAL_MODULE_IPC_CHANNELS.ENSURE_REQUIRED)
  },
  onFunctionalModuleStartupProgress: (callback: (payload: FunctionalModuleStartupProgressPayload) => void) => {
    const listener = (_: unknown, payload: FunctionalModuleStartupProgressPayload) => callback(payload)
    ipcRenderer.on(FUNCTIONAL_MODULE_IPC_CHANNELS.STARTUP_PROGRESS, listener)
    return () => ipcRenderer.off(FUNCTIONAL_MODULE_IPC_CHANNELS.STARTUP_PROGRESS, listener)
  },

  // 代理配置
  getProxySettings: () => {
    return ipcRenderer.invoke(PROXY_IPC_CHANNELS.GET_SETTINGS)
  },

  updateProxySettings: (config: ProxyConfig) => {
    return ipcRenderer.invoke(PROXY_IPC_CHANNELS.UPDATE_SETTINGS, config)
  },

  detectSystemProxy: () => {
    return ipcRenderer.invoke(PROXY_IPC_CHANNELS.DETECT_SYSTEM)
  },

  // Agent 会话管理
  listAgentSessions: () => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.LIST_SESSIONS)
  },

  createAgentSession: (title?: string, channelId?: string, workspaceId?: string, modelId?: string, expertTeamSession?: AgentExpertTeamSession, expertTeamSetup?: boolean) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.CREATE_SESSION, title, channelId, workspaceId, modelId, expertTeamSession, expertTeamSetup)
  },

  createAgentSideQuestionSession: (input: CreateAgentSideQuestionSessionInput) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.CREATE_SIDE_QUESTION_SESSION, input) as Promise<AgentSideQuestionSessionResult>
  },

  getAgentSessionSDKMessages: (id: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_SDK_MESSAGES, id)
  },

  updateAgentSessionTitle: (id: string, title: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.UPDATE_TITLE, id, title)
  },

  updateSessionAgentRuntime: (sessionId: string, runtime: AgentRuntime) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.UPDATE_SESSION_AGENT_RUNTIME, sessionId, runtime)
  },

  updateSessionCodexFastMode: (sessionId: string, enabled: boolean) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.UPDATE_SESSION_CODEX_FAST_MODE, sessionId, enabled)
  },

  updateSessionAdvancedAuthorization: (sessionId: string, enabled: boolean) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.UPDATE_SESSION_ADVANCED_AUTHORIZATION, sessionId, enabled)
  },

  updateSessionWorkingMode: (sessionId: string, mode: import('@copis/shared').WorkingMode, channelId?: string, modelId?: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.UPDATE_SESSION_WORKING_MODE, sessionId, mode, channelId, modelId)
  },

  getPiReasoningCapability: (channelId: string, modelId: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_PI_REASONING_CAPABILITY, channelId, modelId)
  },

  updateSessionReasoningLevel: (sessionId: string, thinkingLevel: AgentThinkingLevel) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.UPDATE_SESSION_REASONING_LEVEL, sessionId, thinkingLevel)
  },

  updateAgentSessionModel: (id: string, channelId?: string, modelId?: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.UPDATE_SESSION_MODEL, id, channelId, modelId)
  },

  deleteAgentSession: (id: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.DELETE_SESSION, id)
  },

  togglePinAgentSession: (id: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.TOGGLE_PIN, id)
  },

  toggleStarAgentSession: (id: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.TOGGLE_STAR, id)
  },

  clearAgentCompletionState: (id: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.CLEAR_COMPLETION_STATE, id)
  },

  toggleArchiveAgentSession: (id: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.TOGGLE_ARCHIVE, id)
  },

  searchAgentSessionMessages: (query: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.SEARCH_MESSAGES, query)
  },

  searchAgentSessionReferences: (input: AgentSessionReferenceSearchInput) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.SEARCH_SESSION_REFERENCES, input)
  },

  moveAgentSessionToWorkspace: (input: MoveSessionToWorkspaceInput) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.MOVE_SESSION_TO_WORKSPACE, input)
  },

  forkAgentSession: (input: ForkSessionInput) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.FORK_SESSION, input)
  },

  rewindSession: (input: RewindSessionInput) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.REWIND_SESSION, input)
  },

  generateAgentTitle: (input: AgentGenerateTitleInput) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GENERATE_TITLE, input)
  },

  sendAgentMessage: (input: AgentSendInput) => {
    if (input.agentRuntime === 'pi') return agentHttpStreamClient.send(input)
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.SEND_MESSAGE, input)
  },

  stopAgent: (sessionId: string) => {
    return agentHttpStreamClient.stop(sessionId).catch(() => ipcRenderer.invoke(AGENT_IPC_CHANNELS.STOP_AGENT, sessionId))
  },

  // Agent 队列消息
  queueAgentMessage: (input: AgentQueueMessageInput) => {
    return agentHttpStreamClient.queue(input)
  },

  // Agent 后台任务管理
  getTaskOutput: (input: GetTaskOutputInput) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_TASK_OUTPUT, input)
  },

  stopTask: (input: StopTaskInput) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.STOP_TASK, input)
  },

  // Agent 工作区管理
  listAgentWorkspaces: () => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.LIST_WORKSPACES)
  },

  createAgentWorkspace: (input: CreateAgentWorkspaceInput) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.CREATE_WORKSPACE, input)
  },

  createAgentProject: (input: CreateAgentWorkspaceInput, channelId?: string, modelId?: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.CREATE_PROJECT, input, channelId, modelId)
  },

  updateAgentWorkspace: (id: string, updates: import('@copis/shared').UpdateAgentWorkspaceInput) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.UPDATE_WORKSPACE, id, updates)
  },

  relinkAgentWorkspaceProjectRoot: (id: string, projectRootPath: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.RELINK_WORKSPACE_PROJECT_ROOT, id, projectRootPath)
  },

  restoreAgentWorkspaceProjectRoot: (id: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.RESTORE_WORKSPACE_PROJECT_ROOT, id)
  },

  deleteAgentWorkspace: (id: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.DELETE_WORKSPACE, id)
  },

  reorderAgentWorkspaces: (orderedIds: string[]) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.REORDER_WORKSPACES, orderedIds)
  },

  // 工作区能力（MCP + Skill）
  getWorkspaceCapabilities: (workspaceSlug: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_CAPABILITIES, workspaceSlug)
  },

  getWorkspaceMcpConfig: (workspaceSlug: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_MCP_CONFIG, workspaceSlug)
  },

  saveWorkspaceMcpConfig: (workspaceSlug: string, config: WorkspaceMcpConfig) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.SAVE_MCP_CONFIG, workspaceSlug, config)
  },

  testMcpServer: (name: string, entry: import('@copis/shared').McpServerEntry) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.TEST_MCP_SERVER, name, entry) as Promise<{ success: boolean; message: string }>
  },

  setBuiltinMcpEnabled: (workspaceSlug: string, id: string, enabled: boolean) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.SET_BUILTIN_MCP_ENABLED, workspaceSlug, id, enabled)
  },

  getWorkspaceSkills: (workspaceSlug: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_SKILLS, workspaceSlug)
  },

  getWorkspaceSkillsDir: (workspaceSlug: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_SKILLS_DIR, workspaceSlug)
  },

  deleteWorkspaceSkill: (workspaceSlug: string, skillSlug: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.DELETE_SKILL, workspaceSlug, skillSlug)
  },

  toggleWorkspaceSkill: (workspaceSlug: string, skillSlug: string, enabled: boolean) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.TOGGLE_SKILL, workspaceSlug, skillSlug, enabled)
  },

  getOtherWorkspaceSkills: (currentSlug: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_OTHER_WORKSPACE_SKILLS, currentSlug)
  },

  getDefaultSkillSlugs: () => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_DEFAULT_SKILL_SLUGS)
  },

  importSkillFromWorkspace: (targetSlug: string, sourceSlug: string, skillSlug: string) => {
    return ipcRenderer.invoke(
      AGENT_IPC_CHANNELS.IMPORT_SKILL_FROM_WORKSPACE,
      targetSlug,
      sourceSlug,
      skillSlug,
    )
  },

  updateSkillFromSource: (targetSlug: string, skillSlug: string) => {
    return ipcRenderer.invoke(
      AGENT_IPC_CHANNELS.UPDATE_SKILL_FROM_SOURCE,
      targetSlug,
      skillSlug,
    )
  },

  readSkillContent: (workspaceSlug: string, skillSlug: string) => {
    return ipcRenderer.invoke(
      AGENT_IPC_CHANNELS.READ_SKILL_CONTENT,
      workspaceSlug,
      skillSlug,
    )
  },

  writeSkillContent: (workspaceSlug: string, skillSlug: string, content: string) => {
    return ipcRenderer.invoke(
      AGENT_IPC_CHANNELS.WRITE_SKILL_CONTENT,
      workspaceSlug,
      skillSlug,
      content,
    )
  },

  listSkillFiles: (workspaceSlug: string, skillSlug: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.LIST_SKILL_FILES, workspaceSlug, skillSlug)
  },

  readSkillFile: (workspaceSlug: string, skillSlug: string, relativePath: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.READ_SKILL_FILE, workspaceSlug, skillSlug, relativePath)
  },

  writeSkillFile: (workspaceSlug: string, skillSlug: string, relativePath: string, content: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.WRITE_SKILL_FILE, workspaceSlug, skillSlug, relativePath, content)
  },

  createSkillEntry: (workspaceSlug: string, skillSlug: string, relativePath: string, type: 'file' | 'directory') => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.CREATE_SKILL_ENTRY, workspaceSlug, skillSlug, relativePath, type)
  },

  deleteSkillEntry: (workspaceSlug: string, skillSlug: string, relativePath: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.DELETE_SKILL_ENTRY, workspaceSlug, skillSlug, relativePath)
  },

  renameSkillEntry: (workspaceSlug: string, skillSlug: string, fromRelative: string, toRelative: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.RENAME_SKILL_ENTRY, workspaceSlug, skillSlug, fromRelative, toRelative)
  },

  onAgentStreamEvent: (callback: (event: AgentStreamEvent) => void) => {
    const listener = (_: unknown, event: AgentStreamEvent): void => callback(event)
    ipcRenderer.on(AGENT_IPC_CHANNELS.STREAM_EVENT, listener)
    const cleanupHttp = agentHttpStreamClient.onEvent(callback)
    return () => {
      ipcRenderer.removeListener(AGENT_IPC_CHANNELS.STREAM_EVENT, listener)
      cleanupHttp()
    }
  },

  onAgentStreamComplete: (callback: (data: AgentStreamCompletePayload) => void) => {
    const listener = (_: unknown, data: AgentStreamCompletePayload): void => callback(data)
    ipcRenderer.on(AGENT_IPC_CHANNELS.STREAM_COMPLETE, listener)
    const cleanupHttp = agentHttpStreamClient.onComplete(callback)
    return () => {
      ipcRenderer.removeListener(AGENT_IPC_CHANNELS.STREAM_COMPLETE, listener)
      cleanupHttp()
    }
  },

  onAgentStreamError: (callback: (data: { sessionId: string; error: string }) => void) => {
    const listener = (_: unknown, data: { sessionId: string; error: string }): void => callback(data)
    ipcRenderer.on(AGENT_IPC_CHANNELS.STREAM_ERROR, listener)
    const cleanupHttp = agentHttpStreamClient.onError(callback)
    return () => {
      ipcRenderer.removeListener(AGENT_IPC_CHANNELS.STREAM_ERROR, listener)
      cleanupHttp()
    }
  },

  // 标题自动更新通知
  onAgentTitleUpdated: (callback: (data: { sessionId: string; title: string }) => void) => {
    const listener = (_: unknown, data: { sessionId: string; title: string }): void => callback(data)
    ipcRenderer.on(AGENT_IPC_CHANNELS.TITLE_UPDATED, listener)
    const cleanupHttp = agentHttpStreamClient.onTitleUpdated(callback)
    return () => {
      ipcRenderer.removeListener(AGENT_IPC_CHANNELS.TITLE_UPDATED, listener)
      cleanupHttp()
    }
  },

  // Agent 权限系统
  respondPermission: (response: PermissionResponse) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.PERMISSION_RESPOND, response)
  },

  updateSessionPermissionMode: (sessionId: string, mode: CopisPermissionMode) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.UPDATE_SESSION_PERMISSION_MODE, sessionId, mode)
  },

  // Agent 工具管理
  getAgentTools: () => {
    return ipcRenderer.invoke(AGENT_TOOL_IPC_CHANNELS.GET_ALL_TOOLS)
  },

  getAgentToolCredentials: (toolId: string) => {
    return ipcRenderer.invoke(AGENT_TOOL_IPC_CHANNELS.GET_TOOL_CREDENTIALS, toolId)
  },

  updateAgentToolState: (toolId: string, state: AgentToolState) => {
    return ipcRenderer.invoke(AGENT_TOOL_IPC_CHANNELS.UPDATE_TOOL_STATE, toolId, state)
  },

  updateAgentToolCredentials: (toolId: string, credentials: Record<string, string>) => {
    return ipcRenderer.invoke(AGENT_TOOL_IPC_CHANNELS.UPDATE_TOOL_CREDENTIALS, toolId, credentials)
  },

  createCustomAgentTool: (meta: AgentToolMeta) => {
    return ipcRenderer.invoke(AGENT_TOOL_IPC_CHANNELS.CREATE_CUSTOM_TOOL, meta)
  },

  deleteCustomAgentTool: (toolId: string) => {
    return ipcRenderer.invoke(AGENT_TOOL_IPC_CHANNELS.DELETE_CUSTOM_TOOL, toolId)
  },

  onAgentToolChanged: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(AGENT_TOOL_IPC_CHANNELS.CUSTOM_TOOL_CHANGED, listener)
    return () => { ipcRenderer.removeListener(AGENT_TOOL_IPC_CHANNELS.CUSTOM_TOOL_CHANGED, listener) }
  },

  testAgentTool: (toolId: string) => {
    return ipcRenderer.invoke(AGENT_TOOL_IPC_CHANNELS.TEST_TOOL, toolId)
  },

  // AskUserQuestion 交互式问答
  respondAskUser: (response: AskUserResponse) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.ASK_USER_RESPOND, response)
  },

  // ExitPlanMode 计划审批
  respondExitPlanMode: (response: ExitPlanModeResponse) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.EXIT_PLAN_MODE_RESPOND, response)
  },

  // 待处理请求恢复
  getPendingRequests: () => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_PENDING_REQUESTS)
  },

  // 工作区文件变化通知
  onCapabilitiesChanged: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(AGENT_IPC_CHANNELS.CAPABILITIES_CHANGED, listener)
    return () => { ipcRenderer.removeListener(AGENT_IPC_CHANNELS.CAPABILITIES_CHANGED, listener) }
  },

  onWorkspaceFilesChanged: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(AGENT_IPC_CHANNELS.WORKSPACE_FILES_CHANGED, listener)
    return () => { ipcRenderer.removeListener(AGENT_IPC_CHANNELS.WORKSPACE_FILES_CHANGED, listener) }
  },

  // Agent 附件
  saveFilesToAgentSession: (input: AgentSaveFilesInput) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.SAVE_FILES_TO_SESSION, input)
  },

  saveFilesToWorkspaceFiles: (input: AgentSaveWorkspaceFilesInput) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.SAVE_FILES_TO_WORKSPACE, input)
  },

  getWorkspaceFilesPath: (workspaceSlug: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_WORKSPACE_FILES_PATH, workspaceSlug)
  },

  openFolderDialog: () => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.OPEN_FOLDER_DIALOG)
  },

  openFileOrFolderDialog: () => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.OPEN_FILE_OR_FOLDER_DIALOG)
  },

  attachDirectory: (input: AgentAttachDirectoryInput) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.ATTACH_DIRECTORY, input)
  },

  detachDirectory: (input: AgentAttachDirectoryInput) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.DETACH_DIRECTORY, input)
  },

  attachFile: (input: AgentAttachFileInput) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.ATTACH_FILE, input)
  },

  detachFile: (input: AgentAttachFileInput) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.DETACH_FILE, input)
  },

  attachWorkspaceDirectory: (input: WorkspaceAttachDirectoryInput) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.ATTACH_WORKSPACE_DIRECTORY, input)
  },

  detachWorkspaceDirectory: (input: WorkspaceAttachDirectoryInput) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.DETACH_WORKSPACE_DIRECTORY, input)
  },

  attachWorkspaceFile: (input: WorkspaceAttachFileInput) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.ATTACH_WORKSPACE_FILE, input)
  },

  detachWorkspaceFile: (input: WorkspaceAttachFileInput) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.DETACH_WORKSPACE_FILE, input)
  },

  getWorkspaceDirectories: (workspaceSlug: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_WORKSPACE_DIRECTORIES, workspaceSlug)
  },

  getWorkspaceAttachedFiles: (workspaceSlug: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_WORKSPACE_ATTACHED_FILES, workspaceSlug)
  },

  getWorktreeRepos: (workspaceSlug: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_WORKTREE_REPOS, workspaceSlug)
  },

  addWorktreeRepo: (workspaceSlug: string, repo: import('@copis/shared').WorkspaceWorktreeRepo) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.ADD_WORKTREE_REPO, workspaceSlug, repo)
  },

  removeWorktreeRepo: (workspaceSlug: string, repoPath: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.REMOVE_WORKTREE_REPO, workspaceSlug, repoPath)
  },

  // Agent 文件系统操作
  getAgentSessionPath: (workspaceId: string, sessionId: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_SESSION_PATH, workspaceId, sessionId)
  },

  listDirectory: (dirPath: string, access?: import('@copis/shared').FileAccessOptions) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.LIST_DIRECTORY, dirPath, access)
  },

  deleteFile: (filePath: string, access?: import('@copis/shared').FileAccessOptions) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.DELETE_FILE, filePath, access)
  },

  openFile: (filePath: string, access?: import('@copis/shared').FileAccessOptions) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.OPEN_FILE, filePath, access)
  },

  writeClipboardPreview: (filename: string, content: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.WRITE_CLIPBOARD_PREVIEW, filename, content)
  },

  systemOpenFile: (filePath: string, appName?: string, access?: import('@copis/shared').FileAccessOptions) => {
    return ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_OPEN_FILE, filePath, appName, access)
  },

  scanEditors: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.SCAN_EDITORS)
  },

  getDefaultAppForFile: (filePath: string, access?: import('@copis/shared').FileAccessOptions) => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_DEFAULT_APP_FOR_FILE, filePath, access) as Promise<import('@copis/shared').DefaultAppInfo | null>
  },

  showInFolder: (filePath: string, access?: import('@copis/shared').FileAccessOptions) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.SHOW_IN_FOLDER, filePath, access)
  },

  openFolderInTerminal: (folderPath: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.OPEN_FOLDER_IN_TERMINAL, folderPath)
  },

  /** 在系统文件管理器中显示文件（无工作区限制，支持候选基础目录） */
  showItemInFolder: (filePath: string, candidateBasePaths?: string[]): Promise<boolean> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SHOW_ITEM_IN_FOLDER, filePath, candidateBasePaths)
  },

  resolveAndReadFile: (filePath: string, access?: import('@copis/shared').FileAccessOptions) => {
    return ipcRenderer.invoke('file:resolve-and-read', filePath, access) as Promise<{ resolvedPath: string; content: string } | null>
  },

  writeTextFile: (filePath: string, content: string, access?: import('@copis/shared').FileAccessOptions) => {
    return ipcRenderer.invoke('file:write-text', filePath, content, access) as Promise<boolean>
  },

  resolveFilePath: (filePath: string, access?: import('@copis/shared').FileAccessOptions) => {
    return ipcRenderer.invoke('file:resolve-path', filePath, access) as Promise<import('@copis/shared').ResolvedFileUrl | null>
  },

  preparePdfPreview: (filePath: string, access?: import('@copis/shared').FileAccessOptions) => {
    return ipcRenderer.invoke('file:prepare-pdf-preview', filePath, access) as Promise<{ tmpHtmlUrl: string } | null>
  },

  readBinaryBase64: (filePath: string, access?: import('@copis/shared').FileAccessOptions, maxSize?: number) => {
    return ipcRenderer.invoke('file:read-binary-base64', filePath, access, maxSize) as Promise<string | null>
  },

  docxToHtml: (filePath: string, access?: import('@copis/shared').FileAccessOptions) => {
    return ipcRenderer.invoke('file:docx-to-html', filePath, access) as Promise<{ resolvedPath: string; html: string } | null>
  },

  officeToHtml: (filePath: string, access?: import('@copis/shared').FileAccessOptions) => {
    return ipcRenderer.invoke('file:office-to-html', filePath, access) as Promise<import('@copis/shared').OfficePreviewResult | null>
  },

  screenshotCapture: (input: { html: string; isDark: boolean; width?: number; mode: 'clipboard' | 'file'; css?: string; themeClass?: string }) => {
    return ipcRenderer.invoke(IPC_CHANNELS.SCREENSHOT_CAPTURE, input) as Promise<{ success: boolean; message: string; filePath?: string }>
  },

  renameFile: (filePath: string, newName: string, access?: import('@copis/shared').FileAccessOptions) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.RENAME_FILE, filePath, newName, access)
  },

  moveFile: (filePath: string, targetDir: string, access?: import('@copis/shared').FileAccessOptions) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.MOVE_FILE, filePath, targetDir, access)
  },

  listAttachedDirectory: (dirPath: string, access?: import('@copis/shared').FileAccessOptions) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.LIST_ATTACHED_DIRECTORY, dirPath, access)
  },

  readAttachedFile: (filePath: string, sessionId?: string, workspaceSlug?: string) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.READ_ATTACHED_FILE, filePath, sessionId, workspaceSlug)
  },

  showAttachedInFolder: (filePath: string, access?: import('@copis/shared').FileAccessOptions) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.SHOW_ATTACHED_IN_FOLDER, filePath, access)
  },

  renameAttachedFile: (filePath: string, newName: string, access?: import('@copis/shared').FileAccessOptions) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.RENAME_ATTACHED_FILE, filePath, newName, access)
  },

  moveAttachedFile: (filePath: string, targetDir: string, access?: import('@copis/shared').FileAccessOptions) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.MOVE_ATTACHED_FILE, filePath, targetDir, access)
  },

  checkPathsType: (paths: string[]) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.CHECK_PATHS_TYPE, paths)
  },

  getPathForFile: (file: File) => {
    return webUtils.getPathForFile(file)
  },

  searchWorkspaceFiles: (rootPath: string, query: string, limit = 20, additionalPaths?: string[], sessionPaths?: string[]) => {
    return ipcRenderer.invoke(AGENT_IPC_CHANNELS.SEARCH_WORKSPACE_FILES, rootPath, query, limit, additionalPaths, sessionPaths)
  },

  // 系统提示词管理
  getSystemPromptConfig: () => {
    return ipcRenderer.invoke(SYSTEM_PROMPT_IPC_CHANNELS.GET_CONFIG)
  },

  createSystemPrompt: (input: SystemPromptCreateInput) => {
    return ipcRenderer.invoke(SYSTEM_PROMPT_IPC_CHANNELS.CREATE, input)
  },

  updateSystemPrompt: (id: string, input: SystemPromptUpdateInput) => {
    return ipcRenderer.invoke(SYSTEM_PROMPT_IPC_CHANNELS.UPDATE, id, input)
  },

  deleteSystemPrompt: (id: string) => {
    return ipcRenderer.invoke(SYSTEM_PROMPT_IPC_CHANNELS.DELETE, id)
  },

  updateAppendSetting: (enabled: boolean) => {
    return ipcRenderer.invoke(SYSTEM_PROMPT_IPC_CHANNELS.UPDATE_APPEND_SETTING, enabled)
  },

  setDefaultPrompt: (id: string | null) => {
    return ipcRenderer.invoke(SYSTEM_PROMPT_IPC_CHANNELS.SET_DEFAULT, id)
  },

  // 自动更新
  updater: {
    checkForUpdates: () => ipcRenderer.invoke('updater:check'),
    getStatus: () => ipcRenderer.invoke('updater:get-status'),
    onStatusChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, status: Parameters<typeof callback>[0]): void => callback(status)
      ipcRenderer.on('updater:status-changed', listener)
      return () => { ipcRenderer.removeListener('updater:status-changed', listener) }
    },
    installWhenIdle: () => ipcRenderer.invoke('updater:install-when-idle'),
    cancelIdleInstall: () => ipcRenderer.invoke('updater:cancel-idle-install'),
  },

  // GitHub Release
  getLatestRelease: () => {
    return ipcRenderer.invoke(GITHUB_RELEASE_IPC_CHANNELS.GET_LATEST_RELEASE)
  },

  listReleases: (options) => {
    return ipcRenderer.invoke(GITHUB_RELEASE_IPC_CHANNELS.LIST_RELEASES, options)
  },

  getReleaseByTag: (tag) => {
    return ipcRenderer.invoke(GITHUB_RELEASE_IPC_CHANNELS.GET_RELEASE_BY_TAG, tag)
  },

  // ===== 飞书集成 =====

  getFeishuConfig: () => {
    return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.GET_CONFIG)
  },

  getDecryptedFeishuSecret: () => {
    return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.GET_DECRYPTED_SECRET)
  },

  saveFeishuConfig: (input: FeishuConfigInput) => {
    return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.SAVE_CONFIG, input)
  },

  testFeishuConnection: (appId: string, appSecret: string) => {
    return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.TEST_CONNECTION, appId, appSecret)
  },

  startFeishuBridge: () => {
    return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.START_BRIDGE)
  },

  stopFeishuBridge: () => {
    return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.STOP_BRIDGE)
  },

  getFeishuStatus: () => {
    return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.GET_STATUS)
  },

  listFeishuBindings: () => {
    return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.LIST_BINDINGS)
  },

  updateFeishuBinding: (input: FeishuUpdateBindingInput) => {
    return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.UPDATE_BINDING, input)
  },

  removeFeishuBinding: (chatId: string) => {
    return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.REMOVE_BINDING, chatId)
  },

  reportFeishuPresence: (report: FeishuPresenceReport) => {
    return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.REPORT_PRESENCE, report)
  },

  onFeishuStatusChanged: (callback: (state: FeishuBridgeState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: FeishuBridgeState): void => callback(state)
    ipcRenderer.on(FEISHU_IPC_CHANNELS.STATUS_CHANGED, listener)
    return () => { ipcRenderer.removeListener(FEISHU_IPC_CHANNELS.STATUS_CHANGED, listener) }
  },

  // --- 多 Bot v2 API ---

  getFeishuMultiConfig: () => {
    return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.GET_MULTI_CONFIG)
  },

  saveFeishuBotConfig: (input: import('@copis/shared').FeishuBotConfigInput) => {
    return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.SAVE_BOT_CONFIG, input)
  },

  getDecryptedFeishuBotSecret: (botId: string) => {
    return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.GET_BOT_DECRYPTED_SECRET, botId)
  },

  removeFeishuBot: (botId: string) => {
    return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.REMOVE_BOT, botId)
  },

  startFeishuBot: (botId: string) => {
    return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.START_BOT, botId)
  },

  stopFeishuBot: (botId: string) => {
    return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.STOP_BOT, botId)
  },

  getFeishuMultiStatus: () => {
    return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.GET_MULTI_STATUS)
  },

  // --- 扫码注册 ---

  registerFeishuApp: () => {
    return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.REGISTER_APP_START)
  },

  cancelFeishuRegistration: () => {
    return ipcRenderer.invoke(FEISHU_IPC_CHANNELS.REGISTER_APP_CANCEL)
  },

  onFeishuRegisterQrcode: (callback: (payload: import('@copis/shared').FeishuRegisterAppQRCode) => void) => {
    const listener = (_: unknown, payload: import('@copis/shared').FeishuRegisterAppQRCode) => callback(payload)
    ipcRenderer.on(FEISHU_IPC_CHANNELS.REGISTER_APP_QRCODE, listener)
    return () => { ipcRenderer.removeListener(FEISHU_IPC_CHANNELS.REGISTER_APP_QRCODE, listener) }
  },

  onFeishuRegisterStatus: (callback: (payload: import('@copis/shared').FeishuRegisterAppStatus) => void) => {
    const listener = (_: unknown, payload: import('@copis/shared').FeishuRegisterAppStatus) => callback(payload)
    ipcRenderer.on(FEISHU_IPC_CHANNELS.REGISTER_APP_STATUS, listener)
    return () => { ipcRenderer.removeListener(FEISHU_IPC_CHANNELS.REGISTER_APP_STATUS, listener) }
  },

  // ===== 微信集成 =====

  getWeChatConfig: () => {
    return ipcRenderer.invoke(WECHAT_IPC_CHANNELS.GET_CONFIG)
  },

  startWeChatLogin: () => {
    return ipcRenderer.invoke(WECHAT_IPC_CHANNELS.START_LOGIN)
  },

  logoutWeChat: () => {
    return ipcRenderer.invoke(WECHAT_IPC_CHANNELS.LOGOUT)
  },

  startWeChatBridge: () => {
    return ipcRenderer.invoke(WECHAT_IPC_CHANNELS.START_BRIDGE)
  },

  stopWeChatBridge: () => {
    return ipcRenderer.invoke(WECHAT_IPC_CHANNELS.STOP_BRIDGE)
  },

  getWeChatStatus: () => {
    return ipcRenderer.invoke(WECHAT_IPC_CHANNELS.GET_STATUS)
  },

  onWeChatStatusChanged: (callback: (state: WeChatBridgeState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: WeChatBridgeState): void => callback(state)
    ipcRenderer.on(WECHAT_IPC_CHANNELS.STATUS_CHANGED, listener)
    return () => { ipcRenderer.removeListener(WECHAT_IPC_CHANNELS.STATUS_CHANGED, listener) }
  },

  // ===== 钉钉集成 =====

  getDingTalkConfig: () => {
    return ipcRenderer.invoke(DINGTALK_IPC_CHANNELS.GET_CONFIG)
  },

  getDecryptedDingTalkSecret: () => {
    return ipcRenderer.invoke(DINGTALK_IPC_CHANNELS.GET_DECRYPTED_SECRET)
  },

  saveDingTalkConfig: (input: DingTalkConfigInput) => {
    return ipcRenderer.invoke(DINGTALK_IPC_CHANNELS.SAVE_CONFIG, input)
  },

  testDingTalkConnection: (clientId: string, clientSecret: string) => {
    return ipcRenderer.invoke(DINGTALK_IPC_CHANNELS.TEST_CONNECTION, clientId, clientSecret)
  },

  startDingTalkBridge: () => {
    return ipcRenderer.invoke(DINGTALK_IPC_CHANNELS.START_BRIDGE)
  },

  stopDingTalkBridge: () => {
    return ipcRenderer.invoke(DINGTALK_IPC_CHANNELS.STOP_BRIDGE)
  },

  getDingTalkStatus: () => {
    return ipcRenderer.invoke(DINGTALK_IPC_CHANNELS.GET_STATUS)
  },

  onDingTalkStatusChanged: (callback: (state: DingTalkBridgeState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: DingTalkBridgeState): void => callback(state)
    ipcRenderer.on(DINGTALK_IPC_CHANNELS.STATUS_CHANGED, listener)
    return () => { ipcRenderer.removeListener(DINGTALK_IPC_CHANNELS.STATUS_CHANGED, listener) }
  },

  // --- 钉钉多 Bot v2 API ---

  getDingTalkMultiConfig: () => {
    return ipcRenderer.invoke(DINGTALK_IPC_CHANNELS.GET_MULTI_CONFIG)
  },

  saveDingTalkBotConfig: (input: import('@copis/shared').DingTalkBotConfigInput) => {
    return ipcRenderer.invoke(DINGTALK_IPC_CHANNELS.SAVE_BOT_CONFIG, input)
  },

  getDecryptedDingTalkBotSecret: (botId: string) => {
    return ipcRenderer.invoke(DINGTALK_IPC_CHANNELS.GET_BOT_DECRYPTED_SECRET, botId)
  },

  removeDingTalkBot: (botId: string) => {
    return ipcRenderer.invoke(DINGTALK_IPC_CHANNELS.REMOVE_BOT, botId)
  },

  startDingTalkBot: (botId: string) => {
    return ipcRenderer.invoke(DINGTALK_IPC_CHANNELS.START_BOT, botId)
  },

  stopDingTalkBot: (botId: string) => {
    return ipcRenderer.invoke(DINGTALK_IPC_CHANNELS.STOP_BOT, botId)
  },

  getDingTalkMultiStatus: () => {
    return ipcRenderer.invoke(DINGTALK_IPC_CHANNELS.GET_MULTI_STATUS)
  },

  onMenuCloseTab: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('menu:close-tab', listener)
    return () => { ipcRenderer.removeListener('menu:close-tab', listener) }
  },

  // ===== 快速任务窗口 =====

  submitQuickTask: (input: QuickTaskSubmitInput) => {
    return ipcRenderer.invoke(QUICK_TASK_IPC_CHANNELS.SUBMIT, input)
  },

  hideQuickTask: () => {
    return ipcRenderer.invoke(QUICK_TASK_IPC_CHANNELS.HIDE)
  },

  reregisterGlobalShortcuts: () => {
    return ipcRenderer.invoke(QUICK_TASK_IPC_CHANNELS.REREGISTER_GLOBAL_SHORTCUTS)
  },

  getGlobalShortcutRegistrationStatus: () => {
    return ipcRenderer.invoke(QUICK_TASK_IPC_CHANNELS.GET_GLOBAL_SHORTCUT_REGISTRATION_STATUS)
  },

  onQuickTaskFocus: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(QUICK_TASK_IPC_CHANNELS.FOCUS, listener)
    return () => { ipcRenderer.removeListener(QUICK_TASK_IPC_CHANNELS.FOCUS, listener) }
  },

  onQuickTaskOpenSession: (callback: (data: QuickTaskOpenSessionData) => void) => {
    const listener = (_: unknown, data: QuickTaskOpenSessionData): void => callback(data)
    ipcRenderer.on('quick-task:open-session', listener)
    return () => { ipcRenderer.removeListener('quick-task:open-session', listener) }
  },

  // ===== 语音输入 =====

  getVoiceDictationSettings: () => {
    return ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.GET_SETTINGS)
  },

  updateVoiceDictationSettings: (updates: VoiceDictationSettingsUpdate) => {
    return ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.UPDATE_SETTINGS, updates)
  },

  testVoiceDictationConnection: (updates?: VoiceDictationSettingsUpdate) => {
    return ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.TEST_CONNECTION, updates)
  },

  toggleVoiceDictation: () => {
    return ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.TOGGLE)
  },

  startVoiceDictation: (input: VoiceDictationStartInput) => {
    return ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.START, input)
  },

  sendVoiceDictationAudio: (input: VoiceDictationAudioChunkInput) => {
    return ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.SEND_AUDIO, input)
  },

  reportVoiceDictationVolume: (volume: number) => {
    ipcRenderer.send(VOICE_DICTATION_IPC_CHANNELS.REPORT_VOLUME, volume)
  },

  reportVoiceDictationTranscript: (text: string) => {
    ipcRenderer.send(VOICE_DICTATION_IPC_CHANNELS.REPORT_TRANSCRIPT, text)
  },

  stopVoiceDictation: (input: VoiceDictationStopInput) => {
    return ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.STOP, input)
  },

  cancelVoiceDictation: (input: VoiceDictationStopInput) => {
    return ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.CANCEL, input)
  },

  commitVoiceDictation: (input: VoiceDictationCommitInput) => {
    return ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.COMMIT, input)
  },

  previewVoiceDictation: (input: VoiceDictationPreviewInput) => {
    return ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.PREVIEW, input)
  },

  hideVoiceDictation: () => {
    return ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.HIDE)
  },

  resizeVoiceDictation: (input: VoiceDictationResizeInput) => {
    return ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.RESIZE, input)
  },

  onVoiceDictationShown: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(VOICE_DICTATION_IPC_CHANNELS.SHOWN, listener)
    return () => { ipcRenderer.removeListener(VOICE_DICTATION_IPC_CHANNELS.SHOWN, listener) }
  },

  onVoiceDictationToggleStop: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(VOICE_DICTATION_IPC_CHANNELS.TOGGLE_STOP, listener)
    return () => { ipcRenderer.removeListener(VOICE_DICTATION_IPC_CHANNELS.TOGGLE_STOP, listener) }
  },

  onVoiceDictationTranscript: (callback: (event: VoiceDictationTranscriptEvent) => void) => {
    const listener = (_: unknown, event: VoiceDictationTranscriptEvent): void => callback(event)
    ipcRenderer.on(VOICE_DICTATION_IPC_CHANNELS.TRANSCRIPT, listener)
    return () => { ipcRenderer.removeListener(VOICE_DICTATION_IPC_CHANNELS.TRANSCRIPT, listener) }
  },

  onVoiceDictationState: (callback: (event: VoiceDictationStateEvent) => void) => {
    const listener = (_: unknown, event: VoiceDictationStateEvent): void => callback(event)
    ipcRenderer.on(VOICE_DICTATION_IPC_CHANNELS.STATE, listener)
    return () => { ipcRenderer.removeListener(VOICE_DICTATION_IPC_CHANNELS.STATE, listener) }
  },

  onVoiceDictationIndicatorState: (callback: (event: VoiceDictationIndicatorEvent) => void) => {
    const listener = (_: unknown, event: VoiceDictationIndicatorEvent): void => callback(event)
    ipcRenderer.on(VOICE_DICTATION_IPC_CHANNELS.INDICATOR_STATE, listener)
    return () => { ipcRenderer.removeListener(VOICE_DICTATION_IPC_CHANNELS.INDICATOR_STATE, listener) }
  },

  onVoiceDictationInsertText: (callback: (data: VoiceDictationTextEvent) => void) => {
    const listener = (_: unknown, data: VoiceDictationTextEvent): void => callback(data)
    ipcRenderer.on(VOICE_DICTATION_IPC_CHANNELS.INSERT_TEXT, listener)
    return () => { ipcRenderer.removeListener(VOICE_DICTATION_IPC_CHANNELS.INSERT_TEXT, listener) }
  },

  onVoiceDictationPreviewText: (callback: (data: VoiceDictationTextEvent) => void) => {
    const listener = (_: unknown, data: VoiceDictationTextEvent): void => callback(data)
    ipcRenderer.on(VOICE_DICTATION_IPC_CHANNELS.PREVIEW_TEXT, listener)
    return () => { ipcRenderer.removeListener(VOICE_DICTATION_IPC_CHANNELS.PREVIEW_TEXT, listener) }
  },

  onVoiceDictationClearPreviewText: (callback: (data: Pick<VoiceDictationTextEvent, 'sessionId'>) => void) => {
    const listener = (_: unknown, data: Pick<VoiceDictationTextEvent, 'sessionId'>): void => callback(data)
    ipcRenderer.on(VOICE_DICTATION_IPC_CHANNELS.CLEAR_PREVIEW_TEXT, listener)
    return () => { ipcRenderer.removeListener(VOICE_DICTATION_IPC_CHANNELS.CLEAR_PREVIEW_TEXT, listener) }
  },

  checkMicrophonePermission: () => {
    return ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.CHECK_MIC_PERMISSION)
  },

  requestMicrophonePermission: () => {
    return ipcRenderer.invoke(VOICE_DICTATION_IPC_CHANNELS.REQUEST_MIC_PERMISSION)
  },

  onTrayOpenAgentSession: (callback: (data: TrayOpenAgentSessionData) => void) => {
    const listener = (_: unknown, data: TrayOpenAgentSessionData): void => callback(data)
    ipcRenderer.on(TRAY_IPC_CHANNELS.OPEN_AGENT_SESSION, listener)
    return () => { ipcRenderer.removeListener(TRAY_IPC_CHANNELS.OPEN_AGENT_SESSION, listener) }
  },

  onTrayCreateSession: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(TRAY_IPC_CHANNELS.CREATE_SESSION, listener)
    return () => { ipcRenderer.removeListener(TRAY_IPC_CHANNELS.CREATE_SESSION, listener) }
  },

  migrationGetExportPreview: (workspaceId: string) => {
    return ipcRenderer.invoke('migration:getExportPreview', workspaceId)
  },

  migrationGetShareExportPreview: () => {
    return ipcRenderer.invoke('migration:getShareExportPreview')
  },

  migrationExport: (options: unknown) => {
    return ipcRenderer.invoke('migration:export', options)
  },

  migrationExportV2: (options: unknown) => {
    return ipcRenderer.invoke('migration:exportV2', options)
  },

  migrationParseImportFile: (filePath: string) => {
    return ipcRenderer.invoke('migration:parseImportFile', filePath)
  },

  migrationConfirmImport: (options: unknown) => {
    return ipcRenderer.invoke('migration:confirmImport', options)
  },

  migrationOpenFileDialog: () => {
    return ipcRenderer.invoke('migration:openFileDialog')
  },

  migrationSaveFileDialog: (mode: string) => {
    return ipcRenderer.invoke('migration:saveFileDialog', mode)
  },

  onMigrationOpenImportFile: (callback: (data: { filePath: string }) => void) => {
    const listener = (_: unknown, data: { filePath: string }): void => callback(data)
    ipcRenderer.on('migration:open-import-file', listener)
    return () => { ipcRenderer.removeListener('migration:open-import-file', listener) }
  },

  // ===== 存储管理 =====

  getStorageStats: () => {
    return ipcRenderer.invoke(STORAGE_IPC_CHANNELS.GET_STATS)
  },

  cleanupStorage: (options: unknown) => {
    return ipcRenderer.invoke(STORAGE_IPC_CHANNELS.CLEANUP, options)
  },

  cleanupTempStorage: () => {
    return ipcRenderer.invoke(STORAGE_IPC_CHANNELS.CLEANUP_TEMP)
  },

  migrationCancelImport: (tempDir: string) => {
    return ipcRenderer.invoke('migration:cancelImport', tempDir)
  },

  // ===== 定时任务（Automation）=====
  listAutomations: () => ipcRenderer.invoke(AUTOMATION_IPC_CHANNELS.LIST),
  createAutomation: (input: CreateAutomationInput) =>
    ipcRenderer.invoke(AUTOMATION_IPC_CHANNELS.CREATE, input),
  updateAutomation: (input: UpdateAutomationInput) =>
    ipcRenderer.invoke(AUTOMATION_IPC_CHANNELS.UPDATE, input),
  deleteAutomation: (id: string) =>
    ipcRenderer.invoke(AUTOMATION_IPC_CHANNELS.DELETE, id),
  toggleAutomation: (id: string, active: boolean) =>
    ipcRenderer.invoke(AUTOMATION_IPC_CHANNELS.TOGGLE, id, active),
  runAutomationNow: (id: string) =>
    ipcRenderer.invoke(AUTOMATION_IPC_CHANNELS.RUN_NOW, id),
  onAutomationChanged: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(AUTOMATION_IPC_CHANNELS.CHANGED, listener)
    return () => { ipcRenderer.removeListener(AUTOMATION_IPC_CHANNELS.CHANGED, listener) }
  },

  // ===== 任务 / 日程（Planning）=====
  openPlanningWindow: () => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.OPEN_WINDOW),
  listTodos: (query?: TodoListQuery) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.LIST_TODOS, query),
  createTodo: (input: CreateTodoInput) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.CREATE_TODO, input),
  startTodoAgent: (input: StartTodoAgentInput) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.START_TODO_AGENT, input),
  onTodoAgentSessionReady: (callback: (activation: TodoAgentSessionActivation) => void) => {
    const listener = (_: Electron.IpcRendererEvent, activation: TodoAgentSessionActivation): void => callback(activation)
    ipcRenderer.on(PLANNING_IPC_CHANNELS.TODO_AGENT_SESSION_READY, listener)
    return () => { ipcRenderer.removeListener(PLANNING_IPC_CHANNELS.TODO_AGENT_SESSION_READY, listener) }
  },
  updateTodo: (input: UpdateTodoInput) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.UPDATE_TODO, input),
  deleteTodo: (id: string) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.DELETE_TODO, id),
  listCalendarEvents: (query?: CalendarEventListQuery) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.LIST_CALENDAR_EVENTS, query),
  createCalendarEvent: (input: CreateCalendarEventInput) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.CREATE_CALENDAR_EVENT, input),
  updateCalendarEvent: (input: UpdateCalendarEventInput) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.UPDATE_CALENDAR_EVENT, input),
  deleteCalendarEvent: (id: string) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.DELETE_CALENDAR_EVENT, id),
  listPlanningGroups: (scope: PlanningGroupScope) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.LIST_GROUPS, scope),
  createPlanningGroup: (input: CreatePlanningGroupInput) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.CREATE_GROUP, input),
  updatePlanningGroup: (input: UpdatePlanningGroupInput) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.UPDATE_GROUP, input),
  deletePlanningGroup: (scope: PlanningGroupScope, id: string) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.DELETE_GROUP, scope, id),
  listPlanningTags: () => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.LIST_TAGS),
  listActivePlanningReminders: () => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.LIST_ACTIVE_REMINDERS),
  acknowledgePlanningReminder: (id: string) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.ACKNOWLEDGE_REMINDER, id),
  snoozePlanningReminder: (input: SnoozePlanningReminderInput) => ipcRenderer.invoke(PLANNING_IPC_CHANNELS.SNOOZE_REMINDER, input),
  onPlanningRemindersDue: (callback: (reminders: ActivePlanningReminder[]) => void) => {
    const listener = (_: Electron.IpcRendererEvent, reminders: ActivePlanningReminder[]): void => callback(reminders)
    ipcRenderer.on(PLANNING_IPC_CHANNELS.REMINDER_DUE, listener)
    return () => { ipcRenderer.removeListener(PLANNING_IPC_CHANNELS.REMINDER_DUE, listener) }
  },
  onPlanningChanged: (callback: (change: PlanningChange) => void) => {
    const listener = (_: Electron.IpcRendererEvent, change: PlanningChange): void => callback(change)
    ipcRenderer.on(PLANNING_IPC_CHANNELS.CHANGED, listener)
    return () => { ipcRenderer.removeListener(PLANNING_IPC_CHANNELS.CHANGED, listener) }
  },
  onPlanningAgentOperation: (callback: (operation: PlanningAgentOperation) => void) => {
    const listener = (_: Electron.IpcRendererEvent, operation: PlanningAgentOperation): void => callback(operation)
    ipcRenderer.on(PLANNING_IPC_CHANNELS.AGENT_OPERATION, listener)
    return () => { ipcRenderer.removeListener(PLANNING_IPC_CHANNELS.AGENT_OPERATION, listener) }
  },

}

// 将 API 暴露到渲染进程的 window 对象上
contextBridge.exposeInMainWorld('electronAPI', electronAPI)

// 扩展 Window 接口的类型定义
declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
