import { ipcMain, shell } from 'electron'
import { dirname, join, resolve, sep } from 'node:path'
import { existsSync, realpathSync, rmSync, statSync } from 'node:fs'
import { IPC_CHANNELS, AGENT_IPC_CHANNELS } from '@copis/shared'
import type { FileEntry, FileAccessOptions } from '@copis/shared'
import { shouldShowProjectFileTreeEntry } from '../lib/file-tree-filter'
import { searchWorkspaceFiles } from '../lib/workspace-file-search'
import { getAgentSessionMeta } from '../lib/agent-session-manager'
import { getAgentSessionWorkspacePath, getAgentWorkspacesDir } from '../lib/config-paths'
import { getAgentWorkspace, getAgentWorkspaceBySlug, getAgentWorkspaceReadableRoots, getProjectFilesPath, getWorkspaceAttachedDirectories, getWorkspaceAttachedFiles } from '../lib/agent-workspace-manager'
import { movePathSafely } from '../lib/file-move-service'
import { filterAttachedPaths } from '../lib/attached-paths'
import { isPathAllowed, normalizeFileAccessOptions, getPreviewCandidateBasePaths } from '../lib/ipc-file-access'

const MAX_DIRECTORY_ENTRIES = 2000

const HIDDEN_FS_ENTRIES = new Set(['.DS_Store', 'Thumbs.db'])

export function registerAgentFileCoreIpcHandlers(): void {
  // ===== Agent 文件系统操作 =====

  // 获取 session 工作路径
  ipcMain.handle(
    AGENT_IPC_CHANNELS.GET_SESSION_PATH,
    async (_, workspaceId: string, sessionId: string): Promise<string | null> => {
      const ws = getAgentWorkspace(workspaceId)
      if (!ws) return null
      return getAgentSessionWorkspacePath(ws.slug, sessionId)
    }
  )

  // 列出目录内容（浅层，安全校验）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.LIST_DIRECTORY,
    async (_, dirPath: string, access?: FileAccessOptions): Promise<FileEntry[]> => {
      const { existsSync, readdirSync, statSync } = await import('node:fs')
      const { resolve } = await import('node:path')

      const safePath = resolve(dirPath)
      // 目录可能已被删除（如删除 Agent 会话后面板仍持有旧路径），优雅返回空列表
      if (!existsSync(safePath)) {
        return []
      }
      if (!isPathAllowed(safePath, normalizeFileAccessOptions(access))) {
        throw new Error('访问路径超出当前会话的授权范围')
      }

      const entries: FileEntry[] = []
      const items = readdirSync(safePath, { withFileTypes: true })

      for (const item of items) {
        if (HIDDEN_FS_ENTRIES.has(item.name)) continue
        const isDirectory = item.isDirectory()
        if (!shouldShowProjectFileTreeEntry(item.name, isDirectory)) continue
        const fullPath = resolve(safePath, item.name)
        const size = isDirectory ? undefined : statSync(fullPath).size
        entries.push({
          name: item.name,
          path: fullPath,
          isDirectory,
          size,
        })
      }

      // 目录在前，文件在后；隐藏文件（.开头）排在同类末尾，各自按名称排序
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        const aHidden = a.name.startsWith('.')
        const bHidden = b.name.startsWith('.')
        if (aHidden !== bHidden) return aHidden ? 1 : -1
        return a.name.localeCompare(b.name)
      })

      return entries.slice(0, MAX_DIRECTORY_ENTRIES)
    }
  )

  // 删除文件或目录
  ipcMain.handle(
    AGENT_IPC_CHANNELS.DELETE_FILE,
    async (_, filePath: string, access?: FileAccessOptions): Promise<void> => {
      const { rmSync } = await import('node:fs')
      const { resolve } = await import('node:path')

      const safePath = resolve(filePath)
      if (!isPathAllowed(safePath, normalizeFileAccessOptions(access))) {
        throw new Error('访问路径超出当前会话的授权范围')
      }

      rmSync(safePath, { recursive: true, force: true })
      console.log(`[Agent 文件] 已删除: ${safePath}`)
    }
  )

  // 用系统默认应用打开文件
  ipcMain.handle(
    AGENT_IPC_CHANNELS.OPEN_FILE,
    async (_, filePath: string, access?: FileAccessOptions): Promise<void> => {
      const { resolveTargetPath } = await import('../lib/file-preview-service')

      const options = normalizeFileAccessOptions(access)
      const candidateBases = getPreviewCandidateBasePaths(options)
      const safePath = resolveTargetPath(filePath, candidateBases)
      if (!isPathAllowed(safePath, options)) {
        throw new Error('访问路径超出当前会话的授权范围')
      }

      await shell.openPath(safePath)
    }
  )
}

