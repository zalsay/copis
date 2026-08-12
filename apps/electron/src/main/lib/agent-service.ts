/**
 * Agent 服务层（IPC 薄层）
 *
 * 职责：
 * - 创建 Agent RPC gateway / EventBus 实例
 * - 注册 EventBus IPC 转发中间件（webContents.send）
 * - 导出 IPC handler 调用的薄包装函数
 * - 文件操作（saveFilesToAgentSession）
 *
 * Pi 执行统一委托给 Rust HTTP API + Pi Worker；本模块只保留 IPC、事件和本地附件包装。
 */

import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { accessSync, constants, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { BrowserWindow } from 'electron'
import type { WebContents } from 'electron'
import { AGENT_IPC_CHANNELS, MAX_ATTACHMENT_SIZE } from '@copis/shared'
import type {
  AgentSendInput,
  AgentGenerateTitleInput,
  AgentSaveFilesInput,
  AgentSaveWorkspaceFilesInput,
  AgentSavedFile,
  AgentStreamEvent,
  AgentStreamCompletePayload,
  AgentStreamPayload,
  AgentQueueMessageInput,
  CopisPermissionMode,
  AgentExternalRunSource,
  AgentMessage,
  RewindSessionResult,
} from '@copis/shared'
import { AgentEventBus } from './agent-event-bus'
import { agentRpcGateway } from './agent-rpc-gateway'
import { agentSessionRewindService } from './agent-session-rewind-service'
import { getAgentSessionWorkspacePath } from './config-paths'
import { ensureAgentWorkspaceWritableRoot, getAgentWorkspaceBySlug, getLocalProjectRootStatus } from './agent-workspace-manager'
import { getAgentSessionMeta, updateAgentSessionMeta } from './agent-session-manager'
import { setAgentStopper, setHeadlessAgentRunner } from './agent-headless-runner-registry'
import { getHeadlessAgentRunTarget } from './agent-headless-run-target'
import { sendAgentStreamComplete } from './agent-completion-payload'
import { getHttpApiInternalToken } from './http-api-server'

// ===== 实例创建 =====

const eventBus = new AgentEventBus()

/** 导出 EventBus 供飞书 Bridge 等外部服务订阅事件 */
export { eventBus as agentEventBus }

// 注册协作子会话 EventBus 阻塞事件监听
import('./agent-collaboration-tools').then(({ registerCollaborationEventBus }) => {
  registerCollaborationEventBus(eventBus)
}).catch(() => { /* collaboration 模块可能未加载 */ })

/**
 * 会话 → webContents 映射
 *
 * EventBus IPC 转发中间件通过此映射找到目标 webContents。
 * runAgent 开始时注册，结束时清理。
 */
const sessionWebContents = new Map<string, WebContents>()

/**
 * 已挂载 destroyed 回收钩子的 webContents 集合。
 *
 * 同一个主窗口 webContents 可能被多次注册（飞书 Bridge 每条消息触发一次 runAgentHeadless），
 * 用 WeakSet 去重避免 once listener 在同一 wc 上累积，触发 MaxListenersExceededWarning。
 */
const wcWithCleanupHook = new WeakSet<WebContents>()

/**
 * 注册 sessionId → webContents 映射，并在 webContents 销毁时自动清理所有相关条目。
 *
 * 仅依赖 finally 块清理无法覆盖窗口关闭、渲染进程崩溃、headless 路径主窗口被替换等
 * webContents 提前销毁的场景——destroyed 事件兜底。
 */
function registerWebContents(sessionId: string, wc: WebContents): void {
  // 同一 sessionId 切换 webContents 时直接覆盖；旧 wc 的 destroyed 钩子仍由 WeakSet 持有，
  // 触发时会扫描 sessionWebContents 清理所有指向旧 wc 的条目（见下方实现）。
  sessionWebContents.set(sessionId, wc)
  if (wcWithCleanupHook.has(wc)) return
  wcWithCleanupHook.add(wc)
  wc.once('destroyed', () => {
    // 单个 wc 可能映射到多个 sessionId（同窗口多 tab），需要清理所有指向它的条目
    for (const [sid, mappedWc] of sessionWebContents) {
      if (mappedWc === wc) sessionWebContents.delete(sid)
    }
  })
}

function isMainRendererWindow(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return false
  const url = win.webContents.getURL()
  if (!url) return false
  if (url.startsWith('data:')) return false
  return !url.includes('window=quick-task')
    && !url.includes('window=voice-dictation')
    && !url.includes('window=detached-preview')
}

function getMainRendererWebContents(): WebContents | null {
  const win = BrowserWindow.getAllWindows().find(isMainRendererWindow)
  return win && !win.webContents.isDestroyed() ? win.webContents : null
}

function getExternalRunWebContents(sessionId: string): WebContents | null {
  const current = sessionWebContents.get(sessionId)
  if (current && !current.isDestroyed()) return current
  const fallback = getMainRendererWebContents()
  if (fallback) registerWebContents(sessionId, fallback)
  return fallback
}

/** Rust 管理 Worker 生命周期时，仍使用统一的 Agent 事件与完成通知通道。 */
export function forwardExternalAgentRunStarted(input: {
  sessionId: string
  startedAt: number
  triggeredBy: AgentSendInput['triggeredBy']
}): void {
  getExternalRunWebContents(input.sessionId)
  const session = getAgentSessionMeta(input.sessionId)
  eventBus.emit(input.sessionId, {
    kind: 'copis_event',
    event: {
      type: 'external_run_started',
      source: 'bridge',
      sessionId: input.sessionId,
      title: session?.title,
      workspaceId: session?.workspaceId,
      modelId: session?.modelId,
      startedAt: input.startedAt,
      ...(session ? { session } : {}),
    },
  })
}

export function forwardExternalAgentEvent(sessionId: string, payload: AgentStreamPayload): void {
  getExternalRunWebContents(sessionId)
  eventBus.emit(sessionId, payload)
}

export function forwardExternalAgentError(sessionId: string, error: string): void {
  const wc = getExternalRunWebContents(sessionId)
  if (!wc || wc.isDestroyed()) return
  wc.send(AGENT_IPC_CHANNELS.STREAM_ERROR, { sessionId, error })
}

export function forwardExternalAgentComplete(payload: AgentStreamCompletePayload): void {
  const wc = getExternalRunWebContents(payload.sessionId)
  if (wc && !wc.isDestroyed()) sendAgentStreamComplete(wc, payload, payload)
  sessionWebContents.delete(payload.sessionId)
}

// ===== EventBus IPC 转发中间件 =====

eventBus.use((sessionId, payload, next) => {
  const wc = sessionWebContents.get(sessionId)
  if (wc && !wc.isDestroyed()) {
    try {
      wc.send(AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId, payload } as AgentStreamEvent)
    } catch (err) {
      console.error(`[EventBus] wc.send 失败: sessionId=${sessionId}, payload.kind=${(payload as Record<string, unknown>)?.kind}`, err)
    }
  }
  next()
})

