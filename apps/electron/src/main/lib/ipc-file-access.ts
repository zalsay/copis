import { existsSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizePathForCompare, type FileAccessOptions } from '@copis/shared'
import { getAgentWorkspacesDir, getAttachmentsDir } from './config-paths'
import { getAgentSessionMeta } from './agent-session-manager'
import {
  getAgentWorkspace,
  getAgentWorkspaceBySlug,
  getAgentWorkspaceReadableRoots,
  getProjectFilesPath,
  getWorkspaceAttachedDirectories,
  getWorkspaceAttachedFiles,
  getWorktreeRepos,
} from './agent-workspace-manager'
import { filterAttachedPaths } from './attached-paths'
import { getMainRepoRoot } from './git-diff-service'
import { isPathWithinAuthorizedRoots, realpathOrResolve } from './file-access-policy'

/**
 * 检查路径是否在允许的目录范围内（解析 symlink）
 *
 * extraAllowedPaths 来自 renderer 的 basePaths（用户通过 UI 附加的目录），
 * 虽然 renderer 不可信，但附加目录功能本身就允许用户授权 workspaces 外的路径访问。
 * 攻击者需要先控制 renderer 才能伪造 basePaths，此时已有更大的攻击面。
 */
function getAuthorizedRoots(options?: FileAccessOptions): string[] {
  const home = homedir()
  const roots: string[] = [
    getAgentWorkspacesDir(),
    getAttachmentsDir(),
    join(home, '.copis', 'attachments'),
    join(home, '.copis-dev', 'attachments'),
    join(tmpdir(), 'copis-preview'),
  ]

  const workspaceSlugs = new Set<string>()

  if (options?.sessionId) {
    const meta = getAgentSessionMeta(options.sessionId)
    if (meta?.attachedDirectories) {
      roots.push(...filterAttachedPaths(meta.attachedDirectories))
    }
    if (meta?.attachedFiles) {
      roots.push(...filterAttachedPaths(meta.attachedFiles))
    }
    if (meta?.workspaceId) {
      const workspace = getAgentWorkspace(meta.workspaceId)
      if (workspace?.slug) workspaceSlugs.add(workspace.slug)
    }
  }

  if (options?.workspaceSlug) {
    workspaceSlugs.add(options.workspaceSlug)
  }

  for (const slug of workspaceSlugs) {
    const workspace = getAgentWorkspaceBySlug(slug)
    if (workspace) roots.push(...getAgentWorkspaceReadableRoots(workspace))
    else roots.push(getProjectFilesPath(slug))
    roots.push(...getWorkspaceAttachedDirectories(slug))
    roots.push(...getWorkspaceAttachedFiles(slug))
  }

  return roots
}

export function isPathAllowed(filePath: string, options?: FileAccessOptions): boolean {
  return isPathWithinAuthorizedRoots(filePath, getAuthorizedRoots(options))
}

export function normalizeFileAccessOptions(value?: FileAccessOptions | string[]): FileAccessOptions | undefined {
  if (!value || Array.isArray(value) || typeof value !== 'object') return undefined
  return {
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
    workspaceSlug: typeof value.workspaceSlug === 'string' ? value.workspaceSlug : undefined,
    candidateBasePaths: Array.isArray(value.candidateBasePaths)
      ? value.candidateBasePaths.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : undefined,
  }
}

function getWorkspaceSlugsForAccess(options?: FileAccessOptions): string[] {
  const workspaceSlugs = new Set<string>()
  if (options?.sessionId) {
    const meta = getAgentSessionMeta(options.sessionId)
    if (meta?.workspaceId) {
      const workspace = getAgentWorkspace(meta.workspaceId)
      if (workspace?.slug) workspaceSlugs.add(workspace.slug)
    }
  }
  if (options?.workspaceSlug) {
    workspaceSlugs.add(options.workspaceSlug)
  }
  return Array.from(workspaceSlugs)
}

export function getAllowedCandidateBasePaths(options?: FileAccessOptions): string[] | undefined {
  const allowed = options?.candidateBasePaths?.filter((p) => isPathAllowed(p, options)) ?? []
  return allowed.length > 0 ? allowed : undefined
}

export function getPreviewCandidateBasePaths(options?: FileAccessOptions): string[] | undefined {
  const bases = options?.candidateBasePaths?.filter((p) => typeof p === 'string' && p.length > 0) ?? []
  return bases.length > 0 ? bases : undefined
}

async function getAccessRootMainRepo(root: string): Promise<string | null> {
  if (!existsSync(root)) return null
  let probePath = root
  try {
    const stats = statSync(probePath)
    if (stats.isFile()) probePath = dirname(probePath)
  } catch {
    return null
  }
  return getMainRepoRoot(probePath)
}

export function ensurePathAllowed(filePath: string, options?: FileAccessOptions): boolean {
  if (isPathAllowed(filePath, options)) return true
  console.warn('[IPC] 拒绝越界路径:', filePath)
  return false
}

/**
 * 在 ensurePathAllowed 基础上，额外放行「已授权仓库的 worktree」。
 *
 * worktree 常被放在主仓库之外（如 ~/copis-dev/worktrees/xxx），其路径不在任何
 * 授权根下，会被 ensurePathAllowed 拒绝。但只要它回溯到的主仓库已被授权，就应放行。
 * 用 git 自身背书（--git-common-dir），避免粗暴跳过安全检查。
 */
export async function ensurePathAllowedWithWorktree(filePath: string, options?: FileAccessOptions): Promise<boolean> {
  if (isPathAllowed(filePath, options)) return true
  const mainRepo = await getMainRepoRoot(filePath)
  if (mainRepo && isPathAllowed(mainRepo, options)) return true
  if (mainRepo) {
    const targetMainRepo = normalizePathForCompare(realpathOrResolve(mainRepo))
    for (const root of getAuthorizedRoots(options)) {
      const authorizedMainRepo = await getAccessRootMainRepo(root)
      if (!authorizedMainRepo) continue
      const authorizedRoot = normalizePathForCompare(realpathOrResolve(authorizedMainRepo))
      if (authorizedRoot === targetMainRepo) return true
    }
    for (const workspaceSlug of getWorkspaceSlugsForAccess(options)) {
      let repos: import('@copis/shared').WorkspaceWorktreeRepo[]
      try {
        repos = await getWorktreeRepos(workspaceSlug)
      } catch {
        continue
      }
      for (const repo of repos) {
        const repoMain = await getMainRepoRoot(repo.repoPath)
        const repoRoot = normalizePathForCompare(realpathOrResolve(repoMain ?? repo.repoPath))
        if (repoRoot === targetMainRepo) return true
      }
    }
  }
  console.warn('[IPC] 拒绝越界路径:', filePath)
  return false
}
