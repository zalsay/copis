/**
 * Agent 会话回退服务
 *
 * 回退只操作持久化会话状态，不依赖 Pi Adapter 或 AgentOrchestrator。
 * 运行状态由调用方显式提供，后续可直接接入 RPC Worker run registry。
 */

import { accessSync, constants, realpathSync } from 'node:fs'
import { type AgentSessionMeta, type AgentWorkspace, type LocalProjectRootStatus, normalizePathForCompare, type RewindSessionResult, type SDKMessage } from '@copis/shared'
import {
  getAgentSessionMeta,
  listAgentSessions,
  rewindPiAgentSession,
  truncateSDKMessages,
} from './agent-session-manager'
import { getAgentWorkspace, getLocalProjectRootStatus } from './agent-workspace-manager'

export interface AgentSessionRewindRunState {
  /** 返回会话当前是否由任一运行时持有。 */
  isSessionActive: (sessionId: string) => boolean | Promise<boolean>
}

export interface AgentSessionRewindDependencies {
  getAgentSessionMeta: (sessionId: string) => AgentSessionMeta | undefined
  listAgentSessions: () => AgentSessionMeta[]
  getAgentWorkspace: (workspaceId: string) => AgentWorkspace | undefined
  getLocalProjectRootStatus: (projectRootPath: string | undefined) => LocalProjectRootStatus | undefined
  rewindPiAgentSession: (sessionId: string, assistantMessageUuid: string) => Promise<void>
  truncateSDKMessages: (sessionId: string, assistantMessageUuid: string) => SDKMessage[]
}

const defaultDependencies: AgentSessionRewindDependencies = {
  getAgentSessionMeta,
  listAgentSessions,
  getAgentWorkspace,
  getLocalProjectRootStatus,
  rewindPiAgentSession,
  truncateSDKMessages,
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

/** 验证本地项目根，并返回用于跨会话比较的真实规范化路径。 */
function resolveLocalProjectRootForRewind(
  projectRootPath: string,
  getRootStatus: AgentSessionRewindDependencies['getLocalProjectRootStatus'],
): string {
  const status = getRootStatus(projectRootPath)
  if (status !== 'available') {
    throw createLocalProjectRootUnavailableError(projectRootPath, status)
  }

  try {
    accessSync(projectRootPath, constants.R_OK | constants.W_OK | constants.X_OK)
    const realRoot = realpathSync(projectRootPath)
    const normalizedRoot = normalizePathForCompare(realRoot) || realRoot
    return process.platform === 'win32' ? normalizedRoot.toLowerCase() : normalizedRoot
  } catch {
    throw createLocalProjectRootUnavailableError(projectRootPath, 'unavailable')
  }
}

/**
 * 独立的会话回退服务。
 *
 * Pi artifact 的分支和 Copis SDK JSONL 截断必须保持顺序：只有 artifact
 * 成功回退后才截断展示历史，避免失败时留下无法 resume 的对话记录。
 */
export class AgentSessionRewindService {
  constructor(private readonly dependencies: AgentSessionRewindDependencies = defaultDependencies) {}

  /** 回退会话到指定 assistant 消息（inclusive）。 */
  async rewind(
    sessionId: string,
    assistantMessageUuid: string,
    runState: AgentSessionRewindRunState,
  ): Promise<RewindSessionResult> {
    // JSONL 在运行中可能被 Worker 或 legacy runtime 追加，必须拒绝回退。
    if (await runState.isSessionActive(sessionId)) {
      throw new Error('会话正在运行中，请停止后再回退')
    }

    const sessionMeta = this.dependencies.getAgentSessionMeta(sessionId)
    if (!sessionMeta?.sdkSessionId) {
      throw new Error('会话没有 SDK session ID，无法回退')
    }

    const workspace = sessionMeta.workspaceId
      ? this.dependencies.getAgentWorkspace(sessionMeta.workspaceId)
      : undefined
    const localProjectRoot = workspace?.projectRootPath
      ? resolveLocalProjectRootForRewind(
        workspace.projectRootPath,
        this.dependencies.getLocalProjectRootStatus,
      )
      : undefined

    if (localProjectRoot && await this.hasOtherActiveSessionForLocalProjectRoot(
      sessionId,
      localProjectRoot,
      runState,
    )) {
      throw new Error('同一项目的其他会话正在运行，请先停止同项目的其他会话后再回退文件')
    }

    await this.dependencies.rewindPiAgentSession(sessionId, assistantMessageUuid)
    const kept = this.dependencies.truncateSDKMessages(sessionId, assistantMessageUuid)

    console.log(`[Agent 会话回退] Pi 回退完成: sessionId=${sessionId}, 保留 ${kept.length} 条消息`)

    return {
      remainingMessages: kept.length,
      fileRewind: {
        canRewind: false,
        error: '已回退 Pi 对话；Pi 文件回退尚未启用，当前未修改任何文件。',
      },
    }
  }

  /** 同一个真实本地项目根不能与另一运行中会话并发回退文件。 */
  private async hasOtherActiveSessionForLocalProjectRoot(
    sessionId: string,
    localProjectRoot: string,
    runState: AgentSessionRewindRunState,
  ): Promise<boolean> {
    for (const activeSession of this.dependencies.listAgentSessions()) {
      if (activeSession.id === sessionId || !(await runState.isSessionActive(activeSession.id))) continue
      if (!activeSession.workspaceId) continue

      const activeWorkspace = this.dependencies.getAgentWorkspace(activeSession.workspaceId)
      if (!activeWorkspace?.projectRootPath) continue

      try {
        if (resolveLocalProjectRootForRewind(
          activeWorkspace.projectRootPath,
          this.dependencies.getLocalProjectRootStatus,
        ) === localProjectRoot) {
          return true
        }
      } catch {
        // 运行中的会话已通过启动时校验；根目录后来不可用时无法安全比较，保持旧逻辑跳过。
      }
    }

    return false
  }
}

export const agentSessionRewindService = new AgentSessionRewindService()