// ===== IPC 薄包装函数 =====

/**
 * 运行 Agent 并流式推送事件到渲染进程
 *
 * 注册 webContents 到 EventBus 映射，委托给 Rust Pi Worker gateway。
 */
export async function runAgent(
  input: AgentSendInput,
  webContents: WebContents,
): Promise<void> {
  // 更新 webContents 映射；并发状态由 RPC gateway 与 Rust Worker 共同维护。
  registerWebContents(input.sessionId, webContents)
  // 开始新一轮执行时清除"完成未确认"标记
  try {
    updateAgentSessionMeta(input.sessionId, { completedButUnconfirmed: false })
  } catch { /* 新会话可能尚未写入索引 */ }
  // 自动任务会话"毕业"：用户手动发消息（非定时触发）即视为接管，标记后该会话回到普通项目列表，
  // 调度器也不再复用它注入新的定时运行。
  if (input.triggeredBy !== 'automation') {
    try {
      const meta = getAgentSessionMeta(input.sessionId)
      if (meta?.sourceAutomationId && !meta.automationGraduated) {
        updateAgentSessionMeta(input.sessionId, { automationGraduated: true })
        // 向渲染进程发送毕业事件，触发 toast 提示
        eventBus.emit(input.sessionId, {
          kind: 'copis_event',
          event: { type: 'automation_graduated' },
        })
      }
    } catch { /* 新会话可能尚未写入索引 */ }
  }
  let errorSent = false
  let completeSent = false
  try {
    await agentRpcGateway.run(input, {
      onEvent: ({ sessionId, payload }) => eventBus.emit(sessionId, payload),
      onError: (error) => {
        errorSent = true
        if (!webContents.isDestroyed()) {
          webContents.send(AGENT_IPC_CHANNELS.STREAM_ERROR, {
            sessionId: input.sessionId,
            error,
          })
        }
      },
      onComplete: (messages, complete) => {
        completeSent = true
        if (!webContents.isDestroyed()) {
          sendAgentStreamComplete(webContents, input, {
            messages,
            stoppedByUser: complete?.stoppedByUser ?? false,
            startedAt: complete?.startedAt,
            resultSubtype: complete?.resultSubtype,
            resultErrors: complete?.resultErrors,
          })
        }
      },
      onTitleUpdated: (title) => {
        if (!webContents.isDestroyed()) {
          webContents.send(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
            sessionId: input.sessionId,
            title,
          })
        }
      },
    })
  } catch (err) {
    console.error('[Agent 服务] runAgent 未处理异常:', err)
    const errorMessage = err instanceof Error ? err.message : '未知错误'
    if (!errorSent && !webContents.isDestroyed()) {
      webContents.send(AGENT_IPC_CHANNELS.STREAM_ERROR, {
        sessionId: input.sessionId,
        error: errorMessage,
      })
    }
    if (!completeSent && !webContents.isDestroyed()) {
      sendAgentStreamComplete(webContents, input, { messages: [], stoppedByUser: false })
    }
  } finally {
    // 该调用独占本次 SSE 生命周期；结束后映射不再需要。
    sessionWebContents.delete(input.sessionId)
  }
}

