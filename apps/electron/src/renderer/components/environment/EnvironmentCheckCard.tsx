/**
 * 环境检测卡片组件
 *
 * 显示单个环境项（Shell / Node.js 等）的检测结果，
 * 缺失时通过系统浏览器打开官方下载页面。
 */

import * as React from 'react'
import { CheckCircle2, XCircle, AlertCircle, Loader2, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'

type CheckStatus = 'checking' | 'success' | 'warning' | 'error'

type CardAction =
  | { type: 'none' }
  | { type: 'openExternal'; url: string; label?: string }

interface EnvironmentCheckCardProps {
  /** 环境项名称（如 "Shell 环境"、"Node.js"） */
  name: string
  /** 检测状态 */
  status: CheckStatus
  /** 版本号 */
  version?: string
  /** 要求说明 */
  requirement: string
  /** 状态描述（覆盖默认文案） */
  statusText?: string
  /** 操作类型 */
  action: CardAction
}

export function EnvironmentCheckCard({
  name,
  status,
  version,
  requirement,
  statusText,
  action,
}: EnvironmentCheckCardProps): React.ReactElement {
  const StatusIcon = {
    checking: Loader2,
    success: CheckCircle2,
    warning: AlertCircle,
    error: XCircle,
  }[status]

  const iconColor = {
    checking: 'text-muted-foreground',
    success: 'text-green-600 dark:text-green-500',
    warning: 'text-yellow-600 dark:text-yellow-500',
    error: 'text-red-600 dark:text-red-500',
  }[status]

  const statusTextDefault = {
    checking: '检测中...',
    success: version ? `v${version} (已安装)` : '已安装',
    warning: version ? `v${version} (建议升级)` : '版本过低',
    error: '未安装',
  }[status]

  return (
    <div className="flex items-start gap-3 rounded-lg bg-card p-3 shadow-sm transition-shadow hover:shadow-md">
      <div className="flex-shrink-0">
        <StatusIcon
          className={`h-4 w-4 ${iconColor} ${status === 'checking' ? 'animate-spin' : ''}`}
        />
      </div>

      <div className="flex-1 space-y-1.5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h4 className="text-sm font-medium">{name}</h4>
            <p className="text-xs text-muted-foreground">{statusText || statusTextDefault}</p>
          </div>
        </div>

        <p className="text-[11px] text-muted-foreground">{requirement}</p>

        {(status === 'error' || status === 'warning') && action.type !== 'none' && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.electronAPI.openExternal(action.url)}
            className="mt-1.5 h-7 text-xs"
          >
            <ExternalLink className="mr-1.5 h-3 w-3" />
            {action.label ?? `下载 ${name}`}
          </Button>
        )}
      </div>
    </div>
  )
}
