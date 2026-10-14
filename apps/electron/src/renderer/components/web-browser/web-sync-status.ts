import type { WebSyncState } from '@copis/shared'

export type WebSyncFeedback = {
  kind: 'success' | 'error' | 'info'
  message: string
}

export interface WebSyncStatusPresentation {
  icon: 'cloud' | 'offline' | 'pending' | 'syncing' | 'error'
  label: string
  colorClassName: string
}

export interface WebSyncRequestToken {
  requestId: number
  accountId: string | null
}

export function isWebSyncRequestPendingForAccount(
  request: WebSyncRequestToken | null,
  accountId: string | null,
): boolean {
  return request?.accountId === accountId
}

export function isCurrentWebSyncRequest(
  request: WebSyncRequestToken,
  pendingRequest: WebSyncRequestToken | null,
): boolean {
  return pendingRequest?.requestId === request.requestId
}

export function getWebSyncStatusPresentation(state: WebSyncState): WebSyncStatusPresentation {
  switch (state.status) {
    case 'signed-out':
      return { icon: 'offline', label: '未登录，网页数据不会同步', colorClassName: 'text-muted-foreground' }
    case 'pending':
      return { icon: 'pending', label: '有网页数据待同步', colorClassName: 'text-amber-500' }
    case 'syncing':
      return { icon: 'syncing', label: '正在同步网页数据…', colorClassName: 'text-primary' }
    case 'synced':
      return { icon: 'cloud', label: '网页数据已同步', colorClassName: 'text-emerald-600 dark:text-emerald-400' }
    case 'error':
      return {
        icon: 'error',
        label: state.lastSyncError ? `网页同步失败：${state.lastSyncError}` : '网页同步失败，点击重试',
        colorClassName: 'text-destructive',
      }
    case 'idle':
    default:
      return { icon: 'cloud', label: '网页同步状态未知，点击同步', colorClassName: 'text-muted-foreground' }
  }
}

/** 只有后端明确报告 synced 才能给出成功反馈。 */
export function getWebSyncFeedback(state: WebSyncState): WebSyncFeedback {
  switch (state.status) {
    case 'synced':
      return { kind: 'success', message: '网页数据已与云端同步' }
    case 'error':
      return { kind: 'error', message: state.lastSyncError || '网页数据同步失败' }
    case 'signed-out':
      return { kind: 'info', message: '请先登录账号后再同步网页数据' }
    case 'pending':
      return { kind: 'info', message: '仍有网页数据待同步，请稍后重试' }
    case 'syncing':
      return { kind: 'info', message: '网页数据仍在同步中' }
    case 'idle':
    default:
      return { kind: 'info', message: '网页同步状态尚未确认，请稍后查看' }
  }
}