/**
 * 无渲染进程的 Agent 运行（供飞书 Bridge 等外部调用方使用）
 *
 * 如果桌面窗口存在，同时注册 webContents 以便事件同步到桌面端 UI。
 * 事件同时通过 EventBus listeners 分发给飞书 Bridge。
 */
export async function runAgentHeadless(
  input: AgentSendInput,
  callbacks: {
    onError: (error: string) => void
    onComplete: (messages?: AgentMessage[]) => void
    onTitleUpdated: (title: string) => void
    source?: AgentExternalRunSource
    originSessionId?: string
  },
): Promise<void> {
  // 委派子会话优先回到父会话所在 renderer，外部无界面运行才回退任意主窗口。
  const wc = getHeadlessAgentRunTarget(
    sessionWebContents,
    callbacks.originSessionId,
    getMainRendererWebContents,
  )
  const runInput: AgentSendInput = input.startedAt != null ? input : { ...input, startedAt: Date.now() }
  const startedAt = runInput.startedAt!
  if (wc) {
    registerWebContents(runInput.sessionId, wc)
  }

  let errorSent = false
  let completeSent = false
  try {
    await agentRpcGateway.run(runInput, {
      onEvent: ({ sessionId, payload }) => eventBus.emit(sessionId, payload),
      onError: (error) => {
        errorSent = true
        callbacks.onError(error)
        // 同步到渲染进程
        if (wc && !wc.isDestroyed()) {
          wc.send(AGENT_IPC_CHANNELS.STREAM_ERROR, {
            sessionId: runInput.sessionId,
            error,
          })
        }
      },
      onComplete: (messages, complete) => {
        completeSent = true
        callbacks.onComplete(messages)
        // 同步到渲染进程
        if (wc && !wc.isDestroyed()) {
          sendAgentStreamComplete(wc, runInput, {
            messages,
            stoppedByUser: complete?.stoppedByUser ?? false,
            startedAt: complete?.startedAt,
            resultSubtype: complete?.resultSubtype,
            resultErrors: complete?.resultErrors,
          })
        }
      },
      onTitleUpdated: (title) => {
        callbacks.onTitleUpdated(title)
        // 同步到渲染进程
        if (wc && !wc.isDestroyed()) {
          wc.send(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
            sessionId: runInput.sessionId,
            title,
          })
        }
      },
      onRunStarted: (persistedStartedAt) => {
        const session = getAgentSessionMeta(runInput.sessionId)
        eventBus.emit(runInput.sessionId, {
          kind: 'copis_event',
          event: {
            type: 'external_run_started',
            source: callbacks.source ?? 'bridge',
            sessionId: runInput.sessionId,
            title: session?.title,
            workspaceId: runInput.workspaceId ?? session?.workspaceId,
            modelId: runInput.modelId,
            startedAt: persistedStartedAt,
            ...(session ? { session } : {}),
          },
        })
      },
    })
  } catch (err) {
    console.error('[Agent 服务] runAgentHeadless 未处理异常:', err)
    const errorMessage = err instanceof Error ? err.message : '未知错误'
    if (!errorSent) callbacks.onError(errorMessage)
    if (!completeSent) callbacks.onComplete()
    if (wc && !wc.isDestroyed()) {
      if (!errorSent) wc.send(AGENT_IPC_CHANNELS.STREAM_ERROR, { sessionId: runInput.sessionId, error: errorMessage })
      if (!completeSent) {
        sendAgentStreamComplete(wc, runInput, { messages: [], stoppedByUser: false, startedAt })
      }
    }
  } finally {
    sessionWebContents.delete(runInput.sessionId)
  }
}

