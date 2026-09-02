import type { FileSearchResult } from '@copis/shared'
import { readdirSync, statSync } from 'node:fs'
import { basename, relative, resolve } from 'node:path'

const ignoredDirectories = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__', '.venv', 'build', '.cache', '.copis'])
const ignoredFiles = new Set(['.DS_Store', '.Spotlight-V100', '.Trashes', 'Thumbs.db', 'desktop.ini'])
const BROWSE_LIMIT_PER_GROUP = 2000
const BROWSE_TOTAL_CAP = 3000

type Entry = { name: string; path: string; type: 'file' | 'dir'; source: 'session' | 'workspace' }

export async function searchWorkspaceFiles(
  rootPath: string,
  query: string,
  limit = 20,
  additionalPaths?: string[],
  sessionPaths?: string[],
): Promise<FileSearchResult> {
  const safeRoot = resolve(rootPath)
  const rootEntries: Entry[] = []
  const workspaceEntries: Entry[] = []

  function scan(
    dir: string,
    depth: number,
    baseRoot: string,
    target: Entry[],
    useAbsPath: boolean,
    source: 'session' | 'workspace',
  ): void {
    if (depth > 10 || target.length >= BROWSE_LIMIT_PER_GROUP) return
    try {
      const items = readdirSync(dir, { withFileTypes: true })
      for (const item of items) {
        if (target.length >= BROWSE_LIMIT_PER_GROUP) break
        if (ignoredFiles.has(item.name)) continue
        if ((item.isDirectory() || item.isSymbolicLink()) && ignoredDirectories.has(item.name)) continue

        const fullPath = resolve(dir, item.name)
        const entryPath = useAbsPath ? fullPath : relative(baseRoot, fullPath)
        target.push({
          name: item.name,
          path: entryPath,
          type: item.isDirectory() ? 'dir' : 'file',
          source,
        })

        if (item.isDirectory()) {
          scan(fullPath, depth + 1, baseRoot, target, useAbsPath, source)
        }
      }
    } catch {
      // 忽略无权限的目录
    }
  }

  function addAttachedPath(pathValue: string, target: Entry[], source: 'session' | 'workspace'): void {
    try {
      const attachedPath = resolve(pathValue)
      const name = basename(attachedPath)
      if (ignoredFiles.has(name)) return

      const stats = statSync(attachedPath)
      if (stats.isFile()) {
        target.push({
          name,
          path: attachedPath,
          type: 'file',
          source,
        })
        return
      }

      if (!stats.isDirectory()) return
      if (ignoredDirectories.has(name)) return

      target.push({
        name: name === 'workspace-files' ? '工作区' : name,
        path: attachedPath,
        type: 'dir',
        source,
      })
      scan(attachedPath, 0, attachedPath, target, true, source)
    } catch {
      // 忽略不存在或无权限的附加路径
    }
  }

  scan(safeRoot, 0, safeRoot, rootEntries, false, 'session')

  if (sessionPaths && sessionPaths.length > 0) {
    for (const path of sessionPaths) {
      addAttachedPath(path, rootEntries, 'session')
    }
  }

  if (additionalPaths && additionalPaths.length > 0) {
    for (const path of additionalPaths) {
      addAttachedPath(path, workspaceEntries, 'workspace')
    }
  }

  function sortEntries(entries: Entry[], normalizedQuery: string): void {
    entries.sort((a, b) => {
      const aStartsWith = a.name.toLowerCase().startsWith(normalizedQuery) ? 0 : 1
      const bStartsWith = b.name.toLowerCase().startsWith(normalizedQuery) ? 0 : 1
      if (aStartsWith !== bStartsWith) return aStartsWith - bStartsWith
      if (a.type === 'dir' && b.type !== 'dir') return -1
      if (a.type !== 'dir' && b.type === 'dir') return 1
      const byPathLength = a.path.length - b.path.length
      if (byPathLength !== 0) return byPathLength
      const byName = a.name.localeCompare(b.name)
      if (byName !== 0) return byName
      return a.path.localeCompare(b.path)
    })
  }

  function matchEntries(entries: Entry[], normalizedQuery: string): Entry[] {
    return entries.filter((entry) => {
      const nameLower = entry.name.toLowerCase()
      const pathLower = entry.path.toLowerCase()
      if (nameLower.startsWith(normalizedQuery)) return true
      if (nameLower.includes(normalizedQuery) || pathLower.includes(normalizedQuery)) return true
      let queryIndex = 0
      for (let index = 0; index < nameLower.length && queryIndex < normalizedQuery.length; index++) {
        if (nameLower[index] === normalizedQuery[queryIndex]) queryIndex++
      }
      return queryIndex === normalizedQuery.length
    })
  }

  function sortDirectoriesFirst(entries: Entry[]): void {
    entries.sort((a, b) => {
      if (a.type === 'dir' && b.type !== 'dir') return -1
      if (a.type !== 'dir' && b.type === 'dir') return 1
      return a.path.length - b.path.length || a.name.localeCompare(b.name)
    })
  }

  const normalizedQuery = query.toLowerCase()
  if (!normalizedQuery) {
    sortDirectoriesFirst(rootEntries)
    sortDirectoriesFirst(workspaceEntries)
    const maxPerGroup = Math.max(limit, BROWSE_LIMIT_PER_GROUP)
    const sessionEntries = rootEntries.slice(0, maxPerGroup)
    const workspaceResults = workspaceEntries.slice(0, maxPerGroup)
    const entries = [...sessionEntries, ...workspaceResults]
    sortEntries(entries, '')
    return {
      entries: entries.slice(0, BROWSE_TOTAL_CAP),
      total: rootEntries.length + workspaceEntries.length,
      sessionEntries,
      workspaceEntries: workspaceResults,
    }
  }

  const sessionMatched = matchEntries(rootEntries, normalizedQuery)
  const workspaceMatched = matchEntries(workspaceEntries, normalizedQuery)
  sortEntries(sessionMatched, normalizedQuery)
  sortEntries(workspaceMatched, normalizedQuery)

  const totalMatched = sessionMatched.length + workspaceMatched.length
  let sessionEntries: Entry[]
  let workspaceResults: Entry[]
  if (totalMatched <= limit) {
    sessionEntries = sessionMatched
    workspaceResults = workspaceMatched
  } else {
    const sessionQuota = Math.max(
      sessionMatched.length > 0 ? 1 : 0,
      Math.round(limit * sessionMatched.length / totalMatched),
    )
    const workspaceQuota = Math.max(
      workspaceMatched.length > 0 ? 1 : 0,
      limit - sessionQuota,
    )
    sessionEntries = sessionMatched.slice(0, sessionQuota)
    workspaceResults = workspaceMatched.slice(0, workspaceQuota)
  }

  const entries = [...sessionEntries, ...workspaceResults]
  sortEntries(entries, normalizedQuery)
  return {
    entries,
    total: totalMatched,
    sessionEntries,
    workspaceEntries: workspaceResults,
  }
}