export function registerAgentFileOpenIpcHandlers(): void {
  // 在系统文件管理器中显示文件
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SHOW_IN_FOLDER,
    async (_, filePath: string, access?: FileAccessOptions): Promise<void> => {
      const { resolve } = await import('node:path')

      const safePath = resolve(filePath)
      if (!isPathAllowed(safePath, normalizeFileAccessOptions(access))) {
        throw new Error('访问路径超出当前会话的授权范围')
      }

      shell.showItemInFolder(safePath)
    }
  )

  // 使用 macOS 系统 Terminal 在指定工作目录打开会话/工作区文件夹
  ipcMain.handle(
    AGENT_IPC_CHANNELS.OPEN_FOLDER_IN_TERMINAL,
    async (_, folderPath: string): Promise<void> => {
      if (process.platform !== 'darwin') {
        throw new Error('当前仅支持在 macOS 终端中打开文件夹')
      }
      if (!isPathAllowed(folderPath)) {
        throw new Error('访问路径超出当前会话的授权范围')
      }

      const safePath = realpathSync(resolve(folderPath))
      if (!statSync(safePath).isDirectory()) {
        throw new Error('只能在终端中打开文件夹')
      }

      const { spawn } = await import('node:child_process')
      await new Promise<void>((resolvePromise, reject) => {
        const child = spawn('open', ['-a', 'Terminal', safePath], { detached: true, stdio: 'ignore' })
        child.once('error', reject)
        child.once('spawn', () => {
          child.unref()
          resolvePromise()
        })
      })
    }
  )

  // 在系统文件管理器中显示任意路径（无工作区限制，用户主动点击触发）
  ipcMain.handle(
    IPC_CHANNELS.SHOW_ITEM_IN_FOLDER,
    async (_, filePath: string, candidateBasePaths?: string[]): Promise<boolean> => {
      const { resolve } = await import('node:path')
      const { existsSync } = await import('node:fs')
      const { resolveTargetPath } = await import('../lib/file-preview-service')

      const resolvedPath = resolveTargetPath(filePath, candidateBasePaths?.length ? candidateBasePaths : undefined)
      if (!existsSync(resolvedPath)) {
        console.warn('[IPC] shell:show-item-in-folder 路径不存在:', resolvedPath)
        return false
      }
      shell.showItemInFolder(resolve(resolvedPath))
      return true
    }
  )
}