/**
 * 生成 Agent 会话标题
 */
export async function generateAgentTitle(input: AgentGenerateTitleInput): Promise<string | null> {
  void input
  return null
}

/**
 * 中止指定会话的 Agent 执行
 */
export async function stopAgent(sessionId: string): Promise<void> {
  await agentRpcGateway.stop(sessionId)
}

setHeadlessAgentRunner(runAgentHeadless)
setAgentStopper((sessionId) => {
  void stopAgent(sessionId).catch((error: unknown) => {
    console.warn(`[Agent 服务] Rust Worker 停止失败: sessionId=${sessionId}`, error)
  })
})

/**
 * 快照回退：回退到指定消息点，恢复文件 + 截断对话
 */
export async function rewindAgentSession(
  sessionId: string,
  assistantMessageUuid: string,
): Promise<RewindSessionResult> {
  return agentSessionRewindService.rewind(sessionId, assistantMessageUuid, {
    isSessionActive: (candidateSessionId) => agentRpcGateway.isActive(candidateSessionId),
  })
}

/**
 * 检查指定会话是否正在运行
 */
export async function isAgentSessionActive(sessionId: string): Promise<boolean> {
  return agentRpcGateway.isActive(sessionId)
}

/** 是否存在任意运行中 Agent，供更新器等全局生命周期服务安全判断。 */
export async function hasActiveAgentSessions(): Promise<boolean> {
  return agentRpcGateway.hasActiveSessions()
}

/** 返回 Rust Pi Worker 当前持有的会话，用于托盘等跨窗口展示。 */
export async function getActiveAgentSessionIds(): Promise<string[]> {
  return agentRpcGateway.activeSessionIds()
}

/** 中止所有活跃的 Agent 会话（应用退出时调用） */
export async function stopAllAgents(): Promise<void> {
  await agentRpcGateway.stopAll()
}

