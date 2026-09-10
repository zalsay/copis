import { ipcMain } from 'electron'
import { resolve } from 'node:path'
import { realpathSync, statSync } from 'node:fs'
import { AGENT_IPC_CHANNELS } from '@copis/shared'
import type { AgentAttachDirectoryInput, AgentAttachFileInput, WorkspaceAttachDirectoryInput, WorkspaceAttachFileInput } from '@copis/shared'
import { getAgentSessionMeta, updateAgentSessionMeta } from '../lib/agent-session-manager'
import { getWorkspaceAttachedDirectories, getWorkspaceAttachedFiles, attachWorkspaceDirectory, attachWorkspaceFile, detachWorkspaceDirectory, detachWorkspaceFile, getWorktreeRepos, addWorktreeRepo, removeWorktreeRepo } from '../lib/agent-workspace-manager'
import { watchAttachedDirectory } from '../lib/workspace-watcher'
import { requireAttachedPath } from '../lib/attached-paths'
import { releaseDirectoryWatcherIfUnreferenced } from '../lib/attached-path-lifecycle'

export function registerAttachedPathsIpcHandlers(): void {
  // 附加外部目录到 Agent 会话
  ipcMain.handle(
    AGENT_IPC_CHANNELS.ATTACH_DIRECTORY,
    async (_, input: AgentAttachDirectoryInput): Promise<string[]> => {
      const meta = getAgentSessionMeta(input.sessionId)
      if (!meta) throw new Error(`会话不存在: ${input.sessionId}`)
      const directoryPath = requireAttachedPath(input.directoryPath, '附加目录路径')

      const existing = meta.attachedDirectories ?? []
      if (existing.includes(directoryPath)) return existing

      const updated = [...existing, directoryPath]
      updateAgentSessionMeta(input.sessionId, { attachedDirectories: updated })
      // 启动附加目录文件监听
      watchAttachedDirectory(directoryPath)
      return updated
    }
  )

  // 移除会话的附加目录
  ipcMain.handle(
    AGENT_IPC_CHANNELS.DETACH_DIRECTORY,
    async (_, input: AgentAttachDirectoryInput): Promise<string[]> => {
      const meta = getAgentSessionMeta(input.sessionId)
      if (!meta) throw new Error(`会话不存在: ${input.sessionId}`)
      const directoryPath = requireAttachedPath(input.directoryPath, '附加目录路径')

      const existing = meta.attachedDirectories ?? []
      const updated = existing.filter((d) => d !== directoryPath)
      updateAgentSessionMeta(input.sessionId, { attachedDirectories: updated })
      releaseDirectoryWatcherIfUnreferenced(directoryPath)
      return updated
    }
  )

  // 附加外部文件到 Agent 会话
  ipcMain.handle(
    AGENT_IPC_CHANNELS.ATTACH_FILE,
    async (_, input: AgentAttachFileInput): Promise<string[]> => {
      const meta = getAgentSessionMeta(input.sessionId)
      if (!meta) throw new Error(`会话不存在: ${input.sessionId}`)
      const filePath = requireAttachedPath(input.filePath, '附加文件路径')

      const { realpathSync, statSync } = await import('node:fs')
      const { resolve } = await import('node:path')
      const safePath = realpathSync(resolve(filePath))
      const stats = statSync(safePath)
      if (!stats.isFile()) throw new Error('只能附加文件')

      const existing = meta.attachedFiles ?? []
      if (existing.includes(safePath)) return existing

      const updated = [...existing, safePath]
      updateAgentSessionMeta(input.sessionId, { attachedFiles: updated })
      return updated
    }
  )

  // 移除会话的附加文件
  ipcMain.handle(
    AGENT_IPC_CHANNELS.DETACH_FILE,
    async (_, input: AgentAttachFileInput): Promise<string[]> => {
      const meta = getAgentSessionMeta(input.sessionId)
      if (!meta) throw new Error(`会话不存在: ${input.sessionId}`)
      const filePath = requireAttachedPath(input.filePath, '附加文件路径')

      const existing = meta.attachedFiles ?? []
      const updated = existing.filter((f) => f !== filePath)
      updateAgentSessionMeta(input.sessionId, { attachedFiles: updated })
      return updated
    }
  )

  // 附加外部目录到工作区（所有会话可访问）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.ATTACH_WORKSPACE_DIRECTORY,
    async (_, input: WorkspaceAttachDirectoryInput): Promise<string[]> => {
      const directoryPath = requireAttachedPath(input.directoryPath, '附加目录路径')
      const updated = attachWorkspaceDirectory(input.workspaceSlug, directoryPath)
      watchAttachedDirectory(directoryPath)
      return updated
    }
  )

  // 移除工作区的附加目录
  ipcMain.handle(
    AGENT_IPC_CHANNELS.DETACH_WORKSPACE_DIRECTORY,
    async (_, input: WorkspaceAttachDirectoryInput): Promise<string[]> => {
      const directoryPath = requireAttachedPath(input.directoryPath, '附加目录路径')
      const updated = detachWorkspaceDirectory(input.workspaceSlug, directoryPath)
      releaseDirectoryWatcherIfUnreferenced(directoryPath)
      return updated
    }
  )

  // 附加外部文件到工作区（所有会话可访问）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.ATTACH_WORKSPACE_FILE,
    async (_, input: WorkspaceAttachFileInput): Promise<string[]> => {
      const filePath = requireAttachedPath(input.filePath, '附加文件路径')
      const { realpathSync, statSync } = await import('node:fs')
      const { resolve } = await import('node:path')
      const safePath = realpathSync(resolve(filePath))
      const stats = statSync(safePath)
      if (!stats.isFile()) throw new Error('只能附加文件')

      return attachWorkspaceFile(input.workspaceSlug, safePath)
    }
  )

  // 移除工作区的附加文件
  ipcMain.handle(
    AGENT_IPC_CHANNELS.DETACH_WORKSPACE_FILE,
    async (_, input: WorkspaceAttachFileInput): Promise<string[]> => {
      const filePath = requireAttachedPath(input.filePath, '附加文件路径')
      return detachWorkspaceFile(input.workspaceSlug, filePath)
    }
  )

  // 获取工作区附加目录列表
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_WORKSPACE_DIRECTORIES,
    async (_, workspaceSlug: string): Promise<string[]> => {
      return getWorkspaceAttachedDirectories(workspaceSlug)
    }
  )

  // 获取工作区附加文件列表
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_WORKSPACE_ATTACHED_FILES,
    async (_, workspaceSlug: string): Promise<string[]> => {
      return getWorkspaceAttachedFiles(workspaceSlug)
    }
  )

  // ===== Worktree 仓库配置管理 =====

  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_WORKTREE_REPOS,
    async (_, workspaceSlug: string) => {
      return await getWorktreeRepos(workspaceSlug)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.ADD_WORKTREE_REPO,
    async (_, workspaceSlug: string, repo: import('@copis/shared').WorkspaceWorktreeRepo) => {
      return addWorktreeRepo(workspaceSlug, repo)
    }
  )

  ipcMain.handle(
    AGENT_IPC_CHANNELS.REMOVE_WORKTREE_REPO,
    async (_, workspaceSlug: string, repoPath: string) => {
      return removeWorktreeRepo(workspaceSlug, repoPath)
    }
  )
}