export function registerAgentFileMutationIpcHandlers(): void {
  // 重命名文件/目录
  ipcMain.handle(
    AGENT_IPC_CHANNELS.RENAME_FILE,
    async (_, filePath: string, newName: string, access?: FileAccessOptions): Promise<void> => {
      const { renameSync } = await import('node:fs')
      const { resolve, dirname, join, sep } = await import('node:path')

      if (newName.includes('/') || newName.includes('\\') || newName.includes('..') || newName.includes(sep)) {
        throw new Error('文件名不能包含路径分隔符或 ".."')
      }

      const safePath = resolve(filePath)
      if (!isPathAllowed(safePath, normalizeFileAccessOptions(access))) {
        throw new Error('访问路径超出当前会话的授权范围')
      }

      const newPath = join(dirname(safePath), newName)
      renameSync(safePath, newPath)
      console.log(`[Agent 文件] 已重命名: ${safePath} → ${newPath}`)
    }
  )

  // 移动文件/目录到目标目录
  ipcMain.handle(
    AGENT_IPC_CHANNELS.MOVE_FILE,
    async (_, filePath: string, targetDir: string, access?: FileAccessOptions): Promise<void> => {
      const { resolve } = await import('node:path')

      const safePath = resolve(filePath)
      const safeTarget = resolve(targetDir)
      const options = normalizeFileAccessOptions(access)
      if (!isPathAllowed(safePath, options) || !isPathAllowed(safeTarget, options)) {
        throw new Error('访问路径超出当前会话的授权范围')
      }

      const newPath = movePathSafely(safePath, safeTarget)
      console.log(`[Agent 文件] 已移动: ${safePath} → ${newPath}`)
    }
  )

  // 列出附加目录内容
  ipcMain.handle(
    AGENT_IPC_CHANNELS.LIST_ATTACHED_DIRECTORY,
    async (_, dirPath: string, access?: FileAccessOptions | string[]): Promise<FileEntry[]> => {
      const { readdirSync, statSync } = await import('node:fs')
      const { resolve } = await import('node:path')

      const safePath = resolve(dirPath)
      const options = normalizeFileAccessOptions(access)
      if (!isPathAllowed(safePath, options)) {
        throw new Error('访问路径不在允许范围内')
      }
      const entries: FileEntry[] = []
      const items = readdirSync(safePath, { withFileTypes: true })

      for (const item of items) {
        if (HIDDEN_FS_ENTRIES.has(item.name)) continue
        const fullPath = resolve(safePath, item.name)
        const isDirectory = item.isDirectory()
        const size = isDirectory ? undefined : statSync(fullPath).size
        entries.push({
          name: item.name,
          path: fullPath,
          isDirectory,
          size,
        })
      }

      // 目录在前，文件在后；隐藏文件（.开头）排在同类末尾
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        const aHidden = a.name.startsWith('.')
        const bHidden = b.name.startsWith('.')
        if (aHidden !== bHidden) return aHidden ? 1 : -1
        return a.name.localeCompare(b.name)
      })

      return entries.slice(0, MAX_DIRECTORY_ENTRIES)
    }
  )

  // 读取附加目录文件内容为 base64（限制在已附加目录范围内，用于侧面板添加到聊天）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.READ_ATTACHED_FILE,
    async (_, filePath: string, sessionId?: string, workspaceSlug?: string): Promise<string> => {
      if (!filePath || typeof filePath !== 'string') {
        throw new Error('无效的文件路径')
      }

      const { resolve, sep } = await import('node:path')
      const { readFile, stat, realpath } = await import('node:fs/promises')

      // 使用 realpath 解析符号链接，防止 symlink 绕过路径检查
      const safePath = await realpath(resolve(filePath)).catch(() => {
        throw new Error(`文件不存在: ${filePath}`)
      })

      // 收集所有允许的路径：会话/工作区附加目录、附加文件 + 工作区文件目录
      const allowedDirs: string[] = []
      const allowedFiles: string[] = []

      if (sessionId) {
        const meta = getAgentSessionMeta(sessionId)
        if (meta?.attachedDirectories) {
          allowedDirs.push(...filterAttachedPaths(meta.attachedDirectories))
        }
        if (meta?.attachedFiles) {
          allowedFiles.push(...filterAttachedPaths(meta.attachedFiles))
        }
      }
      if (workspaceSlug) {
        allowedDirs.push(...getWorkspaceAttachedDirectories(workspaceSlug))
        allowedFiles.push(...getWorkspaceAttachedFiles(workspaceSlug))
        const workspace = getAgentWorkspaceBySlug(workspaceSlug)
        if (workspace) allowedDirs.push(...getAgentWorkspaceReadableRoots(workspace))
        else allowedDirs.push(getProjectFilesPath(workspaceSlug))
      }

      // 还允许访问 agent-workspaces 根目录下的文件（session 文件等）
      allowedDirs.push(getAgentWorkspacesDir())

      const resolvedAllowedDirs = await Promise.all(
        allowedDirs.map((dir) => realpath(resolve(dir)).catch(() => resolve(dir)))
      )
      const resolvedAllowedFiles = await Promise.all(
        allowedFiles.map((file) => realpath(resolve(file)).catch(() => resolve(file)))
      )
      const isAllowed = resolvedAllowedDirs.some((dir) => safePath.startsWith(dir + sep) || safePath === dir)
        || resolvedAllowedFiles.some((file) => safePath === file)
      if (!isAllowed) {
        throw new Error('访问路径不在允许范围内')
      }

      const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20 MB
      const fileStat = await stat(safePath).catch(() => null)
      if (!fileStat) {
        throw new Error(`文件不存在: ${filePath}`)
      }
      if (fileStat.size > MAX_FILE_SIZE) {
        throw new Error(`文件过大（${Math.round(fileStat.size / 1024 / 1024)}MB），最大支持 20MB`)
      }

      const buffer = await readFile(safePath)
      return buffer.toString('base64')
    }
  )

  // 在文件管理器中显示附加目录文件
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SHOW_ATTACHED_IN_FOLDER,
    async (_, filePath: string, access?: FileAccessOptions | string[]): Promise<void> => {
      const { resolve } = await import('node:path')
      const safePath = resolve(filePath)
      const options = normalizeFileAccessOptions(access)
      if (!isPathAllowed(safePath, options)) {
        console.warn('[IPC] show-attached-in-folder 拒绝越界路径:', safePath)
        return
      }
      shell.showItemInFolder(safePath)
    }
  )

  // 重命名附加目录文件/目录
  ipcMain.handle(
    AGENT_IPC_CHANNELS.RENAME_ATTACHED_FILE,
    async (_, filePath: string, newName: string, access?: FileAccessOptions | string[]): Promise<void> => {
      const { renameSync } = await import('node:fs')
      const { resolve, dirname, join, sep } = await import('node:path')

      if (newName.includes('/') || newName.includes('\\') || newName.includes('..') || newName.includes(sep)) {
        throw new Error('文件名不能包含路径分隔符或 ".."')
      }
      const safePath = resolve(filePath)
      const options = normalizeFileAccessOptions(access)
      if (!isPathAllowed(safePath, options)) {
        throw new Error('访问路径不在允许范围内')
      }
      const newPath = join(dirname(safePath), newName)
      renameSync(safePath, newPath)
      console.log(`[附加目录] 已重命名: ${safePath} → ${newPath}`)
    }
  )

  // 移动附加目录文件/目录
  ipcMain.handle(
    AGENT_IPC_CHANNELS.MOVE_ATTACHED_FILE,
    async (_, filePath: string, targetDir: string, access?: FileAccessOptions | string[]): Promise<void> => {
      const { resolve } = await import('node:path')

      const safePath = resolve(filePath)
      const safeTarget = resolve(targetDir)
      const options = normalizeFileAccessOptions(access)
      if (!isPathAllowed(safePath, options) || !isPathAllowed(safeTarget, options)) {
        throw new Error('访问路径不在允许范围内')
      }
      const newPath = movePathSafely(safePath, safeTarget)
      console.log(`[附加目录] 已移动: ${safePath} → ${newPath}`)
    }
  )

  // 检查路径类型（文件 or 目录），用于拖拽检测
  ipcMain.handle(
    AGENT_IPC_CHANNELS.CHECK_PATHS_TYPE,
    async (_, paths: string[]): Promise<{ directories: string[]; files: string[] }> => {
      const { statSync } = await import('node:fs')
      const directories: string[] = []
      const files: string[] = []
      for (const p of paths) {
        try {
          const stat = statSync(p)
          if (stat.isDirectory()) {
            directories.push(p)
          } else {
            files.push(p)
          }
        } catch {
          // 无法访问的路径忽略
        }
      }
      return { directories, files }
    }
  )

  // 搜索工作区文件（用于 @ 引用，递归扫描，支持附加目录）
  ipcMain.handle(
    AGENT_IPC_CHANNELS.SEARCH_WORKSPACE_FILES,
    (_, rootPath: string, query: string, limit = 20, additionalPaths?: string[], sessionPaths?: string[]) =>
      searchWorkspaceFiles(rootPath, query, limit, additionalPaths, sessionPaths),
  )
}
