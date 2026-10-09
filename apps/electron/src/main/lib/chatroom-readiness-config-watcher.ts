import { watch, type FSWatcher } from 'node:fs'
import { basename } from 'node:path'

export interface WatchChatRoomReadinessConfigOptions {
  directory: string
  onChanged(): void
  debounceMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
  watchDirectory?: (directory: string, listener: (event: string, filename: string | Buffer | null) => void) => FSWatcher
}

const READINESS_CONFIG_FILES = new Set(['channels.json', 'agent-workspaces.json'])

/** 监听主理人本地 readiness 配置；失败时做有界退避重建，不轮询配置文件。 */
export function watchChatRoomReadinessConfig(options: WatchChatRoomReadinessConfigOptions): () => void {
  const watchDirectory = options.watchDirectory ?? ((directory, listener) => watch(directory, listener))
  const retryBaseMs = Math.max(1, options.retryBaseMs ?? 1_000)
  const retryMaxMs = Math.max(retryBaseMs, options.retryMaxMs ?? 30_000)
  let watcher: FSWatcher | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let retryAttempt = 0
  let everAttached = false
  let disposed = false

  const refresh = () => {
    if (disposed) return
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined
      if (!disposed) {
        try { options.onChanged() } catch { /* 调用方诊断；监听器恢复不依赖其成功。 */ }
      }
    }, Math.max(0, options.debounceMs ?? 100))
    debounceTimer.unref?.()
  }

  const scheduleRetry = () => {
    if (disposed || retryTimer) return
    const delay = Math.min(retryBaseMs * 2 ** Math.min(retryAttempt, 8), retryMaxMs)
    retryAttempt++
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      attach()
    }, delay)
    retryTimer.unref?.()
  }

  const attach = () => {
    if (disposed || watcher) return
    let next: FSWatcher
    try {
      next = watchDirectory(options.directory, (_event, filename) => {
        const name = filename?.toString()
        if (!name || READINESS_CONFIG_FILES.has(basename(name))) refresh()
      })
    } catch {
      refresh()
      scheduleRetry()
      return
    }
    watcher = next
    next.on('error', () => {
      if (disposed || watcher !== next) return
      watcher = undefined
      next.close()
      refresh()
      scheduleRetry()
    })
    next.unref()
    if (everAttached) refresh()
    everAttached = true
  }

  attach()
  return () => {
    if (disposed) return
    disposed = true
    if (retryTimer) clearTimeout(retryTimer)
    if (debounceTimer) clearTimeout(debounceTimer)
    retryTimer = undefined
    debounceTimer = undefined
    const current = watcher
    watcher = undefined
    current?.close()
  }
}