/** 退出前清理 Pi runtime 资源。 */
export function cleanupAgentRuntimeResources(): void {
  // Pi runtime 由 Rust Worker 生命周期管理，主进程不再持有 Adapter 资源。
}

/**
 * 运行中动态切换会话的权限模式
 *
 * Rust 先下发 Worker 状态事件，再原子更新文件策略；Pi 不持有权限策略。
 */
export async function updateAgentPermissionMode(sessionId: string, mode: CopisPermissionMode): Promise<void> {
  const internalToken = getHttpApiInternalToken()
  if (!internalToken) throw new Error('Rust HTTP API 内部令牌不可用')
  const updated = await agentRpcGateway.updatePermissionMode(sessionId, mode, internalToken)
  if (!updated) return
}

// ===== 流式追加消息 =====

/**
 * 在 Agent 流式中追加发送消息
 *
 * 使用 'now' 优先级立即注入 SDK 并持久化。
 */
export async function queueAgentMessage(
  input: AgentQueueMessageInput,
  _webContents: WebContents,
): Promise<string> {
  return agentRpcGateway.queue(input)
}

// ===== 文件操作 =====

/**
 * 保存文件到 Agent session 工作目录
 *
 * 将 base64 编码的文件写入当前会话的私有工作目录，供 Agent 通过授权的附加目录读取。
 */
export function saveFilesToAgentSession(input: AgentSaveFilesInput): AgentSavedFile[] {
  const sessionDir = getAgentSessionWorkspacePath(input.workspaceSlug, input.sessionId)
  const results: AgentSavedFile[] = []
  const usedPaths = new Set<string>()

  for (const file of input.files) {
    let targetPath = join(sessionDir, file.filename)

    // 防止同名文件覆盖
    if (usedPaths.has(targetPath) || existsSync(targetPath)) {
      const dotIdx = file.filename.lastIndexOf('.')
      const baseName = dotIdx > 0 ? file.filename.slice(0, dotIdx) : file.filename
      const ext = dotIdx > 0 ? file.filename.slice(dotIdx) : ''
      let counter = 1
      let candidate = join(sessionDir, `${baseName}-${counter}${ext}`)
      while (usedPaths.has(candidate) || existsSync(candidate)) {
        counter++
        candidate = join(sessionDir, `${baseName}-${counter}${ext}`)
      }
      targetPath = candidate
    }
    usedPaths.add(targetPath)

    mkdirSync(dirname(targetPath), { recursive: true })

    // 防御性检查：base64 字符串长度估算是否超 100MB 限制
    // base64 编码膨胀率约 4/3，data.length * 0.75 ≈ 原始字节数
    if (file.data.length * 0.75 > MAX_ATTACHMENT_SIZE) {
      console.warn(`[Agent 服务] 文件超过 100MB 限制，跳过: ${file.filename} (预估 ${(file.data.length * 0.75 / 1024 / 1024).toFixed(1)}MB)`)
      continue
    }

    const buffer = Buffer.from(file.data, 'base64')
    writeFileSync(targetPath, buffer)

    const actualFilename = targetPath.slice(sessionDir.length + 1)
    results.push({ filename: actualFilename, targetPath })
    console.log(`[Agent 服务] 文件已保存: ${targetPath} (${buffer.length} bytes)`)
  }

  return results
}

const LOCAL_PROJECT_ROOT_UNAVAILABLE_CODE = 'local_project_root_unavailable'

function createLocalProjectRootUnavailableError(projectRootPath: string, status?: string): Error {
  const error = new Error(
    `本地项目根目录不可用: 本地项目根目录不存在或无法访问：${projectRootPath}。请在 Copis 中重新选择项目文件夹。`,
  ) as Error & { code?: string; details?: string[] }
  error.code = LOCAL_PROJECT_ROOT_UNAVAILABLE_CODE
  error.details = status ? [`目录状态: ${status}`] : undefined
  return error
}

