import * as React from 'react'
import { AlertCircle, Cloud, CloudOff, CloudUpload, LoaderCircle } from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { webSyncStateAtom, triggerWebSyncNowAtom } from '@/atoms/web-sync'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  getWebSyncFeedback,
  getWebSyncStatusPresentation,
  isCurrentWebSyncRequest,
  isWebSyncRequestPendingForAccount,
  type WebSyncRequestToken,
} from './web-sync-status'

interface WebSyncStatusButtonProps {
  compact?: boolean
}

export function WebSyncStatusButton({ compact = false }: WebSyncStatusButtonProps): React.ReactElement {
  const syncState = useAtomValue(webSyncStateAtom)
  const triggerSync = useSetAtom(triggerWebSyncNowAtom)
  const [pendingRequest, setPendingRequest] = React.useState<WebSyncRequestToken | null>(null)
  const pendingRequestRef = React.useRef<WebSyncRequestToken | null>(null)
  const nextRequestIdRef = React.useRef(0)
  const presentation = getWebSyncStatusPresentation(syncState)
  const requestPending = isWebSyncRequestPendingForAccount(pendingRequest, syncState.accountId)
  const disabled = syncState.status === 'syncing' || requestPending

  React.useEffect(() => {
    // A → B → A 也属于新账号会话，不能复用第一次 A 请求留下的本地锁。
    pendingRequestRef.current = null
    setPendingRequest(null)
  }, [syncState.accountId])

  const handleSync = React.useCallback(async (): Promise<void> => {
    if (
      isWebSyncRequestPendingForAccount(pendingRequestRef.current, syncState.accountId) ||
      syncState.status === 'syncing'
    ) return
    if (syncState.status === 'signed-out') {
      toast.info('请先登录账号后再同步网页数据')
      return
    }

    const request = { requestId: ++nextRequestIdRef.current, accountId: syncState.accountId }
    pendingRequestRef.current = request
    setPendingRequest(request)
    try {
      const result = await triggerSync()
      if (!result) {
        toast.info('账号已切换，本次同步结果已忽略')
        return
      }
      const feedback = getWebSyncFeedback(result)
      if (feedback.kind === 'success') toast.success(feedback.message)
      else if (feedback.kind === 'error') toast.error(feedback.message)
      else toast.info(feedback.message)
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : '网页数据同步失败')
    } finally {
      if (isCurrentWebSyncRequest(request, pendingRequestRef.current)) {
        pendingRequestRef.current = null
        setPendingRequest(null)
      }
    }
  }, [syncState.accountId, syncState.status, triggerSync])

  const iconClassName = compact ? 'size-3.5' : 'size-4'
  const icon = requestPending || syncState.status === 'syncing'
    ? <LoaderCircle className={cn(iconClassName, 'animate-spin', presentation.colorClassName)} />
    : presentation.icon === 'error'
      ? <AlertCircle className={cn(iconClassName, presentation.colorClassName)} />
      : presentation.icon === 'pending'
        ? <CloudUpload className={cn(iconClassName, presentation.colorClassName)} />
        : presentation.icon === 'offline'
          ? <CloudOff className={cn(iconClassName, presentation.colorClassName)} />
        : <Cloud className={cn(iconClassName, presentation.colorClassName)} />

  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={presentation.label}
      title={presentation.label}
      disabled={disabled}
      className={cn(
        'shrink-0 rounded-sm hover:bg-muted/60',
        compact ? 'size-6' : 'size-7',
      )}
      onClick={() => void handleSync()}
    >
      {icon}
    </Button>
  )

  // 独立收藏夹是自适应原生窗口，Portal Tooltip 可能超出窗口边界；title 足够提供说明。
  if (compact) return button

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={8} avoidCollisions={false} className="text-xs">
        {presentation.label}
        {syncState.status !== 'signed-out' && syncState.status !== 'syncing' ? '；点击立即同步或重试' : ''}
      </TooltipContent>
    </Tooltip>
  )
}
