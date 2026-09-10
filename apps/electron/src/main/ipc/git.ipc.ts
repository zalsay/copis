import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@copis/shared'
import type { GitRepoStatus, GetFileDiffInput, RevertFileInput } from '@copis/shared'
import { getGitRepoStatus } from '../lib/runtime-init'
import { getUnstagedChanges, getFileDiff, getUntrackedContent, revertFile, getDiffContents, listWorktrees, getWorktreeChanges } from '../lib/git-diff-service'
import { normalizeFileAccessOptions, ensurePathAllowed, isPathAllowed, ensurePathAllowedWithWorktree } from '../lib/ipc-file-access'

export function registerGitIpcHandlers(): void {
  // 获取指定目录的 Git 仓库状态
  ipcMain.handle(
    IPC_CHANNELS.GET_GIT_REPO_STATUS,
    async (_, dirPath: string): Promise<GitRepoStatus | null> => {
      if (!dirPath || typeof dirPath !== 'string') {
        console.warn('[IPC] git:get-repo-status 收到无效的目录路径')
        return null
      }

      return getGitRepoStatus(dirPath)
    }
  )

  // 获取未暂存的变更文件列表
  ipcMain.handle(
    IPC_CHANNELS.GET_UNSTAGED_CHANGES,
    async (_, dirPath: string, sessionPath?: string, workspaceFilesPath?: string, extraPaths?: string[], sessionId?: string) => {
      if (!dirPath || typeof dirPath !== 'string') {
        console.warn('[IPC] git:get-unstaged-changes 收到无效的目录路径')
        return { isGitRepo: false, files: [], untrackedFiles: [], gitRootNames: [] }
      }
      const access = normalizeFileAccessOptions({ sessionId })
      if (!ensurePathAllowed(dirPath, access)) {
        return { isGitRepo: false, files: [], untrackedFiles: [], gitRootNames: [] }
      }
      const allowedSessionPath = sessionPath && isPathAllowed(sessionPath, access) ? sessionPath : undefined
      const allowedWorkspaceFilesPath = workspaceFilesPath && isPathAllowed(workspaceFilesPath, access) ? workspaceFilesPath : undefined
      const allowedExtraPaths = extraPaths?.filter((p) => isPathAllowed(p, access))
      return getUnstagedChanges(dirPath, allowedSessionPath, allowedWorkspaceFilesPath, allowedExtraPaths)
    }
  )

  // 获取单个文件的 diff
  ipcMain.handle(
    IPC_CHANNELS.GET_FILE_DIFF,
    async (_, input: GetFileDiffInput) => {
      const { dirPath, filePath, gitRoot, sessionId } = input
      if (!dirPath || !filePath || typeof dirPath !== 'string' || typeof filePath !== 'string') {
        console.warn('[IPC] git:get-file-diff 收到无效参数')
        return ''
      }
      const access = normalizeFileAccessOptions({ sessionId })
      if (!(await ensurePathAllowedWithWorktree(dirPath, access)) || (gitRoot && !(await ensurePathAllowedWithWorktree(gitRoot, access)))) return ''
      return getFileDiff(dirPath, filePath, gitRoot)
    }
  )

  // 获取未追踪文件内容
  ipcMain.handle(
    IPC_CHANNELS.GET_UNTRACKED_CONTENT,
    async (_, input: GetFileDiffInput) => {
      const { dirPath, filePath, gitRoot, sessionId } = input
      if (!dirPath || !filePath || typeof dirPath !== 'string' || typeof filePath !== 'string') {
        console.warn('[IPC] git:get-untracked-content 收到无效参数')
        return ''
      }
      const access = normalizeFileAccessOptions({ sessionId })
      if (!(await ensurePathAllowedWithWorktree(dirPath, access)) || (gitRoot && !(await ensurePathAllowedWithWorktree(gitRoot, access)))) return ''
      return getUntrackedContent(dirPath, filePath, gitRoot)
    }
  )

  // 还原文件变更
  ipcMain.handle(
    IPC_CHANNELS.REVERT_FILE,
    async (_, input: RevertFileInput) => {
      const { dirPath, filePath, gitRoot, sessionId } = input
      if (!dirPath || !filePath || typeof dirPath !== 'string' || typeof filePath !== 'string') {
        console.warn('[IPC] git:revert-file 收到无效参数')
        return
      }
      const access = normalizeFileAccessOptions({ sessionId })
      if (!(await ensurePathAllowedWithWorktree(dirPath, access)) || (gitRoot && !(await ensurePathAllowedWithWorktree(gitRoot, access)))) return
      await revertFile(dirPath, filePath, gitRoot)
    }
  )

  // 获取文件新旧版本内容
  ipcMain.handle(
    IPC_CHANNELS.GET_DIFF_CONTENTS,
    async (_, input: GetFileDiffInput) => {
      const { dirPath, filePath, gitRoot, sessionId } = input
      if (!dirPath || !filePath || typeof dirPath !== 'string' || typeof filePath !== 'string') {
        console.warn('[IPC] git:get-diff-contents 收到无效参数')
        return null
      }
      const access = normalizeFileAccessOptions({ sessionId })
      if (!(await ensurePathAllowedWithWorktree(dirPath, access)) || (gitRoot && !(await ensurePathAllowedWithWorktree(gitRoot, access)))) return null
      return getDiffContents(dirPath, filePath, gitRoot, input.baseRef)
    }
  )

  // 列出 Git Worktree（只读取 worktree 元信息，不涉及文件内容，跳过路径安全检查）
  ipcMain.handle(
    IPC_CHANNELS.LIST_WORKTREES,
    async (_, repoPath: string, _sessionId: string) => {
      if (!repoPath || typeof repoPath !== 'string') return []
      return await listWorktrees(repoPath)
    }
  )

  // 获取 Worktree 相对于基准分支的全量变更
  ipcMain.handle(
    IPC_CHANNELS.GET_WORKTREE_CHANGES,
    async (_, worktreePath: string, baseBranch: string, sessionId: string) => {
      if (!worktreePath || typeof worktreePath !== 'string') {
        return { isGitRepo: false, files: [], untrackedFiles: [], gitRootNames: [] }
      }
      const access = normalizeFileAccessOptions({ sessionId })
      if (!(await ensurePathAllowedWithWorktree(worktreePath, access))) {
        return { isGitRepo: false, files: [], untrackedFiles: [], gitRootNames: [] }
      }
      return getWorktreeChanges(worktreePath, baseBranch)
    }
  )
}
