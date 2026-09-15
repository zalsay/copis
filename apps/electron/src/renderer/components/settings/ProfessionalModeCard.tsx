/**
 * ProfessionalModeCard - 专业模式（Codex Harness）配置卡片
 *
 * 位于设置 -> 模型管理。包含开启/关闭开关、Codex 官方图标、状态显示与模型范围限制说明。
 */

import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { AlertCircle, AlertTriangle, CheckCircle2, Download, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { CodexLogoIcon } from '@/components/ui/codex-logo-icon'
import { COPIS_OFFICIAL_URL } from '../functional-modules/functional-module-startup-ui'
import {
  codexAppServerStatusAtom,
  professionalModeAtom,
  toggleProfessionalModeAtom,
} from '@/atoms/professional-mode-atoms'
import type { CodexCliStatus } from '@/types/settings'
import { cn } from '@/lib/utils'

interface ProfessionalModeCardProps {
  onNotice?: (message: string) => void
  className?: string
}

export function ProfessionalModeCard({ onNotice, className }: ProfessionalModeCardProps): React.ReactElement {
  const isProfessional = useAtomValue(professionalModeAtom)
  const status = useAtomValue(codexAppServerStatusAtom)
  const [, toggleProfessionalMode] = useAtom(toggleProfessionalModeAtom)
  const [toggling, setToggling] = React.useState(false)

  // CLI 检测与安装状态
  const [cliStatus, setCliStatus] = React.useState<CodexCliStatus | null>(null)
  const [checkingCli, setCheckingCli] = React.useState(true)
  const [installing, setInstalling] = React.useState(false)
  const [installProgressText, setInstallProgressText] = React.useState<string | null>(null)
  const [installPercent, setInstallPercent] = React.useState(0)
  const [installError, setInstallError] = React.useState<string | null>(null)

  const refreshCliStatus = React.useCallback(async (): Promise<CodexCliStatus | null> => {
    try {
      setCheckingCli(true)
      const res = await window.electronAPI.checkCodexCli?.()
      setCliStatus(res ?? null)
      return res ?? null
    } catch (err) {
      console.error('[ProfessionalModeCard] 检测 codex-cli 失败:', err)
      return null
    } finally {
      setCheckingCli(false)
    }
  }, [])

  React.useEffect(() => {
    void refreshCliStatus()
  }, [refreshCliStatus])

  const handleToggle = async (checked: boolean): Promise<void> => {
    if (checked && (!cliStatus?.available || !cliStatus?.canStartAppServer)) {
      onNotice?.('未检测到专业模式核心模块，请先点击下方按钮下载安装')
      return
    }

    setToggling(true)
    try {
      await toggleProfessionalMode(checked)
      onNotice?.(checked ? '专业模式已开启，后台服务已启动' : '专业模式已关闭')
    } catch (error) {
      const msg = error instanceof Error ? error.message : '切换失败'
      onNotice?.(`专业模式切换失败: ${msg}`)
    } finally {
      setToggling(false)
    }
  }

  const handleInstallModule = async (): Promise<void> => {
    if (!window.electronAPI?.installFunctionalModule) {
      setInstallError('客户端暂不支持在线安装模块')
      return
    }

    setInstalling(true)
    setInstallError(null)
    setInstallProgressText('正在准备下载专业模式模块...')
    setInstallPercent(0)

    const unsubscribe = window.electronAPI.onFunctionalModuleProgress?.((payload) => {
      if (payload.name === 'codex-cli') {
        const pct = Math.round((payload.progress ?? 0) * 100)
        setInstallPercent(pct)
        if (payload.phase === 'manifest') {
          setInstallProgressText('正在获取组件清单...')
        } else if (payload.phase === 'download') {
          setInstallProgressText(`正在下载专业模式模块 (${pct}%)...`)
        } else if (payload.phase === 'verify') {
          setInstallProgressText('正在验证模块完整性...')
        } else if (payload.phase === 'install' || payload.phase === 'activate') {
          setInstallProgressText('正在解压并安装组件...')
        } else if (payload.phase === 'done') {
          setInstallProgressText('模块安装完成！')
        }
      }
    })

    try {
      const res = await window.electronAPI.installFunctionalModule({ name: 'codex-cli' })
      if (res.installed) {
        setInstallProgressText('安装完成，正在复验服务...')
        const nextCli = await refreshCliStatus()
        if (nextCli?.canStartAppServer) {
          onNotice?.('专业模式模块安装成功！正在自动启动专业模式...')
          await handleToggle(true)
        } else {
          onNotice?.('专业模式模块已就绪，请点击开关开启')
        }
      } else {
        setInstallError(res.error || '模块安装未完成，请重试')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setInstallError(`下载安装失败: ${msg}`)
    } finally {
      unsubscribe?.()
      setInstalling(false)
    }
  }

  const isCliReady = cliStatus?.available === true && cliStatus?.canStartAppServer === true

  return (
    <div
      className={cn(
        'rounded-xl border border-border/80 bg-card p-5 shadow-sm transition-colors',
        isProfessional && 'border-primary/30 bg-primary/[0.02]',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3.5">
          <div className="mt-0.5 grid size-10 place-items-center rounded-lg border border-border/60 bg-muted/60 p-2 shadow-xs">
            <CodexLogoIcon size={24} />
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-foreground tracking-tight">专业模式</h3>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              启用专业模式执行内核，提供更深度的代码自主规划、执行反思与高效上下文压缩能力。
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 pt-1">
          {toggling && <Loader2 aria-hidden="true" className="size-4 animate-spin text-muted-foreground" />}
          <Switch
            checked={isProfessional}
            disabled={toggling || (!isCliReady && !isProfessional)}
            onCheckedChange={handleToggle}
            aria-label="切换专业模式"
          />
        </div>
      </div>

      {/* 未安装或无法启动服务时的直接提示与一键下载安装卡片 */}
      {!checkingCli && !isCliReady && (
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-3 dark:border-amber-500/20 dark:bg-amber-500/10">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
              <div className="space-y-1">
                <div className="text-xs font-semibold text-foreground">
                  未安装专业模式核心模块
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  专业模式依赖专用的后台运行服务。当前系统尚未安装该模块或无法启动服务，请点击右侧按钮一键下载并安装。
                </p>
              </div>
            </div>
            {!installing && (
              <Button
                size="sm"
                className="h-8 text-xs shrink-0 gap-1.5 shadow-sm"
                onClick={handleInstallModule}
              >
                <Download className="size-3.5" />
                下载并安装模块
              </Button>
            )}
          </div>

          {installing && (
            <div className="space-y-1.5 pt-1">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Loader2 className="size-3 animate-spin text-primary" />
                  {installProgressText || '正在安装模块...'}
                </span>
                <span className="font-mono">{installPercent}%</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${installPercent}%` }}
                />
              </div>
            </div>
          )}

          {installError && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-destructive">
              <div className="flex items-center gap-1.5">
                <AlertCircle className="size-3.5 shrink-0" />
                <span>{installError}</span>
              </div>
              {installError.includes('版本过低') && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 text-[11px] px-2 text-foreground"
                  onClick={() => {
                    void window.electronAPI?.openExternal?.(COPIS_OFFICIAL_URL)?.catch?.((error: unknown) => {
                      console.error('[专业模式] 打开官网失败:', error)
                    })
                  }}
                >
                  <ExternalLink className="mr-1 size-3" />
                  打开官网
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="mt-4 pt-3.5 border-t border-border/60 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 text-xs">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">服务状态:</span>
            {status.running ? (
              <span className="inline-flex items-center gap-1.5 font-medium text-emerald-600 dark:text-emerald-400">
                <span className="relative flex size-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
                </span>
                运行中 {status.port ? `(127.0.0.1:${status.port})` : ''}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <span className="size-2 rounded-full bg-muted-foreground/40" />
                未启动
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">核心组件:</span>
            {checkingCli ? (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                检测中...
              </span>
            ) : isCliReady ? (
              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium">
                <CheckCircle2 className="size-3.5" />
                已就绪 {cliStatus?.version ? `(v${cliStatus.version})` : ''}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400 font-medium">
                <AlertCircle className="size-3.5" />
                未就绪
              </span>
            )}
            <button
              type="button"
              disabled={checkingCli || installing}
              onClick={() => void refreshCliStatus()}
              className="text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded cursor-pointer"
              title="重新检测组件"
            >
              <RefreshCw className={cn('size-3', checkingCli && 'animate-spin')} />
            </button>
          </div>

          {status.error && (
            <span className="inline-flex items-center gap-1 text-destructive font-medium">
              <AlertCircle className="size-3.5" />
              {status.error}
            </span>
          )}
        </div>

        <div className="inline-flex items-center gap-1.5 rounded-md bg-muted/60 px-2.5 py-1 text-[11px] text-muted-foreground">
          <CheckCircle2 className="size-3 text-primary shrink-0" />
          <span>仅支持 Copis 默认模型与自定义模型</span>
        </div>
      </div>
    </div>
  )
}