function resolveSafeWorkspaceFilePath(workspaceRoot: string, filename: string): string {
  const hasParentTraversal = filename.split(/[\\/]+/).some((segment) => segment === '..')
  if (!filename || isAbsolute(filename) || win32.isAbsolute(filename) || hasParentTraversal) {
    throw new Error(`项目文件名不安全，拒绝保存: ${filename}`)
  }

  const resolvedRoot = resolve(workspaceRoot)
  const targetPath = resolve(resolvedRoot, filename)
  const pathWithinRoot = relative(resolvedRoot, targetPath)
  const escapesRoot = pathWithinRoot === '..'
    || pathWithinRoot.startsWith(`..${sep}`)
    || isAbsolute(pathWithinRoot)

  if (!pathWithinRoot || escapesRoot) {
    throw new Error(`项目文件名不安全，拒绝保存: ${filename}`)
  }

  return targetPath
}

/**
 * 保存文件到 Agent 允许写入的工作区目录。
 *
 * 空白项目使用 Copis 托管目录；用户新建项目统一保存到工作区的 project/，
 * 未授权原始目录写入时使用项目根下的 copis/project/。
 */
export function saveFilesToWorkspaceFiles(input: AgentSaveWorkspaceFilesInput): AgentSavedFile[] {
  const workspace = getAgentWorkspaceBySlug(input.workspaceSlug)
  if (!workspace) {
    throw new Error(`指定的 Agent 项目不存在或已删除: ${input.workspaceSlug}`)
  }

  if (workspace.projectRootPath) {
    const status = getLocalProjectRootStatus(workspace.projectRootPath)
    if (status !== 'available') {
      throw createLocalProjectRootUnavailableError(workspace.projectRootPath, status)
    }
    try {
      accessSync(workspace.projectRootPath, constants.R_OK | constants.W_OK | constants.X_OK)
    } catch {
      throw createLocalProjectRootUnavailableError(workspace.projectRootPath, 'unavailable')
    }
  }

  const wsFilesDir = ensureAgentWorkspaceWritableRoot(workspace)
  const files = input.files.map((file) => ({
    file,
    initialTargetPath: resolveSafeWorkspaceFilePath(wsFilesDir, file.filename),
  }))
  const results: AgentSavedFile[] = []
  const usedPaths = new Set<string>()

  for (const { file, initialTargetPath } of files) {
    let targetPath = initialTargetPath

    // 防止同名文件覆盖
    if (usedPaths.has(targetPath) || existsSync(targetPath)) {
      const relativeFilename = relative(wsFilesDir, targetPath)
      const dotIdx = relativeFilename.lastIndexOf('.')
      const baseName = dotIdx > 0 ? relativeFilename.slice(0, dotIdx) : relativeFilename
      const ext = dotIdx > 0 ? relativeFilename.slice(dotIdx) : ''
      let counter = 1
      let candidate = resolveSafeWorkspaceFilePath(wsFilesDir, `${baseName}-${counter}${ext}`)
      while (usedPaths.has(candidate) || existsSync(candidate)) {
        counter++
        candidate = resolveSafeWorkspaceFilePath(wsFilesDir, `${baseName}-${counter}${ext}`)
      }
      targetPath = candidate
    }
    usedPaths.add(targetPath)

    mkdirSync(dirname(targetPath), { recursive: true })

    if (file.data.length * 0.75 > MAX_ATTACHMENT_SIZE) {
      console.warn(`[Agent 服务] 项目文件超过 100MB 限制，跳过: ${file.filename} (预估 ${(file.data.length * 0.75 / 1024 / 1024).toFixed(1)}MB)`)
      continue
    }

    const buffer = Buffer.from(file.data, 'base64')
    writeFileSync(targetPath, buffer)

    const actualFilename = relative(wsFilesDir, targetPath)
    results.push({ filename: actualFilename, targetPath })
    console.log(`[Agent 服务] 工作区文件已保存: ${targetPath} (${buffer.length} bytes)`)
  }

  return results
}
