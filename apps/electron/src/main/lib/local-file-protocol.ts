/**
 * Token-gated local file protocol support for inline previews.
 *
 * The renderer never receives raw copis-file:// absolute paths. Main process
 * code registers an already-authorized file or directory and gets back an
 * opaque URL that the protocol handler can resolve.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { net } from 'electron'
import { createLocalMediaResponse } from './local-media-response'

type RegisteredEntry = {
  root: string
  isDirectory: boolean
  createdAt: number
  ownerId?: number
}

const registeredEntries = new Map<string, RegisteredEntry>()
const ENTRY_TTL_MS = 60 * 60 * 1000
const MAX_ENTRIES = 500

function pruneEntries(): void {
  const now = Date.now()
  for (const [token, entry] of registeredEntries) {
    if (now - entry.createdAt > ENTRY_TTL_MS) {
      registeredEntries.delete(token)
    }
  }

  while (registeredEntries.size > MAX_ENTRIES) {
    const oldest = registeredEntries.keys().next().value
    if (!oldest) break
    registeredEntries.delete(oldest)
  }
}

function realpathExisting(path: string): string {
  const resolved = realpathSync(resolve(path))
  if (!existsSync(resolved)) {
    throw new Error(`文件不存在: ${path}`)
  }
  return resolved
}

function isInsideDirectory(target: string, root: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
}

function registerEntry(path: string, isDirectory: boolean, ownerId?: number): string {
  pruneEntries()
  const root = realpathExisting(path)
  const st = statSync(root)
  if (isDirectory && !st.isDirectory()) {
    throw new Error(`不是目录: ${path}`)
  }
  if (!isDirectory && !st.isFile()) {
    throw new Error(`不是文件: ${path}`)
  }

  const token = randomUUID()
  registeredEntries.set(token, { root, isDirectory, createdAt: Date.now(), ownerId })
  return `copis-file://${token}`
}

export function registerCopisFilePath(path: string, ownerId?: number): string {
  return registerEntry(path, false, ownerId)
}

export function registerCopisDirectoryPath(path: string): string {
  return registerEntry(path, true)
}

/** 只撤销同一 WebContents 发放的单文件租约，不影响其他页面的预览。 */
export function revokeCopisFileUrl(value: string, ownerId: number): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'copis-file:' || (url.pathname !== '' && url.pathname !== '/')) return false
    if (registeredEntries.get(url.hostname)?.ownerId !== ownerId) return false
    return registeredEntries.delete(url.hostname)
  } catch { return false }
}

/** 视图销毁时兜底清理，避免依赖 renderer 能否发出最后一次 IPC。 */
export function revokeCopisFilesForOwner(ownerId: number): number {
  let count = 0
  for (const [token, entry] of registeredEntries) {
    if (entry.ownerId === ownerId) { registeredEntries.delete(token); count += 1 }
  }
  return count
}

export async function handleCopisFileRequest(request: Request): Promise<Response> {
  pruneEntries()
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return new Response('Bad Request', { status: 400 })
  }

  const token = url.hostname
  const entry = registeredEntries.get(token)
  if (!entry) {
    return new Response('Not Found', { status: 404 })
  }

  let target = entry.root
  if (entry.isDirectory) {
    let relativePath: string
    try {
      relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    } catch {
      return new Response('Bad Request', { status: 400 })
    }
    try {
      target = realpathSync(resolve(entry.root, relativePath))
    } catch {
      return new Response('Not Found', { status: 404 })
    }
    if (!isInsideDirectory(target, entry.root)) {
      return new Response('Forbidden', { status: 403 })
    }
  } else if (url.pathname && url.pathname !== '/') {
    return new Response('Not Found', { status: 404 })
  }

  // 文件租约也必须重查路径，禁止注册后替换为越界符号链接。
  if (!entry.isDirectory) {
    try {
      if (realpathSync(target) !== entry.root) return new Response('Forbidden', { status: 403 })
    } catch { return new Response('Not Found', { status: 404 }) }
  }
  const media = await createLocalMediaResponse(request, target)
  return media ?? net.fetch(pathToFileURL(target).toString())
}
